"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisRealtimeRouter = void 0;
const crypto_1 = require("crypto");
const perf_hooks_1 = require("perf_hooks");
const router_1 = require("./router");
const NOOP_LOGGER = { debug() { }, info() { }, warn() { }, error() { } };
const RELEASE = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const REGISTER = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); redis.call('SADD',KEYS[3],ARGV[4]);
redis.call('PEXPIRE',KEYS[3],ARGV[3]*2); return 1`;
const REMOVE = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL',KEYS[1]); redis.call('SREM',KEYS[2],ARGV[2]); return 1`;
const PRUNE = "if redis.call('EXISTS',KEYS[1]) == 0 then return redis.call('SREM',KEYS[2],ARGV[1]) end return 0";
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
    deadline = 0;
    stopped = false;
    started = false;
    fenced = false;
    timer = null;
    renewing = null;
    unsubs = [];
    registrations = new Map();
    remote = new Map();
    pending = new Map();
    seen = new Map();
    activeDeliveries = 0;
    cleanup = new Set();
    callHandlers = new Set();
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
        if (![this.leaseMs, this.timeoutMs, this.maxBytes, this.maxPending, this.maxSeen].every(n => Number.isSafeInteger(n) && n > 0)
            || this.leaseMs < 300 || this.timeoutMs >= this.leaseMs)
            throw new Error('Invalid cluster bounds');
        this.log = opts.logger ?? NOOP_LOGGER;
        this.local = new router_1.LocalRealtimeRouter({ authorize: opts.authorize, filterClientMessage: opts.filterClientMessage,
            plugins: opts.plugins, logger: this.log });
    }
    nodeKey(nodeId = this.nodeId) { return `${this.prefix}node:${encodeURIComponent(nodeId)}`; }
    clientKey(clientId) { return `${this.prefix}client:${encodeURIComponent(clientId)}`; }
    userKey(userId) { return `${this.prefix}user:${encodeURIComponent(userId)}`; }
    topic(nodeId = this.nodeId, instance = this.instance) { return `${this.prefix}direct:${encodeURIComponent(nodeId)}:${instance}`; }
    live() {
        if (this.started && perf_hooks_1.performance.now() >= this.deadline)
            this.fenced = true;
        return this.started && !this.stopped && !this.fenced;
    }
    source() { return { nodeId: this.nodeId, instance: this.instance }; }
    current(clientId) { return this.handle?.getClientContext(clientId) ?? null; }
    validSource(source) {
        const value = source;
        return !!value && typeof value.nodeId === 'string' && !!value.nodeId && typeof value.instance === 'string' && !!value.instance;
    }
    async ownerAlive(source) {
        return await this.opts.redis.command('GET', this.nodeKey(source.nodeId)) === source.instance;
    }
    async start() {
        if (this.started || this.stopped)
            throw new Error('Cluster router cannot be started twice');
        const before = perf_hooks_1.performance.now();
        const claimed = await this.opts.redis.command('SET', this.nodeKey(), this.instance, 'NX', 'PX', String(this.leaseMs));
        if (claimed !== 'OK')
            throw new Error('Cluster nodeId already has a live owner');
        this.deadline = before + this.leaseMs;
        try {
            for (const topic of [this.topic(), `${this.prefix}channels`, `${this.prefix}broadcast`, `${this.prefix}call-events`]) {
                this.unsubs.push(await this.opts.redis.subscribe(topic, payload => {
                    void this.receive(payload).catch(error => this.log.warn('[realtime-cluster] peer delivery failed', error));
                }));
            }
            if (perf_hooks_1.performance.now() >= this.deadline)
                throw new Error('Cluster startup exceeded its ownership lease');
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
    async renew() {
        if (this.stopped || this.fenced)
            return;
        if (!this.live())
            throw new Error('Cluster ownership lease expired');
        const current = [...this.registrations].filter(([id, entry]) => this.current(id) === entry.context);
        const keys = [this.nodeKey(), ...current.flatMap(([id, entry]) => [this.clientKey(id), this.userKey(entry.context.userId)])];
        const before = perf_hooks_1.performance.now();
        const previousDeadline = this.deadline;
        const renewed = await this.opts.redis.command('EVAL', RENEW, String(keys.length), ...keys, this.instance, String(this.leaseMs), ...current.map(([, entry]) => entry.encoded));
        if (renewed !== 1 || this.fenced || perf_hooks_1.performance.now() >= previousDeadline)
            throw new Error('Cluster ownership lease lost');
        this.deadline = before + this.leaseMs;
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
        const id = (0, crypto_1.randomUUID)();
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            const finish = (delivered) => { clearTimeout(timer); this.pending.delete(id); resolve(delivered); };
            this.pending.set(id, { target, resolve: finish });
            void this.publish(this.topic(target.nodeId, target.instance), {
                v: 1, id, source: this.source(), kind: 'direct', clientId, generation: target.generation, message,
            }).catch(() => finish(false));
        });
    }
    sendToLocalClient(clientId, message) {
        return this.live() ? this.local.sendToLocalClient(clientId, message) : false;
    }
    hasChannelAuthorize() { return this.local.hasChannelAuthorize(); }
    checkChannel(kind, clientId, channel, opts) {
        return this.live() ? this.local.checkChannel(kind, clientId, channel, opts) : false;
    }
    subscribeToChannel(clientId, channel, opts) {
        return this.live() ? this.local.subscribeToChannel(clientId, channel, opts) : false;
    }
    unsubscribeFromChannel(clientId, channel) { this.local.unsubscribeFromChannel(clientId, channel); }
    async sendToChannel(channel, message, excludeClientId, opts) {
        if (!this.live())
            throw new Error('Cluster routing is not ready');
        const publisherId = opts?.publisherClientId ?? null;
        const ctx = publisherId ? this.current(publisherId) : null;
        if (publisherId && (!ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true })))
            return;
        await this.local.sendToChannel(channel, message, excludeClientId, opts);
        if (publisherId && (this.current(publisherId) !== ctx || !await this.checkChannel('publish', publisherId, channel, { silent: true })))
            return;
        const registration = publisherId ? this.registrations.get(publisherId)?.registration : null;
        if (publisherId && !registration)
            return;
        await this.publish(`${this.prefix}channels`, { v: 1, id: (0, crypto_1.randomUUID)(), source: this.source(), kind: 'channel',
            channel, message, excludeClientId, ...(publisherId ? { publisher: { clientId: publisherId, generation: registration.generation } } : {}) });
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
        if (!['direct', 'channel', 'broadcast', 'call-event'].includes(frame.kind))
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
        if (frame.kind === 'direct')
            await this.publish(this.topic(frame.source.nodeId, frame.source.instance), {
                v: 1, id: frame.id, source: this.source(), kind: 'receipt', delivered,
            });
    }
    async deliver(frame) {
        if (!await this.ownerAlive(frame.source) || !this.live())
            return false;
        if (frame.kind === 'call-event') {
            if (typeof frame.message !== 'string')
                return false;
            await Promise.all([...this.callHandlers].map(async (handler) => { await handler(frame.message); }));
            return true;
        }
        if (frame.kind === 'direct') {
            if (typeof frame.clientId !== 'string' || typeof frame.generation !== 'string')
                return false;
            const local = this.registrations.get(frame.clientId);
            if (!local || local.registration.generation !== frame.generation || this.current(frame.clientId) !== local.context)
                return false;
            return this.local.sendToClient(frame.clientId, frame.message);
        }
        if (frame.kind === 'channel') {
            if (typeof frame.channel !== 'string' || !frame.channel)
                return false;
            if (frame.publisher) {
                if (typeof frame.publisher.clientId !== 'string' || typeof frame.publisher.generation !== 'string')
                    return false;
                const publisher = await this.registration(frame.publisher.clientId);
                if (!publisher || publisher.instance !== frame.source.instance || publisher.generation !== frame.publisher.generation)
                    return false;
                if (this.opts.authorize && !await this.opts.authorize({ kind: 'publish', clientId: frame.publisher.clientId,
                    channel: frame.channel, ctx: publisher.ctx }))
                    return false;
            }
            await this.local.sendToLocalChannel(frame.channel, frame.message, frame.excludeClientId);
        }
        else
            await this.local.broadcastToAll(frame.message, frame.excludeClientId ?? undefined);
        return true;
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
        this.deadline = 0;
        if (this.timer)
            clearInterval(this.timer);
        for (const pending of this.pending.values())
            pending.resolve(false);
        for (const id of this.registrations.keys())
            this.removeClient(id);
        await this.renewing;
        await Promise.all([...this.cleanup]);
        for (const unsubscribe of this.unsubs.splice(0))
            await unsubscribe();
        await this.opts.redis.command('EVAL', RELEASE, '1', this.nodeKey(), this.instance);
        this.remote.clear();
        this.seen.clear();
        this.callHandlers.clear();
    }
}
exports.RedisRealtimeRouter = RedisRealtimeRouter;
//# sourceMappingURL=RedisRealtimeRouter.js.map