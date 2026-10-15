"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisRealtimeRouter = void 0;
const crypto_1 = require("crypto");
const perf_hooks_1 = require("perf_hooks");
const leases_1 = require("distributed-core/cluster/leases");
const router_1 = require("./router");
const channelAccess_1 = require("../server-ws/channelAccess");
const authorityScope_1 = require("../server-ws/authorityScope");
const NOOP_LOGGER = { debug() { }, info() { }, warn() { }, error() { } };
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
class RedisRealtimeRouter {
    opts;
    redisAvailable = true;
    nodeId;
    instance = (0, crypto_1.randomUUID)();
    local;
    log;
    prefix;
    leaseMs;
    timeoutMs;
    maxBytes;
    maxPending;
    maxSeen;
    handle = null;
    stopped = false;
    started = false;
    /** The node ownership lease (0.117: distributed-core `FencedLease`).
     * Its owner is this router's boot `instance`; it renews this node's
     * client registrations (and their user index) as attached keys. */
    ownership;
    membershipTopic;
    unsubs = [];
    registrations = new Map();
    remote = new Map();
    pending = new Map();
    seen = new Map();
    activeDeliveries = 0;
    peerLingerMs;
    peerOps = new Map();
    cleanup = new Set();
    callHandlers = new Set();
    peerHandlers = new Map();
    peerEvents = {
        publish: async (topic, payload) => {
            this.validateEventTopic(topic);
            if (typeof payload !== 'string')
                throw new Error('Peer event payload must be a string');
            await this.publish(`${this.prefix}peer-events`, {
                v: 1, id: (0, crypto_1.randomUUID)(), source: this.source(), kind: 'peer-event', eventTopic: topic, message: payload,
            });
        },
        subscribe: (topic, handler) => {
            this.validateEventTopic(topic);
            const handlers = this.peerHandlers.get(topic) ?? new Set();
            handlers.add(handler);
            this.peerHandlers.set(topic, handlers);
            return () => { handlers.delete(handler); if (!handlers.size)
                this.peerHandlers.delete(topic); };
        },
    };
    validateEventTopic(topic) {
        if (typeof topic !== 'string' || !/^[a-z][a-z0-9:_-]{0,127}$/.test(topic))
            throw new Error('Invalid peer event topic');
    }
    /** False permanently after ownership expires or renewal fails. Hosts can
     * remove an unhealthy replica from admission without knowing Redis keys. */
    isReady() { return this.live(); }
    /** Same as `isReady()`; with `onFence` this makes the router a
     * distributed-core `ReadinessGate` owner. */
    isLive() { return this.live(); }
    /** Called once when routing stops being live: the lease fenced (expired,
     * renewal failed/refused, connection unavailable, sibling, manual) or was
     * released at shutdown (`reason: 'released'`). */
    onFence(handler) { return this.ownership.onFence(handler); }
    /** The ownership lease, for a host `LeaseGroup` or `ReadinessGate`. */
    get lease() { return this.ownership; }
    /** The lease's monotonic fencing token (0 before start). */
    get fencingToken() { return this.ownership.token; }
    /** Ready with start(), namespace-scoped and checked against the origin's
     * live ownership lease. CallService's sync subscription has no async gap. */
    crossNodePubSub = {
        publish: async (topic, payload) => {
            if (topic !== 'call:client-departed')
                throw new Error('Unsupported cluster call topic');
            await this.publish(`${this.prefix}call-events`, {
                v: 1, id: (0, crypto_1.randomUUID)(), source: this.source(), kind: 'call-event', message: payload,
            });
        },
        subscribe: (topic, handler) => {
            if (topic !== 'call:client-departed')
                throw new Error('Unsupported cluster call topic');
            this.callHandlers.add(handler);
            return () => { this.callHandlers.delete(handler); };
        },
    };
    constructor(opts) {
        this.opts = opts;
        if (!opts.namespace || !opts.nodeId)
            throw new Error('Cluster namespace and nodeId are required');
        this.nodeId = opts.nodeId;
        this.prefix = `realtime:${encodeURIComponent(opts.namespace)}:`;
        this.leaseMs = opts.leaseMs ?? 30_000;
        this.timeoutMs = opts.requestTimeoutMs ?? 3_000;
        this.maxBytes = opts.maxFrameBytes ?? 1024 * 1024;
        this.maxPending = opts.maxPendingRequests ?? 1024;
        this.maxSeen = opts.maxSeenFrames ?? 10_000;
        this.peerLingerMs = opts.peerOperationLingerMs ?? 0;
        if (!Number.isSafeInteger(this.peerLingerMs) || this.peerLingerMs < 0 || this.peerLingerMs > 2000)
            throw new Error('Invalid peer operation linger');
        if (![this.leaseMs, this.timeoutMs, this.maxBytes, this.maxPending, this.maxSeen].every(n => Number.isSafeInteger(n) && n > 0)
            || this.leaseMs < 300 || this.timeoutMs >= this.leaseMs)
            throw new Error('Invalid cluster bounds');
        this.log = opts.logger ?? NOOP_LOGGER;
        this.local = new router_1.LocalRealtimeRouter({ authorize: opts.authorize, authorizeBatch: opts.authorizeBatch, filterClientMessage: opts.filterClientMessage,
            plugins: opts.plugins, logger: this.log, publishProofMaxAgeMs: opts.publishProofMaxAgeMs ?? 0 });
        this.membershipTopic = opts.membershipEventTopic ?? 'chat:membership';
        if (opts.membershipStore)
            this.validateEventTopic(this.membershipTopic);
        this.ownership = new leases_1.FencedLease({
            redis: opts.redis, key: this.nodeKey(), owner: this.instance, leaseMs: this.leaseMs,
            // One never-expiring fencing counter per namespace, not one per
            // nodeId: replica ids are often per-task and would leak a key each.
            tokenKey: `${this.prefix}lease-fence`,
            attached: () => this.attachments(),
            logger: { warn: (message, error) => this.log.warn(`[realtime-cluster] ${message}`, error) },
        });
        this.ownership.onFence(() => this.fenced());
    }
    nodeKey(nodeId = this.nodeId) { return `${this.prefix}node:${encodeURIComponent(nodeId)}`; }
    clientKey(clientId) { return `${this.prefix}client:${encodeURIComponent(clientId)}`; }
    userKey(userId) { return `${this.prefix}user:${encodeURIComponent(userId)}`; }
    topic(nodeId = this.nodeId, instance = this.instance) { return `${this.prefix}direct:${encodeURIComponent(nodeId)}:${instance}`; }
    live() {
        // isLive() fences the lease itself once its local deadline passes.
        return this.started && !this.stopped && this.ownership.isLive();
    }
    /** The lease stopped being live. It never revives (the lease logs why). */
    fenced() {
        for (const pending of this.pending.values())
            pending.resolve(false);
        this.closePeerOps();
    }
    /** Renewed atomically with the owner key: each current registration's
     * client key (while it still holds this registration) and its user index. */
    *attachments() {
        for (const [id, entry] of this.registrations) {
            if (this.current(id) !== entry.context)
                continue;
            yield { key: this.clientKey(id), value: entry.encoded, companions: [this.userKey(entry.context.userId)] };
        }
    }
    source() { return { nodeId: this.nodeId, instance: this.instance }; }
    current(clientId) { return this.handle?.getClientContext(clientId) ?? null; }
    validSource(source) {
        const value = source;
        return !!value && typeof value.nodeId === 'string' && !!value.nodeId && typeof value.instance === 'string' && !!value.instance;
    }
    ownerAlive(source) {
        return leases_1.FencedLease.isHeldBy(this.opts.redis, this.nodeKey(source.nodeId), source.instance);
    }
    async start() {
        if (this.started || this.stopped)
            throw new Error('Cluster router cannot be started twice');
        try {
            // SET NX PX plus a fencing token; the lease also fences on the
            // port's onUnavailable, so a lost subscriber/publisher fences here.
            await this.ownership.acquire();
        }
        catch (error) {
            if (error instanceof leases_1.LeaseHeldError || error?.code === 'lease-held') {
                throw new Error('Cluster nodeId already has a live owner');
            }
            throw error;
        }
        try {
            if (this.opts.leaseGroup)
                this.unsubs.push(this.opts.leaseGroup.add(this.ownership));
            if (!this.ownership.isLive())
                throw new Error('Cluster ownership lease is not live (its lease group may be retired)');
            for (const topic of [this.topic(), `${this.prefix}channels`, `${this.prefix}broadcast`, `${this.prefix}call-events`, `${this.prefix}peer-events`]) {
                this.unsubs.push(await this.opts.redis.subscribe(topic, payload => {
                    void this.receive(payload).catch(error => this.log.warn('[realtime-cluster] peer delivery failed', error));
                }));
            }
            if (!this.ownership.isLive())
                throw new Error('Cluster startup exceeded or lost its ownership lease');
            this.wireMembership();
            this.started = true;
        }
        catch (error) {
            await this.shutdown();
            throw error;
        }
    }
    _setHandle(handle) {
        this.handle = handle;
        this.local._setHandle({ ...handle,
            getClientContext: id => this.live() ? handle.getClientContext(id) : null,
            listClients: () => this.live() ? handle.listClients() : [],
            sendToClient: (id, frame) => this.live() && handle.sendToClient(id, frame),
        });
    }
    async onClientConnect(clientId, ctx) {
        if (!this.live() || this.current(clientId) !== ctx || typeof ctx.userId !== 'string' || !ctx.userId) {
            throw new Error('Cluster connection is not authenticated or router is not ready');
        }
        const registration = { ...this.source(), generation: (0, crypto_1.randomUUID)(), ctx };
        const encoded = JSON.stringify(registration);
        if (Buffer.byteLength(encoded) > this.maxBytes)
            throw new Error('Cluster identity exceeds frame bound');
        const added = await this.opts.redis.command('EVAL', REGISTER, '3', this.nodeKey(), this.clientKey(clientId), this.userKey(ctx.userId), this.instance, encoded, String(this.leaseMs), clientId);
        if (added !== 1)
            throw new Error('Cluster connection ownership refused');
        this.registrations.set(clientId, { registration, encoded, context: ctx });
        if (!this.live() || this.current(clientId) !== ctx) {
            this.removeClient(clientId);
            throw new Error('Cluster connection changed during registration');
        }
    }
    wireMembership() {
        const store = this.opts.membershipStore;
        if (!store)
            return;
        const accept = this.opts.acceptMembershipChannel ?? (() => true);
        const valid = (channel) => typeof channel === 'string' && !!channel
            && Buffer.byteLength(channel) <= MEMBERSHIP_CHANNEL_MAX_BYTES;
        this.unsubs.push(this.peerEvents.subscribe(this.membershipTopic, payload => {
            let channel;
            try {
                channel = JSON.parse(payload);
            }
            catch {
                return;
            } // a hint is never a membership record
            if (!valid(channel))
                return;
            let accepted = false;
            try {
                accepted = accept(channel);
            }
            catch { /* refuse */ }
            if (accepted) {
                store.invalidate(channel);
                this.dropVerdicts(channel);
            }
        }));
        this.unsubs.push(store.onCommittedWrite(channel => {
            if (valid(channel))
                this.dropVerdicts(channel);
            if (!valid(channel) || !this.live())
                return;
            void this.peerEvents.publish(this.membershipTopic, JSON.stringify(channel))
                .catch(error => this.log.warn('[realtime-cluster] membership invalidation publish failed', error));
        }));
    }
    dropVerdicts(channel) {
        try {
            this.opts.authorityCache?.invalidateChannel(channel);
        }
        catch (error) {
            this.log.warn('[realtime-cluster] verdict invalidation failed', error);
        }
    }
    /** 0.119 (lane R6): this router's own queues, for `attachRealtime(...).stats()`. */
    stats() {
        return { pendingRequests: this.pending.size, activeDeliveries: this.activeDeliveries, peerOperations: this.peerOps.size, maxPendingRequests: this.maxPending };
    }
    async registration(clientId, remember = true) {
        if (!this.live())
            return null;
        const encoded = await this.opts.redis.command('GET', this.clientKey(clientId));
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > this.maxBytes)
            return null;
        let value;
        try {
            value = JSON.parse(encoded);
        }
        catch {
            return null;
        }
        if (!this.validSource(value) || typeof value.generation !== 'string' || !value.generation
            || !value.ctx || typeof value.ctx.userId !== 'string' || !value.ctx.userId || !await this.ownerAlive(value))
            return null;
        if (!this.live())
            return null;
        const previous = this.remote.get(clientId);
        if (value.instance === this.instance && !this.current(clientId))
            return null;
        const registration = previous?.encoded === encoded ? previous.registration : value;
        if (remember) {
            if (this.remote.size >= this.maxSeen && !previous)
                this.remote.delete(this.remote.keys().next().value);
            this.remote.set(clientId, { encoded, registration, until: perf_hooks_1.performance.now() + this.leaseMs });
        }
        return registration;
    }
    getClientData(clientId) {
        const ctx = this.live() ? this.current(clientId) : null;
        if (ctx)
            return { userContext: ctx };
        const entry = this.remote.get(clientId);
        return this.live() && entry && perf_hooks_1.performance.now() < entry.until ? { userContext: entry.registration.ctx } : null;
    }
    async resolveClientData(clientId) {
        if (!this.live())
            return null;
        const ctx = this.current(clientId);
        if (ctx)
            return { userContext: ctx };
        const registration = await this.registration(clientId);
        if (!registration) {
            this.remote.delete(clientId);
            return null;
        }
        return { userContext: registration.ctx };
    }
    getUserIdForClient(clientId) { return this.getClientData(clientId)?.userContext?.userId; }
    isClientLive(clientId) {
        if (!this.live())
            return false;
        return this.current(clientId) ? true : null;
    }
    async isClientAlive(clientId) { return !!await this.resolveClientData(clientId); }
    async getClientsByUserId(userIds, excludeClientId) {
        if (!this.live())
            return [];
        const ids = new Set();
        const indexes = new Map();
        for (const userId of new Set(userIds)) {
            const values = await this.opts.redis.command('SMEMBERS', this.userKey(userId));
            if (Array.isArray(values))
                for (const id of values)
                    if (typeof id === 'string' && id !== excludeClientId) {
                        ids.add(id);
                        const users = indexes.get(id) ?? [];
                        users.push(userId);
                        indexes.set(id, users);
                    }
        }
        const wanted = new Set(userIds), found = [];
        for (const clientId of ids) {
            const registration = await this.registration(clientId);
            if (registration && wanted.has(registration.ctx.userId))
                found.push({ clientId, userId: registration.ctx.userId });
            else if (!registration) {
                // One healthy socket can keep its user's index alive through
                // many crashed peers. Remove only entries whose client lease
                // is still absent at the atomic prune, preserving a racing
                // authenticated replacement registration.
                for (const userId of indexes.get(clientId) ?? [])
                    await this.opts.redis.command('EVAL', PRUNE, '2', this.clientKey(clientId), this.userKey(userId), clientId);
            }
        }
        return found;
    }
    encode(frame) {
        const encoded = JSON.stringify(frame);
        if (Buffer.byteLength(encoded) > this.maxBytes)
            throw new Error('Cluster frame exceeds bound');
        return encoded;
    }
    async publish(topic, frame) {
        if (!this.live())
            throw new Error('Cluster routing is not ready');
        await this.opts.redis.publish(topic, this.encode(frame));
    }
    async sendToClient(clientId, message) {
        if (!this.live())
            return false;
        const previous = this.remote.get(clientId)?.registration;
        if (this.current(clientId)) {
            const local = this.registrations.get(clientId)?.registration;
            if (!local || (previous && previous.generation !== local.generation))
                return false;
            return this.local.sendToClient(clientId, message);
        }
        // A send is not an authority refresh. Retrying the same captured
        // audience must not silently adopt a replacement connection.
        const target = await this.registration(clientId, false);
        if (!target || (previous && previous.generation !== target.generation) || this.pending.size >= this.maxPending)
            return false;
        return this.request(target, { kind: 'direct', clientId, generation: target.generation, message });
    }
    request(target, fields) {
        const id = (0, crypto_1.randomUUID)();
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            const finish = (delivered) => { clearTimeout(timer); this.pending.delete(id); resolve(delivered); };
            this.pending.set(id, { target, resolve: finish });
            void this.publish(this.topic(target.nodeId, target.instance), {
                v: 1, id, source: this.source(), ...fields,
            }).catch(() => finish(false));
        });
    }
    sendToLocalClient(clientId, message) {
        return this.live() ? this.local.sendToLocalClient(clientId, message) : false;
    }
    hasChannelAuthorize() { return this.local.hasChannelAuthorize(); }
    async checkChannel(kind, clientId, channel, opts = {}) {
        if (!this.live())
            return false;
        if (this.current(clientId))
            return this.local.checkChannel(kind, clientId, channel, opts);
        const before = await this.registration(clientId);
        if (!before)
            return false;
        let allowed = false;
        try {
            allowed = !this.opts.authorize || await this.opts.authorize(opts.scope?.active
                ? { kind, clientId, channel, ctx: before.ctx, scope: opts.scope }
                : { kind, clientId, channel, ctx: before.ctx });
        }
        catch { /* fail closed */ }
        const after = await this.registration(clientId);
        allowed = allowed && this.live() && !!after && before.generation === after.generation && before.instance === after.instance;
        if (!allowed && !opts.silent)
            await this.sendToClient(clientId, (0, channelAccess_1.channelDeniedFrame)({
                kind, channel: opts.clientChannel ?? channel, service: opts.service,
            }));
        return allowed;
    }
    subscribeToChannel(clientId, channel, opts) {
        return this.live() ? this.local.subscribeToChannel(clientId, channel, opts) : false;
    }
    unsubscribeFromChannel(clientId, channel) { this.local.unsubscribeFromChannel(clientId, channel); }
    liveUsersOn(channel, userIds, opts = {}) {
        return (0, router_1.liveUsersOnChannel)(this, channel, userIds, opts);
    }
    async isClientSubscribed(clientId, channel, opts = {}) {
        if (!this.live() || typeof channel !== 'string' || !channel || Buffer.byteLength(channel) > this.maxBytes)
            return false;
        if (this.current(clientId)) {
            const subscribed = await this.local.isClientSubscribed(clientId, channel, opts);
            return this.live() && subscribed;
        }
        const target = await this.registration(clientId, false);
        if (!target || target.instance === this.instance || this.pending.size >= this.maxPending)
            return false;
        const op = this.operationOf(opts.scope);
        return this.request(target, { kind: 'subscription-check', clientId, generation: target.generation, channel, ...(op !== undefined ? { op } : {}) });
    }
    async sendToChannel(channel, message, excludeClientId, opts) {
        if (!this.live())
            throw new Error('Cluster routing is not ready');
        const { scope, owned } = (0, authorityScope_1.scopeFor)(opts?.scope, 'fanout');
        try {
            await this.sendToChannelScoped(channel, message, excludeClientId, opts, scope);
        }
        finally {
            if (owned)
                scope.close();
        }
    }
    async sendToChannelScoped(channel, message, excludeClientId, opts, scope) {
        const publisherId = opts?.publisherClientId ?? null;
        const ctx = publisherId ? this.current(publisherId) : null;
        if (publisherId && (!ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true, scope })))
            return;
        await this.local.sendToChannel(channel, message, excludeClientId, { ...opts, scope });
        if (publisherId && (this.current(publisherId) !== ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true, scope })))
            return;
        const registration = publisherId ? this.registrations.get(publisherId)?.registration : null;
        if (publisherId && !registration)
            return;
        // P5: a content-free proof time, only for a live allowed proof.
        const proofAt = publisherId ? this.local.publishProofAt(scope, publisherId, channel) : null;
        const op = this.operationOf(scope);
        await this.publish(`${this.prefix}channels`, { v: 1, id: (0, crypto_1.randomUUID)(), source: this.source(), kind: 'channel',
            channel, message, excludeClientId, ...(publisherId ? { publisher: { clientId: publisherId, generation: registration.generation,
                    ...(proofAt !== null ? { proofAt } : {}) } } : {}), ...(op !== undefined ? { op } : {}) });
    }
    async broadcastToAll(message, excludeClientId) {
        await this.local.broadcastToAll(message, excludeClientId);
        await this.publish(`${this.prefix}broadcast`, { v: 1, id: (0, crypto_1.randomUUID)(), source: this.source(), kind: 'broadcast', message, excludeClientId });
    }
    async receive(payload) {
        if (!this.live() || Buffer.byteLength(payload) > this.maxBytes)
            return;
        let frame;
        try {
            frame = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (!frame || frame.v !== 1 || typeof frame.id !== 'string' || !frame.id || !this.validSource(frame.source))
            return;
        if (frame.kind === 'receipt') {
            const pending = this.pending.get(frame.id);
            if (pending && pending.target.nodeId === frame.source.nodeId && pending.target.instance === frame.source.instance) {
                pending.resolve(frame.delivered === true);
            }
            return;
        }
        if (frame.source.instance === this.instance)
            return;
        if (!['direct', 'channel', 'broadcast', 'call-event', 'peer-event', 'subscription-check'].includes(frame.kind))
            return;
        const key = `${frame.source.instance}:${frame.id}`;
        const now = perf_hooks_1.performance.now();
        for (const [id, entry] of this.seen)
            if (!entry.pending && entry.until < now)
                this.seen.delete(id);
        let entry = this.seen.get(key);
        if (!entry) {
            if (this.seen.size >= this.maxSeen || this.activeDeliveries >= this.maxPending)
                return;
            this.activeDeliveries++;
            const result = this.deliver(frame).catch(() => false);
            entry = { until: now + this.leaseMs * 2, pending: true, result };
            this.seen.set(key, entry);
            const captured = entry;
            void result.finally(() => { captured.pending = false; captured.until = perf_hooks_1.performance.now() + this.leaseMs * 2; this.activeDeliveries--; });
        }
        const delivered = await entry.result;
        if (frame.kind === 'direct' || frame.kind === 'subscription-check')
            await this.publish(this.topic(frame.source.nodeId, frame.source.instance), {
                v: 1, id: frame.id, source: this.source(), kind: 'receipt', delivered,
            });
    }
    async deliver(frame) {
        if (!await this.ownerAlive(frame.source) || !this.live())
            return false;
        if (frame.kind === 'peer-event') {
            if (typeof frame.message !== 'string' || typeof frame.eventTopic !== 'string')
                return false;
            try {
                this.validateEventTopic(frame.eventTopic);
            }
            catch {
                return false;
            }
            await Promise.all([...this.peerHandlers.get(frame.eventTopic) ?? []].map(handler => handler(frame.message)));
            return true;
        }
        if (frame.kind === 'call-event') {
            if (typeof frame.message !== 'string')
                return false;
            await Promise.all([...this.callHandlers].map(async (handler) => { await handler(frame.message); }));
            return true;
        }
        if (frame.kind === 'direct' || frame.kind === 'subscription-check') {
            if (typeof frame.clientId !== 'string' || typeof frame.generation !== 'string')
                return false;
            const local = this.registrations.get(frame.clientId);
            if (!local || local.registration.generation !== frame.generation || this.current(frame.clientId) !== local.context)
                return false;
            if (frame.kind !== 'subscription-check')
                return this.local.sendToClient(frame.clientId, frame.message);
            if (typeof frame.channel !== 'string' || !frame.channel || Buffer.byteLength(frame.channel) > this.maxBytes)
                return false;
            const shared = this.acquirePeerOperation(frame);
            if (!shared)
                return this.local.isClientSubscribed(frame.clientId, frame.channel);
            try {
                return await this.local.isClientSubscribed(frame.clientId, frame.channel, { scope: shared.scope });
            }
            finally {
                shared.release();
            }
        }
        if (frame.kind === 'channel') {
            if (typeof frame.channel !== 'string' || !frame.channel)
                return false;
            // One authority scope per peer fan-out: the publisher's re-check
            // and this node's recipient checks share it (P6: and, opted in,
            // the same origin operation's subscription probes).
            const shared = this.acquirePeerOperation(frame);
            const scope = shared?.scope ?? (0, authorityScope_1.createAuthorityScope)('fanout');
            try {
                if (frame.publisher) {
                    if (typeof frame.publisher.clientId !== 'string' || typeof frame.publisher.generation !== 'string')
                        return false;
                    const publisher = await this.registration(frame.publisher.clientId);
                    if (!publisher || publisher.instance !== frame.source.instance || publisher.generation !== frame.publisher.generation)
                        return false;
                    // P5: a fresh origin proof replaces ONLY this sender-side
                    // re-check; every local recipient is still authorized below.
                    if (this.opts.authorize && !(0, authorityScope_1.acceptsOriginPublishProof)(frame.publisher.proofAt, this.local.publishProofMaxAgeMs)
                        && !await this.opts.authorize({ kind: 'publish', clientId: frame.publisher.clientId,
                            channel: frame.channel, ctx: publisher.ctx, scope }))
                        return false;
                }
                await this.local.sendToLocalChannel(frame.channel, frame.message, frame.excludeClientId, scope);
            }
            finally {
                if (shared)
                    shared.release();
                else
                    scope.close();
            }
        }
        else
            await this.local.broadcastToAll(frame.message, frame.excludeClientId ?? undefined);
        return true;
    }
    /** P6, origin side: the operation number a peer frame carries, opted in. */
    operationOf(scope) {
        return this.peerLingerMs > 0 && scope?.active ? scope.id : undefined;
    }
    /**
     * P6, peer side: one scope per (origin instance, operation) while any of
     * its frames runs, closed `peerLingerMs` after the last one finishes.
     * Null when off, unnumbered or over the bound (callers then use their
     * own per-frame scope, as before 0.110).
     */
    acquirePeerOperation(frame) {
        if (!(this.peerLingerMs > 0) || typeof frame.op !== 'number' || !Number.isSafeInteger(frame.op) || frame.op < 1)
            return null;
        const key = `${frame.source.instance}:${frame.op}`;
        let entry = this.peerOps.get(key);
        if (!entry || !entry.scope.active) {
            if (this.peerOps.size >= this.maxPending)
                return null;
            entry = { scope: (0, authorityScope_1.createAuthorityScope)(`peer:${frame.kind}`), refs: 0, timer: null };
            this.peerOps.set(key, entry);
        }
        const held = entry;
        if (held.timer) {
            clearTimeout(held.timer);
            held.timer = null;
        }
        held.refs++;
        let released = false;
        return { scope: held.scope, release: () => {
                if (released)
                    return;
                released = true;
                if (--held.refs > 0)
                    return;
                held.timer = setTimeout(() => {
                    if (held.refs > 0)
                        return;
                    if (this.peerOps.get(key) === held)
                        this.peerOps.delete(key);
                    held.scope.close();
                }, this.peerLingerMs);
                held.timer.unref?.();
            } };
    }
    closePeerOps() {
        for (const entry of this.peerOps.values()) {
            if (entry.timer)
                clearTimeout(entry.timer);
            entry.scope.close();
        }
        this.peerOps.clear();
    }
    removeClient(clientId) {
        this.local.removeClient(clientId);
        const entry = this.registrations.get(clientId);
        this.registrations.delete(clientId);
        this.remote.delete(clientId);
        if (!entry)
            return;
        const task = this.opts.redis.command('EVAL', REMOVE, '2', this.clientKey(clientId), this.userKey(entry.context.userId), entry.encoded, clientId)
            .catch(error => this.log.warn('[realtime-cluster] disconnect cleanup failed; registration will expire', error));
        this.cleanup.add(task);
        void task.finally(() => this.cleanup.delete(task));
    }
    async shutdown() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.closePeerOps();
        for (const pending of this.pending.values())
            pending.resolve(false);
        for (const id of this.registrations.keys())
            this.removeClient(id);
        await Promise.all([...this.cleanup]);
        for (const unsubscribe of this.unsubs.splice(0)) {
            try {
                await unsubscribe();
            }
            catch (error) {
                this.log.warn('[realtime-cluster] unsubscribe failed during retirement', error);
            }
        }
        // Stops renewal (awaiting one in flight) and compare-and-deletes the
        // owner key; a failure only logs and the key expires within leaseMs.
        await this.ownership.release();
        this.remote.clear();
        this.seen.clear();
        this.callHandlers.clear();
        this.peerHandlers.clear();
    }
}
exports.RedisRealtimeRouter = RedisRealtimeRouter;
//# sourceMappingURL=RedisRealtimeRouter.js.map