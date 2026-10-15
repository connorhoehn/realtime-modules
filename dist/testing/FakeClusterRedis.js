"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeClusterRedis = exports.isRegister = exports.isAcquire = exports.isRenew = void 0;
// @connorhoehn/realtime-modules/testing: an in-memory single-primary Redis for
// RedisRealtimeRouter contracts, with stall injection (`hold`), connection
// loss (`port().lose()`) and BoundedRedis connections (`rawConnection`).
// Lease expiry uses Date.now(), so jest fake timers move it.
//
// Was test/server/helpers/fakeClusterRedis.ts (now re-exported from here).
// Original description: It
// runs the router's own scripts (recognised by text) and distributed-core's
// FencedLease scripts with real PX expiry, delivers pub/sub asynchronously,
// and can hold a command's REPLY after the write has committed (a stall).
const leases_1 = require("distributed-core/cluster/leases");
const isRenew = (args) => args[0] === 'EVAL' && args[1] === leases_1.FENCED_LEASE_SCRIPTS.RENEW;
exports.isRenew = isRenew;
const isAcquire = (args) => args[0] === 'EVAL' && args[1] === leases_1.FENCED_LEASE_SCRIPTS.ACQUIRE;
exports.isAcquire = isAcquire;
const isRegister = (args) => args[0] === 'EVAL' && !!args[1]?.includes("redis.call('EXISTS',KEYS[2])");
exports.isRegister = isRegister;
class FakeClusterRedis {
    data = new Map();
    topics = new Map();
    holds = [];
    sent = [];
    live(key) {
        const entry = this.data.get(key);
        if (entry && entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
            this.data.delete(key);
            return undefined;
        }
        return entry;
    }
    get(key) { const e = this.live(key); return typeof e?.value === 'string' ? e.value : null; }
    members(key) { const e = this.live(key); return e && e.value instanceof Set ? [...e.value].sort() : []; }
    pttl(key) {
        const e = this.live(key);
        if (!e)
            return -2;
        return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
    }
    del(key) { this.data.delete(key); }
    set(key, value, px) { this.data.set(key, { value, expiresAt: px ? Date.now() + px : null }); }
    pexpire(key, ms) { const e = this.live(key); if (e)
        e.expiresAt = Date.now() + ms; }
    sadd(key, member) {
        const e = this.live(key);
        if (e && e.value instanceof Set)
            e.value.add(member);
        else
            this.data.set(key, { value: new Set([member]), expiresAt: null });
    }
    srem(key, member) {
        const e = this.live(key);
        if (!e || !(e.value instanceof Set) || !e.value.delete(member))
            return 0;
        if (!e.value.size)
            this.data.delete(key);
        return 1;
    }
    /** Hold the reply of the next command matching `match` (the write commits first). */
    hold(match) {
        let reached, release;
        const reachedP = new Promise(r => { reached = r; });
        const gate = new Promise(r => { release = r; });
        this.holds.push({ match, reached, gate });
        return { reached: reachedP, release };
    }
    async command(...args) {
        this.sent.push(args);
        const result = this.run(args);
        const index = this.holds.findIndex(h => h.match(args));
        if (index >= 0) {
            const [h] = this.holds.splice(index, 1);
            h.reached();
            await h.gate;
        }
        return result;
    }
    run(args) {
        const [name, ...rest] = args;
        switch (name) {
            case 'GET': return this.get(rest[0]);
            case 'DEL': {
                const had = !!this.live(rest[0]);
                this.data.delete(rest[0]);
                return had ? 1 : 0;
            }
            case 'SMEMBERS': return this.members(rest[0]);
            case 'SET': {
                const [key, value, ...opts] = rest;
                const nx = opts.includes('NX');
                const pxAt = opts.indexOf('PX');
                if (nx && this.live(key))
                    return null;
                this.set(key, value, pxAt >= 0 ? Number(opts[pxAt + 1]) : undefined);
                return 'OK';
            }
            case 'EVAL': return this.eval(rest[0], Number(rest[1]), rest.slice(2, 2 + Number(rest[1])), rest.slice(2 + Number(rest[1])));
            default: throw new Error(`FakeClusterRedis: unsupported ${name}`);
        }
    }
    eval(script, _n, keys, argv) {
        if (script === leases_1.FENCED_LEASE_SCRIPTS.ACQUIRE) {
            if (this.live(keys[0]))
                return 0;
            this.set(keys[0], argv[0], Number(argv[1]));
            const next = Number(this.get(keys[1]) ?? '0') + 1;
            this.set(keys[1], String(next));
            return next;
        }
        if (script === leases_1.FENCED_LEASE_SCRIPTS.RENEW) {
            if (this.get(keys[0]) !== argv[0])
                return 0;
            this.pexpire(keys[0], Number(argv[1]));
            let k = 1;
            for (let a = 3; a < argv.length; a += 2) {
                const n = Number(argv[a + 1]);
                if (this.get(keys[k]) === argv[a]) {
                    this.pexpire(keys[k], Number(argv[1]));
                    for (let c = 1; c <= n; c++)
                        this.pexpire(keys[k + c], Number(argv[2]));
                }
                k += 1 + n;
            }
            return 1;
        }
        if (script === leases_1.FENCED_LEASE_SCRIPTS.RELEASE) {
            if (this.get(keys[0]) !== argv[0])
                return 0;
            this.data.delete(keys[0]);
            return 1;
        }
        if (script.includes("redis.call('EXISTS',KEYS[2])")) { // router REGISTER
            if (this.get(keys[0]) !== argv[0] || this.live(keys[1]))
                return 0;
            this.set(keys[1], argv[1], Number(argv[2]));
            this.sadd(keys[2], argv[3]);
            this.pexpire(keys[2], Number(argv[2]) * 2);
            return 1;
        }
        if (script.includes("redis.call('SREM',KEYS[2],ARGV[2])")) { // router REMOVE
            if (this.get(keys[0]) !== argv[0])
                return 0;
            this.data.delete(keys[0]);
            this.srem(keys[1], argv[1]);
            return 1;
        }
        if (script.includes("redis.call('EXISTS',KEYS[1]) == 0")) { // router PRUNE
            return this.live(keys[0]) ? 0 : this.srem(keys[1], argv[0]);
        }
        throw new Error('FakeClusterRedis: unknown script');
    }
    async publish(topic, payload) {
        const handlers = [...this.topics.get(topic) ?? []];
        setImmediate(() => { for (const h of handlers)
            h(payload); });
        return handlers.length;
    }
    subscribeRaw(topic, receive) {
        const set = this.topics.get(topic) ?? new Set();
        set.add(receive);
        this.topics.set(topic, set);
        return () => { set.delete(receive); };
    }
    subscribers(topic) { return this.topics.get(topic)?.size ?? 0; }
    /** A RealtimeClusterRedis port with a fireable connection-loss signal. */
    port() {
        const lost = new Set();
        return {
            command: (...args) => this.command(...args),
            publish: (topic, payload) => this.publish(topic, payload),
            subscribe: async (topic, receive) => this.subscribeRaw(topic, receive),
            onUnavailable: handler => { lost.add(handler); return () => { lost.delete(handler); }; },
            lose: () => { for (const h of [...lost])
                h(); },
            handlers: () => lost.size,
        };
    }
    /** node-redis-shaped connections for distributed-core's BoundedRedis. `stall` holds replies on that role. */
    rawConnection(stall) {
        const events = new Map();
        const unsub = new Map();
        const conn = {
            destroyed: false, isOpen: true, isReady: true,
            connect: async () => undefined,
            sendCommand: async (args) => {
                if (stall.command?.(args)) {
                    this.run(args);
                    return new Promise(() => undefined);
                }
                return this.command(...args);
            },
            publish: async (channel, message) => stall.publish ? new Promise(() => undefined) : this.publish(channel, message),
            subscribe: async (channel, listener) => {
                unsub.set(channel, this.subscribeRaw(channel, payload => { if (!conn.destroyed)
                    listener(payload, channel); }));
            },
            unsubscribe: async (channel) => { unsub.get(channel)?.(); unsub.delete(channel); },
            destroy: () => {
                if (conn.destroyed)
                    return;
                conn.destroyed = true;
                conn.isOpen = false;
                conn.isReady = false;
                for (const h of events.get('end') ?? [])
                    h();
            },
            on: (event, handler) => { events.set(event, [...events.get(event) ?? [], handler]); return conn; },
        };
        return conn;
    }
}
exports.FakeClusterRedis = FakeClusterRedis;
//# sourceMappingURL=FakeClusterRedis.js.map