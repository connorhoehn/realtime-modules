// An in-memory single-primary Redis for RedisRealtimeRouter contracts. It
// runs the router's own scripts (recognised by text) and distributed-core's
// FencedLease scripts with real PX expiry, delivers pub/sub asynchronously,
// and can hold a command's REPLY after the write has committed (a stall).
import { FENCED_LEASE_SCRIPTS } from 'distributed-core/cluster/leases';
import type { RawRedisConnection } from 'distributed-core/cluster/leases';
import type { RealtimeClusterRedis } from '../../../src/server';

type Entry = { value: string | Set<string>; expiresAt: number | null };
type Hold = { match: (args: string[]) => boolean; reached: () => void; gate: Promise<void> };

export const isRenew = (args: string[]) => args[0] === 'EVAL' && args[1] === FENCED_LEASE_SCRIPTS.RENEW;
export const isAcquire = (args: string[]) => args[0] === 'EVAL' && args[1] === FENCED_LEASE_SCRIPTS.ACQUIRE;
export const isRegister = (args: string[]) => args[0] === 'EVAL' && !!args[1]?.includes("redis.call('EXISTS',KEYS[2])");

export class FakeClusterRedis {
    private readonly data = new Map<string, Entry>();
    private readonly topics = new Map<string, Set<(payload: string) => void>>();
    private readonly holds: Hold[] = [];
    readonly sent: string[][] = [];

    private live(key: string): Entry | undefined {
        const entry = this.data.get(key);
        if (entry && entry.expiresAt !== null && Date.now() >= entry.expiresAt) { this.data.delete(key); return undefined; }
        return entry;
    }
    get(key: string): string | null { const e = this.live(key); return typeof e?.value === 'string' ? e.value : null; }
    members(key: string): string[] { const e = this.live(key); return e && e.value instanceof Set ? [...e.value].sort() : []; }
    pttl(key: string): number {
        const e = this.live(key);
        if (!e) return -2;
        return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
    }
    del(key: string): void { this.data.delete(key); }
    private set(key: string, value: string, px?: number) { this.data.set(key, { value, expiresAt: px ? Date.now() + px : null }); }
    private pexpire(key: string, ms: number) { const e = this.live(key); if (e) e.expiresAt = Date.now() + ms; }
    private sadd(key: string, member: string) {
        const e = this.live(key);
        if (e && e.value instanceof Set) e.value.add(member);
        else this.data.set(key, { value: new Set([member]), expiresAt: null });
    }
    private srem(key: string, member: string): number {
        const e = this.live(key);
        if (!e || !(e.value instanceof Set) || !e.value.delete(member)) return 0;
        if (!e.value.size) this.data.delete(key);
        return 1;
    }

    /** Hold the reply of the next command matching `match` (the write commits first). */
    hold(match: (args: string[]) => boolean): { reached: Promise<void>; release: () => void } {
        let reached!: () => void, release!: () => void;
        const reachedP = new Promise<void>(r => { reached = r; });
        const gate = new Promise<void>(r => { release = r; });
        this.holds.push({ match, reached, gate });
        return { reached: reachedP, release };
    }

    async command(...args: string[]): Promise<unknown> {
        this.sent.push(args);
        const result = this.run(args);
        const index = this.holds.findIndex(h => h.match(args));
        if (index >= 0) { const [h] = this.holds.splice(index, 1); h.reached(); await h.gate; }
        return result;
    }

    private run(args: string[]): unknown {
        const [name, ...rest] = args;
        switch (name) {
        case 'GET': return this.get(rest[0]);
        case 'DEL': { const had = !!this.live(rest[0]); this.data.delete(rest[0]); return had ? 1 : 0; }
        case 'SMEMBERS': return this.members(rest[0]);
        case 'SET': {
            const [key, value, ...opts] = rest;
            const nx = opts.includes('NX');
            const pxAt = opts.indexOf('PX');
            if (nx && this.live(key)) return null;
            this.set(key, value, pxAt >= 0 ? Number(opts[pxAt + 1]) : undefined);
            return 'OK';
        }
        case 'EVAL': return this.eval(rest[0], Number(rest[1]), rest.slice(2, 2 + Number(rest[1])), rest.slice(2 + Number(rest[1])));
        default: throw new Error(`FakeClusterRedis: unsupported ${name}`);
        }
    }

    private eval(script: string, _n: number, keys: string[], argv: string[]): unknown {
        if (script === FENCED_LEASE_SCRIPTS.ACQUIRE) {
            if (this.live(keys[0])) return 0;
            this.set(keys[0], argv[0], Number(argv[1]));
            const next = Number(this.get(keys[1]) ?? '0') + 1;
            this.set(keys[1], String(next));
            return next;
        }
        if (script === FENCED_LEASE_SCRIPTS.RENEW) {
            if (this.get(keys[0]) !== argv[0]) return 0;
            this.pexpire(keys[0], Number(argv[1]));
            let k = 1;
            for (let a = 3; a < argv.length; a += 2) {
                const n = Number(argv[a + 1]);
                if (this.get(keys[k]) === argv[a]) {
                    this.pexpire(keys[k], Number(argv[1]));
                    for (let c = 1; c <= n; c++) this.pexpire(keys[k + c], Number(argv[2]));
                }
                k += 1 + n;
            }
            return 1;
        }
        if (script === FENCED_LEASE_SCRIPTS.RELEASE) {
            if (this.get(keys[0]) !== argv[0]) return 0;
            this.data.delete(keys[0]); return 1;
        }
        if (script.includes("redis.call('EXISTS',KEYS[2])")) { // router REGISTER
            if (this.get(keys[0]) !== argv[0] || this.live(keys[1])) return 0;
            this.set(keys[1], argv[1], Number(argv[2])); this.sadd(keys[2], argv[3]); this.pexpire(keys[2], Number(argv[2]) * 2);
            return 1;
        }
        if (script.includes("redis.call('SREM',KEYS[2],ARGV[2])")) { // router REMOVE
            if (this.get(keys[0]) !== argv[0]) return 0;
            this.data.delete(keys[0]); this.srem(keys[1], argv[1]); return 1;
        }
        if (script.includes("redis.call('EXISTS',KEYS[1]) == 0")) { // router PRUNE
            return this.live(keys[0]) ? 0 : this.srem(keys[1], argv[0]);
        }
        throw new Error('FakeClusterRedis: unknown script');
    }

    async publish(topic: string, payload: string): Promise<number> {
        const handlers = [...this.topics.get(topic) ?? []];
        setImmediate(() => { for (const h of handlers) h(payload); });
        return handlers.length;
    }
    subscribeRaw(topic: string, receive: (payload: string) => void): () => void {
        const set = this.topics.get(topic) ?? new Set(); set.add(receive); this.topics.set(topic, set);
        return () => { set.delete(receive); };
    }
    subscribers(topic: string): number { return this.topics.get(topic)?.size ?? 0; }

    /** A RealtimeClusterRedis port with a fireable connection-loss signal. */
    port(): RealtimeClusterRedis & { lose(): void; handlers(): number } {
        const lost = new Set<() => void>();
        return {
            command: (...args) => this.command(...args),
            publish: (topic, payload) => this.publish(topic, payload),
            subscribe: async (topic, receive) => this.subscribeRaw(topic, receive),
            onUnavailable: handler => { lost.add(handler); return () => { lost.delete(handler); }; },
            lose: () => { for (const h of [...lost]) h(); },
            handlers: () => lost.size,
        };
    }

    /** node-redis-shaped connections for distributed-core's BoundedRedis. `stall` holds replies on that role. */
    rawConnection(stall: { command?: (args: string[]) => boolean; publish?: boolean }): RawRedisConnection & { destroyed: boolean } {
        const events = new Map<string, Array<(...a: unknown[]) => void>>();
        const unsub = new Map<string, () => void>();
        const conn = {
            destroyed: false, isOpen: true, isReady: true,
            connect: async () => undefined,
            sendCommand: async (args: string[]) => {
                if (stall.command?.(args)) { this.run(args); return new Promise<unknown>(() => undefined); }
                return this.command(...args);
            },
            publish: async (channel: string, message: string) => stall.publish ? new Promise<number>(() => undefined) : this.publish(channel, message),
            subscribe: async (channel: string, listener: (message: string, channel: string) => void) => {
                unsub.set(channel, this.subscribeRaw(channel, payload => { if (!conn.destroyed) listener(payload, channel); }));
            },
            unsubscribe: async (channel: string) => { unsub.get(channel)?.(); unsub.delete(channel); },
            destroy: () => {
                if (conn.destroyed) return;
                conn.destroyed = true; conn.isOpen = false; conn.isReady = false;
                for (const h of events.get('end') ?? []) h();
            },
            on: (event: string, handler: (...a: unknown[]) => void) => { events.set(event, [...events.get(event) ?? [], handler]); return conn; },
        };
        return conn;
    }
}
