import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { FencedLease, LeaseHeldError, type FenceEvent, type FencedOwner, type LeaseAttachment } from 'distributed-core/cluster/leases';
import type { WsAuthContext, WsHandlerHandle } from '../server-ws/types';
import { LocalRealtimeRouter, type RealtimeRouter, type ChannelAuthorize, type ClientMessageFilter, type FeaturePlugin, type RouterLogger } from './router';
import { channelDeniedFrame, type ChannelAccessKind, type ChannelAccessOpts } from '../server-ws/channelAccess';
import type { CallCrossNodePubSub } from '../call/types';
import { acceptsOriginPublishProof, createAuthorityScope, scopeFor, type AuthorityScope } from '../server-ws/authorityScope';

/** Connected command/publish and dedicated subscriber clients. The host owns
 * connection setup, TLS/credentials, reconnect policy and final client close.
 * Ports deliberately avoid a mandatory Redis client dependency. */
export interface RealtimeClusterRedis {
    command(...args: string[]): Promise<unknown>;
    publish(topic: string, payload: string): Promise<unknown>;
    subscribe(topic: string, receive: (payload: string) => void): Promise<() => Promise<void> | void>;
    /** Notify an established connection loss, including a subscriber/publisher
     * loss while command leases still renew. Reconnect cannot revive that
     * router incarnation. The returned function removes the listener. */
    onUnavailable?(handler: () => void): () => void;
}
/** Namespace-scoped invalidation events from trusted application replicas.
 * Payloads are hints: handlers must reread their durable authority. Delivery
 * is best effort and duplicate-suppressed; there is no replay or receipt. */
export interface RealtimePeerEvents {
    publish(topic: string, payload: string): Promise<void>;
    subscribe(topic: string, handler: (payload: string) => void | Promise<void>): () => void;
}
/** Structural view of distributed-core's `LeaseGroup` (any copy of it). The
 * router adds its ownership lease on start; the first member to fence
 * retires (fences and releases) every sibling. */
export interface RealtimeLeaseGroup {
    add(member: FencedOwner): () => void;
}
/** A host membership cache whose committed writes other replicas must drop.
 * The router publishes each committed channel as a peer event and calls
 * `invalidate` for channels committed on peers. Hints only: the store must
 * reread its durable authority after an invalidation. */
export interface RealtimeMembershipInvalidation {
    invalidate(channel: string): void;
    onCommittedWrite(observer: (channel: string) => void): () => void;
}
export interface RedisRealtimeRouterOptions {
    /** The existing port, or distributed-core's `BoundedRedis`
     * (`createBoundedRedis(url, { timeoutMs })`), which satisfies it and
     * bounds every reply after the socket write. */
    redis: RealtimeClusterRedis;
    /** Separate applications/environments must use separate namespaces. */
    namespace: string;
    /** Unique among live replicas. A second live owner is rejected. */
    nodeId: string;
    authorize?: ChannelAuthorize;
    filterClientMessage?: ClientMessageFilter;
    plugins?: FeaturePlugin[];
    logger?: RouterLogger;
    leaseMs?: number;
    requestTimeoutMs?: number;
    maxFrameBytes?: number;
    maxPendingRequests?: number;
    maxSeenFrames?: number;
    /**
     * 0.109, opt-in (authorityScope.ts P1-P5). > 0: one sender-side publish
     * authorize per (client, channel) per operation on this node, and a
     * content-free proof time carried to peers; a peer with its own value
     * > 0 skips only the redundant publisher re-check while that time is
     * younger than ITS max age. Recipient checks always run on every node.
     */
    publishProofMaxAgeMs?: number;
    /**
     * 0.110, opt-in (authorityScope.ts P6). > 0: frames one origin operation
     * sends to a peer (its `subscription-check` probes and its `channel`
     * fan-out) carry a content-free operation number, and the peer runs
     * them under ONE authority scope per (origin instance, operation),
     * kept open at most this many ms after its last frame finishes. Every
     * check still asks `authorize`; only host-shared proofs (one membership
     * read per channel) are reused. 0 (default): one scope per frame, as
     * before, and no operation number on the wire. Max 2000.
     */
    peerOperationLingerMs?: number;
    /**
     * 0.117: fence together with sibling owners in the same process (e.g. a
     * `/ws` router and a cookie `/realtime` router). Pass a distributed-core
     * `LeaseGroup`; the router joins it once its lease is acquired. When any
     * member fences, every other member is fenced and released, so no lease
     * outlives the node's 503. A router joining a retired group fails start.
     * `shutdown()` leaves the group before releasing its lease, so a
     * deliberate shutdown (or a failed start) does not retire siblings; a
     * fence always does.
     */
    leaseGroup?: RealtimeLeaseGroup;
    /**
     * 0.117: cross-replica invalidation for a membership cache. Committed
     * writes are published on `membershipEventTopic` (default
     * `chat:membership`) and peers call `invalidate(channel)`.
     */
    membershipStore?: RealtimeMembershipInvalidation;
    /** Peer event topic for `membershipStore`. Default `chat:membership`. */
    membershipEventTopic?: string;
    /** Peer-supplied channels this node will invalidate. Default: any non-empty string up to 512 bytes. */
    acceptMembershipChannel?: (channel: string) => boolean;
}
type Source = { nodeId: string; instance: string };
type Registration = Source & { generation: string; ctx: WsAuthContext };
type Wire = { v: 1; id: string; source: Source; kind: 'direct' | 'receipt' | 'channel' | 'broadcast' | 'call-event' | 'peer-event' | 'subscription-check';
    clientId?: string; generation?: string; delivered?: boolean; channel?: string;
    eventTopic?: string;
    excludeClientId?: string | null; publisher?: { clientId: string; generation: string; proofAt?: number }; message?: unknown;
    /** P6: the origin operation this frame belongs to (its scope id). */
    op?: number };
const NOOP_LOGGER: RouterLogger = { debug() {}, info() {}, warn() {}, error() {} };
const REGISTER = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); redis.call('SADD',KEYS[3],ARGV[4]);
redis.call('PEXPIRE',KEYS[3],ARGV[3]*2); return 1`;
const REMOVE = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL',KEYS[1]); redis.call('SREM',KEYS[2],ARGV[2]); return 1`;
const PRUNE = "if redis.call('EXISTS',KEYS[1]) == 0 then return redis.call('SREM',KEYS[2],ARGV[1]) end return 0";
const MEMBERSHIP_CHANNEL_MAX_BYTES = 512;

/** Opt-in Redis peer transport. Each destination uses LocalRealtimeRouter's
 * current recipient authorization/context/subscription fences. Directory
 * records come exclusively from the authenticated connection lifecycle;
 * outbound frames never supply or replace a recipient's auth context.
 * This carries routing, not service-state replication (presence/CRDT/etc.). */
export class RedisRealtimeRouter implements RealtimeRouter {
    readonly redisAvailable = true;
    readonly nodeId: string;
    readonly instance = randomUUID();
    private readonly local: LocalRealtimeRouter;
    private readonly log: RouterLogger;
    private readonly prefix: string;
    private readonly leaseMs: number;
    private readonly timeoutMs: number;
    private readonly maxBytes: number;
    private readonly maxPending: number;
    private readonly maxSeen: number;
    private handle: WsHandlerHandle | null = null;
    private stopped = false;
    private started = false;
    /** The node ownership lease (0.117: distributed-core `FencedLease`).
     * Its owner is this router's boot `instance`; it renews this node's
     * client registrations (and their user index) as attached keys. */
    private readonly ownership: FencedLease;
    private readonly membershipTopic: string;
    private readonly unsubs: Array<() => Promise<void> | void> = [];
    private readonly registrations = new Map<string, { registration: Registration; encoded: string; context: WsAuthContext }>();
    private readonly remote = new Map<string, { encoded: string; registration: Registration; until: number }>();
    private readonly pending = new Map<string, { target: Source; resolve: (delivered: boolean) => void }>();
    private readonly seen = new Map<string, { until: number; pending: boolean; result: Promise<boolean> }>();
    private activeDeliveries = 0;
    private readonly peerLingerMs: number;
    private readonly peerOps = new Map<string, { scope: AuthorityScope; refs: number; timer: ReturnType<typeof setTimeout> | null }>();
    private readonly cleanup = new Set<Promise<unknown>>();
    private readonly callHandlers = new Set<(payload: string) => void>();
    private readonly peerHandlers = new Map<string, Set<(payload: string) => void | Promise<void>>>();
    readonly peerEvents: RealtimePeerEvents = {
        publish: async (topic, payload) => {
            this.validateEventTopic(topic);
            if (typeof payload !== 'string') throw new Error('Peer event payload must be a string');
            await this.publish(`${this.prefix}peer-events`, {
                v: 1, id: randomUUID(), source: this.source(), kind: 'peer-event', eventTopic: topic, message: payload,
            });
        },
        subscribe: (topic, handler) => {
            this.validateEventTopic(topic);
            const handlers = this.peerHandlers.get(topic) ?? new Set();
            handlers.add(handler); this.peerHandlers.set(topic, handlers);
            return () => { handlers.delete(handler); if (!handlers.size) this.peerHandlers.delete(topic); };
        },
    };
    private validateEventTopic(topic: string): void {
        if (typeof topic !== 'string' || !/^[a-z][a-z0-9:_-]{0,127}$/.test(topic)) throw new Error('Invalid peer event topic');
    }
    /** False permanently after ownership expires or renewal fails. Hosts can
     * remove an unhealthy replica from admission without knowing Redis keys. */
    isReady(): boolean { return this.live(); }
    /** Same as `isReady()`; with `onFence` this makes the router a
     * distributed-core `ReadinessGate` owner. */
    isLive(): boolean { return this.live(); }
    /** Called once when routing stops being live: the lease fenced (expired,
     * renewal failed/refused, connection unavailable, sibling, manual) or was
     * released at shutdown (`reason: 'released'`). */
    onFence(handler: (event: FenceEvent) => void): () => void { return this.ownership.onFence(handler); }
    /** The ownership lease, for a host `LeaseGroup` or `ReadinessGate`. */
    get lease(): FencedOwner { return this.ownership; }
    /** The lease's monotonic fencing token (0 before start). */
    get fencingToken(): number { return this.ownership.token; }
    /** Ready with start(), namespace-scoped and checked against the origin's
     * live ownership lease. CallService's sync subscription has no async gap. */
    readonly crossNodePubSub: CallCrossNodePubSub = {
        publish: async (topic, payload) => {
            if (topic !== 'call:client-departed') throw new Error('Unsupported cluster call topic');
            await this.publish(`${this.prefix}call-events`, {
                v: 1, id: randomUUID(), source: this.source(), kind: 'call-event', message: payload,
            });
        },
        subscribe: (topic, handler) => {
            if (topic !== 'call:client-departed') throw new Error('Unsupported cluster call topic');
            this.callHandlers.add(handler);
            return () => { this.callHandlers.delete(handler); };
        },
    };

    constructor(private readonly opts: RedisRealtimeRouterOptions) {
        if (!opts.namespace || !opts.nodeId) throw new Error('Cluster namespace and nodeId are required');
        this.nodeId = opts.nodeId;
        this.prefix = `realtime:${encodeURIComponent(opts.namespace)}:`;
        this.leaseMs = opts.leaseMs ?? 30_000;
        this.timeoutMs = opts.requestTimeoutMs ?? 3_000;
        this.maxBytes = opts.maxFrameBytes ?? 1024 * 1024;
        this.maxPending = opts.maxPendingRequests ?? 1024;
        this.maxSeen = opts.maxSeenFrames ?? 10_000;
        this.peerLingerMs = opts.peerOperationLingerMs ?? 0;
        if (!Number.isSafeInteger(this.peerLingerMs) || this.peerLingerMs < 0 || this.peerLingerMs > 2000) throw new Error('Invalid peer operation linger');
        if (![this.leaseMs, this.timeoutMs, this.maxBytes, this.maxPending, this.maxSeen].every(n => Number.isSafeInteger(n) && n > 0)
            || this.leaseMs < 300 || this.timeoutMs >= this.leaseMs) throw new Error('Invalid cluster bounds');
        this.log = opts.logger ?? NOOP_LOGGER;
        this.local = new LocalRealtimeRouter({ authorize: opts.authorize, filterClientMessage: opts.filterClientMessage,
            plugins: opts.plugins, logger: this.log, publishProofMaxAgeMs: opts.publishProofMaxAgeMs ?? 0 });
        this.membershipTopic = opts.membershipEventTopic ?? 'chat:membership';
        if (opts.membershipStore) this.validateEventTopic(this.membershipTopic);
        this.ownership = new FencedLease({
            redis: opts.redis, key: this.nodeKey(), owner: this.instance, leaseMs: this.leaseMs,
            // One never-expiring fencing counter per namespace, not one per
            // nodeId: replica ids are often per-task and would leak a key each.
            tokenKey: `${this.prefix}lease-fence`,
            attached: () => this.attachments(),
            logger: { warn: (message, error) => this.log.warn(`[realtime-cluster] ${message}`, error) },
        });
        this.ownership.onFence(() => this.fenced());
    }
    private nodeKey(nodeId = this.nodeId) { return `${this.prefix}node:${encodeURIComponent(nodeId)}`; }
    private clientKey(clientId: string) { return `${this.prefix}client:${encodeURIComponent(clientId)}`; }
    private userKey(userId: string) { return `${this.prefix}user:${encodeURIComponent(userId)}`; }
    private topic(nodeId: string = this.nodeId, instance: string = this.instance) { return `${this.prefix}direct:${encodeURIComponent(nodeId)}:${instance}`; }
    private live() {
        // isLive() fences the lease itself once its local deadline passes.
        return this.started && !this.stopped && this.ownership.isLive();
    }
    /** The lease stopped being live. It never revives (the lease logs why). */
    private fenced(): void {
        for (const pending of this.pending.values()) pending.resolve(false);
        this.closePeerOps();
    }
    /** Renewed atomically with the owner key: each current registration's
     * client key (while it still holds this registration) and its user index. */
    private *attachments(): Iterable<LeaseAttachment> {
        for (const [id, entry] of this.registrations) {
            if (this.current(id) !== entry.context) continue;
            yield { key: this.clientKey(id), value: entry.encoded, companions: [this.userKey(entry.context.userId!)] };
        }
    }
    private source(): Source { return { nodeId: this.nodeId, instance: this.instance }; }
    private current(clientId: string) { return this.handle?.getClientContext(clientId) ?? null; }
    private validSource(source: unknown): source is Source {
        const value = source as Source | null;
        return !!value && typeof value.nodeId === 'string' && !!value.nodeId && typeof value.instance === 'string' && !!value.instance;
    }
    private ownerAlive(source: Source) {
        return FencedLease.isHeldBy(this.opts.redis, this.nodeKey(source.nodeId), source.instance);
    }
    async start(): Promise<void> {
        if (this.started || this.stopped) throw new Error('Cluster router cannot be started twice');
        try {
            // SET NX PX plus a fencing token; the lease also fences on the
            // port's onUnavailable, so a lost subscriber/publisher fences here.
            await this.ownership.acquire();
        } catch (error) {
            if (error instanceof LeaseHeldError || (error as { code?: unknown } | null)?.code === 'lease-held') {
                throw new Error('Cluster nodeId already has a live owner');
            }
            throw error;
        }
        try {
            if (this.opts.leaseGroup) this.unsubs.push(this.opts.leaseGroup.add(this.ownership));
            if (!this.ownership.isLive()) throw new Error('Cluster ownership lease is not live (its lease group may be retired)');
            for (const topic of [this.topic(), `${this.prefix}channels`, `${this.prefix}broadcast`, `${this.prefix}call-events`, `${this.prefix}peer-events`]) {
                this.unsubs.push(await this.opts.redis.subscribe(topic, payload => {
                    void this.receive(payload).catch(error => this.log.warn('[realtime-cluster] peer delivery failed', error));
                }));
            }
            if (!this.ownership.isLive()) throw new Error('Cluster startup exceeded or lost its ownership lease');
            this.wireMembership();
            this.started = true;
        } catch (error) {
            await this.shutdown();
            throw error;
        }
    }
    _setHandle(handle: WsHandlerHandle): void {
        this.handle = handle;
        this.local._setHandle({ ...handle,
            getClientContext: id => this.live() ? handle.getClientContext(id) : null,
            listClients: () => this.live() ? handle.listClients() : [],
            sendToClient: (id, frame) => this.live() && handle.sendToClient(id, frame),
        });
    }
    async onClientConnect(clientId: string, ctx: WsAuthContext): Promise<void> {
        if (!this.live() || this.current(clientId) !== ctx || typeof ctx.userId !== 'string' || !ctx.userId) {
            throw new Error('Cluster connection is not authenticated or router is not ready');
        }
        const registration: Registration = { ...this.source(), generation: randomUUID(), ctx };
        const encoded = JSON.stringify(registration);
        if (Buffer.byteLength(encoded) > this.maxBytes) throw new Error('Cluster identity exceeds frame bound');
        const added = await this.opts.redis.command('EVAL', REGISTER, '3', this.nodeKey(), this.clientKey(clientId),
            this.userKey(ctx.userId), this.instance, encoded, String(this.leaseMs), clientId);
        if (added !== 1) throw new Error('Cluster connection ownership refused');
        this.registrations.set(clientId, { registration, encoded, context: ctx });
        if (!this.live() || this.current(clientId) !== ctx) {
            this.removeClient(clientId);
            throw new Error('Cluster connection changed during registration');
        }
    }
    private wireMembership(): void {
        const store = this.opts.membershipStore;
        if (!store) return;
        const accept = this.opts.acceptMembershipChannel ?? (() => true);
        const valid = (channel: unknown): channel is string => typeof channel === 'string' && !!channel
            && Buffer.byteLength(channel) <= MEMBERSHIP_CHANNEL_MAX_BYTES;
        this.unsubs.push(this.peerEvents.subscribe(this.membershipTopic, payload => {
            let channel: unknown;
            try { channel = JSON.parse(payload); } catch { return; } // a hint is never a membership record
            if (!valid(channel)) return;
            let accepted = false;
            try { accepted = accept(channel); } catch { /* refuse */ }
            if (accepted) store.invalidate(channel);
        }));
        this.unsubs.push(store.onCommittedWrite(channel => {
            if (!valid(channel) || !this.live()) return;
            void this.peerEvents.publish(this.membershipTopic, JSON.stringify(channel))
                .catch(error => this.log.warn('[realtime-cluster] membership invalidation publish failed', error));
        }));
    }
    private async registration(clientId: string, remember = true): Promise<Registration | null> {
        if (!this.live()) return null;
        const encoded = await this.opts.redis.command('GET', this.clientKey(clientId));
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > this.maxBytes) return null;
        let value: Registration;
        try { value = JSON.parse(encoded); } catch { return null; }
        if (!this.validSource(value) || typeof value.generation !== 'string' || !value.generation
            || !value.ctx || typeof value.ctx.userId !== 'string' || !value.ctx.userId || !await this.ownerAlive(value)) return null;
        if (!this.live()) return null;
        const previous = this.remote.get(clientId);
        if (value.instance === this.instance && !this.current(clientId)) return null;
        const registration = previous?.encoded === encoded ? previous.registration : value;
        if (remember) {
            if (this.remote.size >= this.maxSeen && !previous) this.remote.delete(this.remote.keys().next().value!);
            this.remote.set(clientId, { encoded, registration, until: performance.now() + this.leaseMs });
        }
        return registration;
    }
    getClientData(clientId: string): { userContext?: WsAuthContext } | null {
        const ctx = this.live() ? this.current(clientId) : null;
        if (ctx) return { userContext: ctx };
        const entry = this.remote.get(clientId);
        return this.live() && entry && performance.now() < entry.until ? { userContext: entry.registration.ctx } : null;
    }
    async resolveClientData(clientId: string): Promise<{ userContext?: WsAuthContext } | null> {
        if (!this.live()) return null;
        const ctx = this.current(clientId);
        if (ctx) return { userContext: ctx };
        const registration = await this.registration(clientId);
        if (!registration) { this.remote.delete(clientId); return null; }
        return { userContext: registration.ctx };
    }
    getUserIdForClient(clientId: string): string | undefined { return this.getClientData(clientId)?.userContext?.userId; }
    isClientLive(clientId: string): boolean | null {
        if (!this.live()) return false;
        return this.current(clientId) ? true : null;
    }
    async isClientAlive(clientId: string): Promise<boolean> { return !!await this.resolveClientData(clientId); }
    async getClientsByUserId(userIds: string[], excludeClientId?: string): Promise<{ clientId: string; userId: string }[]> {
        if (!this.live()) return [];
        const ids = new Set<string>();
        const indexes = new Map<string, string[]>();
        for (const userId of new Set(userIds)) {
            const values = await this.opts.redis.command('SMEMBERS', this.userKey(userId));
            if (Array.isArray(values)) for (const id of values) if (typeof id === 'string' && id !== excludeClientId) {
                ids.add(id);
                const users = indexes.get(id) ?? []; users.push(userId); indexes.set(id, users);
            }
        }
        const wanted = new Set(userIds), found: { clientId: string; userId: string }[] = [];
        for (const clientId of ids) {
            const registration = await this.registration(clientId);
            if (registration && wanted.has(registration.ctx.userId!)) found.push({ clientId, userId: registration.ctx.userId! });
            else if (!registration) {
                // One healthy socket can keep its user's index alive through
                // many crashed peers. Remove only entries whose client lease
                // is still absent at the atomic prune, preserving a racing
                // authenticated replacement registration.
                for (const userId of indexes.get(clientId) ?? []) await this.opts.redis.command('EVAL', PRUNE, '2',
                    this.clientKey(clientId), this.userKey(userId), clientId);
            }
        }
        return found;
    }
    private encode(frame: Wire): string {
        const encoded = JSON.stringify(frame);
        if (Buffer.byteLength(encoded) > this.maxBytes) throw new Error('Cluster frame exceeds bound');
        return encoded;
    }
    private async publish(topic: string, frame: Wire) {
        if (!this.live()) throw new Error('Cluster routing is not ready');
        await this.opts.redis.publish(topic, this.encode(frame));
    }
    async sendToClient(clientId: string, message: unknown): Promise<boolean> {
        if (!this.live()) return false;
        const previous = this.remote.get(clientId)?.registration;
        if (this.current(clientId)) {
            const local = this.registrations.get(clientId)?.registration;
            if (!local || (previous && previous.generation !== local.generation)) return false;
            return this.local.sendToClient(clientId, message);
        }
        // A send is not an authority refresh. Retrying the same captured
        // audience must not silently adopt a replacement connection.
        const target = await this.registration(clientId, false);
        if (!target || (previous && previous.generation !== target.generation) || this.pending.size >= this.maxPending) return false;
        return this.request(target, { kind: 'direct', clientId, generation: target.generation, message });
    }
    private request(target: Registration, fields: Pick<Wire, 'kind' | 'clientId' | 'generation' | 'message' | 'channel' | 'op'>): Promise<boolean> {
        const id = randomUUID();
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            const finish = (delivered: boolean) => { clearTimeout(timer); this.pending.delete(id); resolve(delivered); };
            this.pending.set(id, { target, resolve: finish });
            void this.publish(this.topic(target.nodeId, target.instance), {
                v: 1, id, source: this.source(), ...fields,
            }).catch(() => finish(false));
        });
    }
    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean> {
        return this.live() ? this.local.sendToLocalClient(clientId, message) : false;
    }
    hasChannelAuthorize() { return this.local.hasChannelAuthorize(); }
    async checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts: ChannelAccessOpts = {}): Promise<boolean> {
        if (!this.live()) return false;
        if (this.current(clientId)) return this.local.checkChannel(kind, clientId, channel, opts);
        const before = await this.registration(clientId);
        if (!before) return false;
        let allowed = false;
        try {
            allowed = !this.opts.authorize || await this.opts.authorize(opts.scope?.active
                ? { kind, clientId, channel, ctx: before.ctx, scope: opts.scope }
                : { kind, clientId, channel, ctx: before.ctx });
        } catch { /* fail closed */ }
        const after = await this.registration(clientId);
        allowed = allowed && this.live() && !!after && before.generation === after.generation && before.instance === after.instance;
        if (!allowed && !opts.silent) await this.sendToClient(clientId, channelDeniedFrame({
            kind, channel: opts.clientChannel ?? channel, service: opts.service,
        }));
        return allowed;
    }
    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts) {
        return this.live() ? this.local.subscribeToChannel(clientId, channel, opts) : false;
    }
    unsubscribeFromChannel(clientId: string, channel: string) { this.local.unsubscribeFromChannel(clientId, channel); }
    async isClientSubscribed(clientId: string, channel: string, opts: { scope?: AuthorityScope } = {}): Promise<boolean> {
        if (!this.live() || typeof channel !== 'string' || !channel || Buffer.byteLength(channel) > this.maxBytes) return false;
        if (this.current(clientId)) {
            const subscribed = await this.local.isClientSubscribed(clientId, channel, opts);
            return this.live() && subscribed;
        }
        const target = await this.registration(clientId, false);
        if (!target || target.instance === this.instance || this.pending.size >= this.maxPending) return false;
        const op = this.operationOf(opts.scope);
        return this.request(target, { kind: 'subscription-check', clientId, generation: target.generation, channel, ...(op !== undefined ? { op } : {}) });
    }
    async sendToChannel(channel: string, message: unknown, excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null; scope?: AuthorityScope }): Promise<void> {
        if (!this.live()) throw new Error('Cluster routing is not ready');
        const { scope, owned } = scopeFor(opts?.scope, 'fanout');
        try {
            await this.sendToChannelScoped(channel, message, excludeClientId, opts, scope);
        } finally {
            if (owned) scope.close();
        }
    }
    private async sendToChannelScoped(channel: string, message: unknown, excludeClientId: string | null | undefined,
        opts: { skipCoalesce?: boolean; publisherClientId?: string | null } | undefined, scope: AuthorityScope): Promise<void> {
        const publisherId = opts?.publisherClientId ?? null;
        const ctx = publisherId ? this.current(publisherId) : null;
        if (publisherId && (!ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true, scope }))) return;
        await this.local.sendToChannel(channel, message, excludeClientId, { ...opts, scope });
        if (publisherId && (this.current(publisherId) !== ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true, scope }))) return;
        const registration = publisherId ? this.registrations.get(publisherId)?.registration : null;
        if (publisherId && !registration) return;
        // P5: a content-free proof time, only for a live allowed proof.
        const proofAt = publisherId ? this.local.publishProofAt(scope, publisherId, channel) : null;
        const op = this.operationOf(scope);
        await this.publish(`${this.prefix}channels`, { v: 1, id: randomUUID(), source: this.source(), kind: 'channel',
            channel, message, excludeClientId, ...(publisherId ? { publisher: { clientId: publisherId, generation: registration!.generation,
                ...(proofAt !== null ? { proofAt } : {}) } } : {}), ...(op !== undefined ? { op } : {}) });
    }
    async broadcastToAll(message: unknown, excludeClientId?: string): Promise<void> {
        await this.local.broadcastToAll(message, excludeClientId);
        await this.publish(`${this.prefix}broadcast`, { v: 1, id: randomUUID(), source: this.source(), kind: 'broadcast', message, excludeClientId });
    }
    private async receive(payload: string): Promise<void> {
        if (!this.live() || Buffer.byteLength(payload) > this.maxBytes) return;
        let frame: Wire;
        try { frame = JSON.parse(payload); } catch { return; }
        if (!frame || frame.v !== 1 || typeof frame.id !== 'string' || !frame.id || !this.validSource(frame.source)) return;
        if (frame.kind === 'receipt') {
            const pending = this.pending.get(frame.id);
            if (pending && pending.target.nodeId === frame.source.nodeId && pending.target.instance === frame.source.instance) {
                pending.resolve(frame.delivered === true);
            }
            return;
        }
        if (frame.source.instance === this.instance) return;
        if (!['direct', 'channel', 'broadcast', 'call-event', 'peer-event', 'subscription-check'].includes(frame.kind)) return;
        const key = `${frame.source.instance}:${frame.id}`;
        const now = performance.now();
        for (const [id, entry] of this.seen) if (!entry.pending && entry.until < now) this.seen.delete(id);
        let entry = this.seen.get(key);
        if (!entry) {
            if (this.seen.size >= this.maxSeen || this.activeDeliveries >= this.maxPending) return;
            this.activeDeliveries++;
            const result = this.deliver(frame).catch(() => false);
            entry = { until: now + this.leaseMs * 2, pending: true, result };
            this.seen.set(key, entry);
            const captured = entry;
            void result.finally(() => { captured.pending = false; captured.until = performance.now() + this.leaseMs * 2; this.activeDeliveries--; });
        }
        const delivered = await entry.result;
        if (frame.kind === 'direct' || frame.kind === 'subscription-check') await this.publish(this.topic(frame.source.nodeId, frame.source.instance), {
            v: 1, id: frame.id, source: this.source(), kind: 'receipt', delivered,
        });
    }
    private async deliver(frame: Wire): Promise<boolean> {
        if (!await this.ownerAlive(frame.source) || !this.live()) return false;
        if (frame.kind === 'peer-event') {
            if (typeof frame.message !== 'string' || typeof frame.eventTopic !== 'string') return false;
            try { this.validateEventTopic(frame.eventTopic); } catch { return false; }
            await Promise.all([...this.peerHandlers.get(frame.eventTopic) ?? []].map(handler => handler(frame.message as string)));
            return true;
        }
        if (frame.kind === 'call-event') {
            if (typeof frame.message !== 'string') return false;
            await Promise.all([...this.callHandlers].map(async handler => { await handler(frame.message as string); }));
            return true;
        }
        if (frame.kind === 'direct' || frame.kind === 'subscription-check') {
            if (typeof frame.clientId !== 'string' || typeof frame.generation !== 'string') return false;
            const local = this.registrations.get(frame.clientId);
            if (!local || local.registration.generation !== frame.generation || this.current(frame.clientId) !== local.context) return false;
            if (frame.kind !== 'subscription-check') return this.local.sendToClient(frame.clientId, frame.message);
            if (typeof frame.channel !== 'string' || !frame.channel || Buffer.byteLength(frame.channel) > this.maxBytes) return false;
            const shared = this.acquirePeerOperation(frame);
            if (!shared) return this.local.isClientSubscribed(frame.clientId, frame.channel);
            try { return await this.local.isClientSubscribed(frame.clientId, frame.channel, { scope: shared.scope }); }
            finally { shared.release(); }
        }
        if (frame.kind === 'channel') {
            if (typeof frame.channel !== 'string' || !frame.channel) return false;
            // One authority scope per peer fan-out: the publisher's re-check
            // and this node's recipient checks share it (P6: and, opted in,
            // the same origin operation's subscription probes).
            const shared = this.acquirePeerOperation(frame);
            const scope = shared?.scope ?? createAuthorityScope('fanout');
            try {
                if (frame.publisher) {
                    if (typeof frame.publisher.clientId !== 'string' || typeof frame.publisher.generation !== 'string') return false;
                    const publisher = await this.registration(frame.publisher.clientId);
                    if (!publisher || publisher.instance !== frame.source.instance || publisher.generation !== frame.publisher.generation) return false;
                    // P5: a fresh origin proof replaces ONLY this sender-side
                    // re-check; every local recipient is still authorized below.
                    if (this.opts.authorize && !acceptsOriginPublishProof(frame.publisher.proofAt, this.local.publishProofMaxAgeMs)
                        && !await this.opts.authorize({ kind: 'publish', clientId: frame.publisher.clientId,
                            channel: frame.channel, ctx: publisher.ctx, scope })) return false;
                }
                await this.local.sendToLocalChannel(frame.channel, frame.message, frame.excludeClientId, scope);
            } finally {
                if (shared) shared.release(); else scope.close();
            }
        } else await this.local.broadcastToAll(frame.message, frame.excludeClientId ?? undefined);
        return true;
    }
    /** P6, origin side: the operation number a peer frame carries, opted in. */
    private operationOf(scope: AuthorityScope | null | undefined): number | undefined {
        return this.peerLingerMs > 0 && scope?.active ? scope.id : undefined;
    }
    /**
     * P6, peer side: one scope per (origin instance, operation) while any of
     * its frames runs, closed `peerLingerMs` after the last one finishes.
     * Null when off, unnumbered or over the bound (callers then use their
     * own per-frame scope, as before 0.110).
     */
    private acquirePeerOperation(frame: Wire): { scope: AuthorityScope; release: () => void } | null {
        if (!(this.peerLingerMs > 0) || typeof frame.op !== 'number' || !Number.isSafeInteger(frame.op) || frame.op < 1) return null;
        const key = `${frame.source.instance}:${frame.op}`;
        let entry = this.peerOps.get(key);
        if (!entry || !entry.scope.active) {
            if (this.peerOps.size >= this.maxPending) return null;
            entry = { scope: createAuthorityScope(`peer:${frame.kind}`), refs: 0, timer: null };
            this.peerOps.set(key, entry);
        }
        const held = entry;
        if (held.timer) { clearTimeout(held.timer); held.timer = null; }
        held.refs++;
        let released = false;
        return { scope: held.scope, release: () => {
            if (released) return;
            released = true;
            if (--held.refs > 0) return;
            held.timer = setTimeout(() => {
                if (held.refs > 0) return;
                if (this.peerOps.get(key) === held) this.peerOps.delete(key);
                held.scope.close();
            }, this.peerLingerMs);
            held.timer.unref?.();
        } };
    }
    private closePeerOps(): void {
        for (const entry of this.peerOps.values()) { if (entry.timer) clearTimeout(entry.timer); entry.scope.close(); }
        this.peerOps.clear();
    }
    removeClient(clientId: string): void {
        this.local.removeClient(clientId);
        const entry = this.registrations.get(clientId);
        this.registrations.delete(clientId);
        this.remote.delete(clientId);
        if (!entry) return;
        const task = this.opts.redis.command('EVAL', REMOVE, '2', this.clientKey(clientId), this.userKey(entry.context.userId!), entry.encoded, clientId)
            .catch(error => this.log.warn('[realtime-cluster] disconnect cleanup failed; registration will expire', error));
        this.cleanup.add(task);
        void task.finally(() => this.cleanup.delete(task));
    }
    async shutdown(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.closePeerOps();
        for (const pending of this.pending.values()) pending.resolve(false);
        for (const id of this.registrations.keys()) this.removeClient(id);
        await Promise.all([...this.cleanup]);
        for (const unsubscribe of this.unsubs.splice(0)) {
            try { await unsubscribe(); } catch (error) { this.log.warn('[realtime-cluster] unsubscribe failed during retirement', error); }
        }
        // Stops renewal (awaiting one in flight) and compare-and-deletes the
        // owner key; a failure only logs and the key expires within leaseMs.
        await this.ownership.release();
        this.remote.clear(); this.seen.clear(); this.callHandlers.clear(); this.peerHandlers.clear();
    }
}
