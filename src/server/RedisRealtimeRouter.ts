import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { WsAuthContext, WsHandlerHandle } from '../server-ws/types';
import { LocalRealtimeRouter, type RealtimeRouter, type ChannelAuthorize, type ClientMessageFilter, type FeaturePlugin, type RouterLogger } from './router';
import type { ChannelAccessKind, ChannelAccessOpts } from '../server-ws/channelAccess';
import type { CallCrossNodePubSub } from '../call/types';

/** Connected command/publish and dedicated subscriber clients. The host owns
 * connection setup, TLS/credentials, reconnect policy and final client close.
 * Ports deliberately avoid a mandatory Redis client dependency. */
export interface RealtimeClusterRedis {
    command(...args: string[]): Promise<unknown>;
    publish(topic: string, payload: string): Promise<unknown>;
    subscribe(topic: string, receive: (payload: string) => void): Promise<() => Promise<void> | void>;
}
export interface RedisRealtimeRouterOptions {
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
}
type Source = { nodeId: string; instance: string };
type Registration = Source & { generation: string; ctx: WsAuthContext };
type Wire = { v: 1; id: string; source: Source; kind: 'direct' | 'receipt' | 'channel' | 'broadcast' | 'call-event';
    clientId?: string; generation?: string; delivered?: boolean; channel?: string;
    excludeClientId?: string | null; publisher?: { clientId: string; generation: string }; message?: unknown };
const NOOP_LOGGER: RouterLogger = { debug() {}, info() {}, warn() {}, error() {} };
const RELEASE = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const REGISTER = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); redis.call('SADD',KEYS[3],ARGV[4]);
redis.call('PEXPIRE',KEYS[3],ARGV[3]*2); return 1`;
const REMOVE = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL',KEYS[1]); redis.call('SREM',KEYS[2],ARGV[2]); return 1`;
const RENEW = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE',KEYS[1],ARGV[2]);
for i=2,#KEYS,2 do if redis.call('GET',KEYS[i]) == ARGV[i/2+2] then
redis.call('PEXPIRE',KEYS[i],ARGV[2]); redis.call('PEXPIRE',KEYS[i+1],ARGV[2]*2); end end
return 1`;

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
    private deadline = 0;
    private stopped = false;
    private started = false;
    private fenced = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private renewing: Promise<void> | null = null;
    private readonly unsubs: Array<() => Promise<void> | void> = [];
    private readonly registrations = new Map<string, { registration: Registration; encoded: string; context: WsAuthContext }>();
    private readonly remote = new Map<string, { encoded: string; registration: Registration; until: number }>();
    private readonly pending = new Map<string, { target: Source; resolve: (delivered: boolean) => void }>();
    private readonly seen = new Map<string, { until: number; pending: boolean; result: Promise<boolean> }>();
    private activeDeliveries = 0;
    private readonly cleanup = new Set<Promise<unknown>>();
    private readonly callHandlers = new Set<(payload: string) => void>();
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
        if (![this.leaseMs, this.timeoutMs, this.maxBytes, this.maxPending, this.maxSeen].every(n => Number.isSafeInteger(n) && n > 0)
            || this.leaseMs < 300 || this.timeoutMs >= this.leaseMs) throw new Error('Invalid cluster bounds');
        this.log = opts.logger ?? NOOP_LOGGER;
        this.local = new LocalRealtimeRouter({ authorize: opts.authorize, filterClientMessage: opts.filterClientMessage,
            plugins: opts.plugins, logger: this.log });
    }
    private nodeKey(nodeId = this.nodeId) { return `${this.prefix}node:${encodeURIComponent(nodeId)}`; }
    private clientKey(clientId: string) { return `${this.prefix}client:${encodeURIComponent(clientId)}`; }
    private userKey(userId: string) { return `${this.prefix}user:${encodeURIComponent(userId)}`; }
    private topic(nodeId: string = this.nodeId, instance: string = this.instance) { return `${this.prefix}direct:${encodeURIComponent(nodeId)}:${instance}`; }
    private live() {
        if (this.started && performance.now() >= this.deadline) this.fenced = true;
        return this.started && !this.stopped && !this.fenced;
    }
    private source(): Source { return { nodeId: this.nodeId, instance: this.instance }; }
    private current(clientId: string) { return this.handle?.getClientContext(clientId) ?? null; }
    private validSource(source: unknown): source is Source {
        const value = source as Source | null;
        return !!value && typeof value.nodeId === 'string' && !!value.nodeId && typeof value.instance === 'string' && !!value.instance;
    }
    private async ownerAlive(source: Source) {
        return await this.opts.redis.command('GET', this.nodeKey(source.nodeId)) === source.instance;
    }
    async start(): Promise<void> {
        if (this.started || this.stopped) throw new Error('Cluster router cannot be started twice');
        const before = performance.now();
        const claimed = await this.opts.redis.command('SET', this.nodeKey(), this.instance, 'NX', 'PX', String(this.leaseMs));
        if (claimed !== 'OK') throw new Error('Cluster nodeId already has a live owner');
        this.deadline = before + this.leaseMs;
        try {
            for (const topic of [this.topic(), `${this.prefix}channels`, `${this.prefix}broadcast`, `${this.prefix}call-events`]) {
                this.unsubs.push(await this.opts.redis.subscribe(topic, payload => {
                    void this.receive(payload).catch(error => this.log.warn('[realtime-cluster] peer delivery failed', error));
                }));
            }
            if (performance.now() >= this.deadline) throw new Error('Cluster startup exceeded its ownership lease');
            this.started = true;
            this.timer = setInterval(() => {
                if (!this.renewing) {
                    this.renewing = this.renew().catch(error => {
                        this.fenced = true;
                        this.deadline = 0;
                        this.log.warn('[realtime-cluster] lease renewal failed; delivery fenced', error);
                    }).finally(() => { this.renewing = null; });
                }
            }, Math.floor(this.leaseMs / 3));
            this.timer.unref?.();
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
    private async renew(): Promise<void> {
        if (this.stopped || this.fenced) return;
        if (!this.live()) throw new Error('Cluster ownership lease expired');
        const current = [...this.registrations].filter(([id, entry]) => this.current(id) === entry.context);
        const keys = [this.nodeKey(), ...current.flatMap(([id, entry]) => [this.clientKey(id), this.userKey(entry.context.userId!)])];
        const before = performance.now();
        const previousDeadline = this.deadline;
        const renewed = await this.opts.redis.command('EVAL', RENEW, String(keys.length), ...keys,
            this.instance, String(this.leaseMs), ...current.map(([, entry]) => entry.encoded));
        if (renewed !== 1 || this.fenced || performance.now() >= previousDeadline) throw new Error('Cluster ownership lease lost');
        this.deadline = before + this.leaseMs;
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
        for (const userId of new Set(userIds)) {
            const values = await this.opts.redis.command('SMEMBERS', this.userKey(userId));
            if (Array.isArray(values)) for (const id of values) if (typeof id === 'string' && id !== excludeClientId) ids.add(id);
        }
        const wanted = new Set(userIds), found: { clientId: string; userId: string }[] = [];
        for (const clientId of ids) {
            const registration = await this.registration(clientId);
            if (registration && wanted.has(registration.ctx.userId!)) found.push({ clientId, userId: registration.ctx.userId! });
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
        const id = randomUUID();
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            const finish = (delivered: boolean) => { clearTimeout(timer); this.pending.delete(id); resolve(delivered); };
            this.pending.set(id, { target, resolve: finish });
            void this.publish(this.topic(target.nodeId, target.instance), {
                v: 1, id, source: this.source(), kind: 'direct', clientId, generation: target.generation, message,
            }).catch(() => finish(false));
        });
    }
    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean> {
        return this.live() ? this.local.sendToLocalClient(clientId, message) : false;
    }
    hasChannelAuthorize() { return this.local.hasChannelAuthorize(); }
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts) {
        return this.live() ? this.local.checkChannel(kind, clientId, channel, opts) : false;
    }
    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts) {
        return this.live() ? this.local.subscribeToChannel(clientId, channel, opts) : false;
    }
    unsubscribeFromChannel(clientId: string, channel: string) { this.local.unsubscribeFromChannel(clientId, channel); }
    async sendToChannel(channel: string, message: unknown, excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null }): Promise<void> {
        if (!this.live()) throw new Error('Cluster routing is not ready');
        const publisherId = opts?.publisherClientId ?? null;
        const ctx = publisherId ? this.current(publisherId) : null;
        if (publisherId && (!ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true }))) return;
        await this.local.sendToChannel(channel, message, excludeClientId, opts);
        if (publisherId && (this.current(publisherId) !== ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true }))) return;
        const registration = publisherId ? this.registrations.get(publisherId)?.registration : null;
        if (publisherId && !registration) return;
        await this.publish(`${this.prefix}channels`, { v: 1, id: randomUUID(), source: this.source(), kind: 'channel',
            channel, message, excludeClientId, ...(publisherId ? { publisher: { clientId: publisherId, generation: registration!.generation } } : {}) });
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
        if (!['direct', 'channel', 'broadcast', 'call-event'].includes(frame.kind)) return;
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
        if (frame.kind === 'direct') await this.publish(this.topic(frame.source.nodeId, frame.source.instance), {
            v: 1, id: frame.id, source: this.source(), kind: 'receipt', delivered,
        });
    }
    private async deliver(frame: Wire): Promise<boolean> {
        if (!await this.ownerAlive(frame.source) || !this.live()) return false;
        if (frame.kind === 'call-event') {
            if (typeof frame.message !== 'string') return false;
            await Promise.all([...this.callHandlers].map(async handler => { await handler(frame.message as string); }));
            return true;
        }
        if (frame.kind === 'direct') {
            if (typeof frame.clientId !== 'string' || typeof frame.generation !== 'string') return false;
            const local = this.registrations.get(frame.clientId);
            if (!local || local.registration.generation !== frame.generation || this.current(frame.clientId) !== local.context) return false;
            return this.local.sendToClient(frame.clientId, frame.message);
        }
        if (frame.kind === 'channel') {
            if (typeof frame.channel !== 'string' || !frame.channel) return false;
            if (frame.publisher) {
                if (typeof frame.publisher.clientId !== 'string' || typeof frame.publisher.generation !== 'string') return false;
                const publisher = await this.registration(frame.publisher.clientId);
                if (!publisher || publisher.instance !== frame.source.instance || publisher.generation !== frame.publisher.generation) return false;
                if (this.opts.authorize && !await this.opts.authorize({ kind: 'publish', clientId: frame.publisher.clientId,
                    channel: frame.channel, ctx: publisher.ctx })) return false;
            }
            await this.local.sendToLocalChannel(frame.channel, frame.message, frame.excludeClientId);
        } else await this.local.broadcastToAll(frame.message, frame.excludeClientId ?? undefined);
        return true;
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
        this.deadline = 0;
        if (this.timer) clearInterval(this.timer);
        for (const pending of this.pending.values()) pending.resolve(false);
        for (const id of this.registrations.keys()) this.removeClient(id);
        await this.renewing;
        await Promise.all([...this.cleanup]);
        for (const unsubscribe of this.unsubs.splice(0)) await unsubscribe();
        await this.opts.redis.command('EVAL', RELEASE, '1', this.nodeKey(), this.instance);
        this.remote.clear(); this.seen.clear(); this.callHandlers.clear();
    }
}
