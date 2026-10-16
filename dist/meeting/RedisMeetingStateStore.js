"use strict";
// realtime-modules/src/meeting/RedisMeetingStateStore.ts
//
// Meeting state shared by every gateway replica (0.125.0). One JSON string
// per meeting; writes are a compare-and-set on `version` in a Lua script, so
// two replicas mutating the same meeting never lose an update (the loser
// re-reads and re-applies). The same script publishes the committed state,
// which `watch` delivers to every replica: their lobby mirrors follow, and
// each arms the breakout timer — the first to close wins the compare-and-set
// and the rest find the rooms already closed, so exactly one close commits
// and a replica that dies does not take the timer with it.
//
// The client is injected, like RedisRoomStateStore and RedisCallStateStore:
// node-redis (`sendCommand`), ioredis (`call`/`eval`) or a minimal adapter
// (`command`). Pub/sub needs a SEPARATE subscriber connection with the
// node-redis listener signature; for ioredis pass
// `{ subscribe: (ch, fn) => { sub.on('message', (c, m) => c === ch && fn(m)); return sub.subscribe(ch); } }`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisMeetingStateStore = exports.MEETING_CAS_SCRIPT = void 0;
const types_1 = require("./types");
// KEYS[1] state key. ARGV: json, expected version, ttl seconds, channel ('' = no publish).
// An unreadable stored value counts as no state (version 0), as `get` reads it.
exports.MEETING_CAS_SCRIPT = `-- meeting-state-cas-v1
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then
  local ok, d = pcall(cjson.decode, cur)
  if ok and type(d) == 'table' then v = tonumber(d.version) or 0 end
end
if v ~= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
if ARGV[4] ~= '' then redis.call('PUBLISH', ARGV[4], ARGV[1]) end
return 1`;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
function parse(raw) {
    if (!raw)
        return null;
    try {
        const s = JSON.parse(raw);
        return s && typeof s.meetingId === 'string' && typeof s.version === 'number' ? s : null;
    }
    catch {
        return null;
    }
}
class RedisMeetingStateStore {
    redis;
    shared = true;
    prefix;
    ttlSeconds;
    subscriber;
    watchers = new Set();
    subscribed = false;
    constructor(redis, opts = {}) {
        this.redis = redis;
        if (!redis)
            throw new Error('RedisMeetingStateStore: a redis client is required');
        this.prefix = opts.prefix ?? 'meeting:';
        this.ttlSeconds = Math.max(60, Math.round(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS));
        this.subscriber = opts.subscriber;
    }
    /** The key a meeting's state lives under. */
    key(meetingId) { return `${this.prefix}state:${meetingId}`; }
    /** The channel committed states are published on. */
    get channel() { return `${this.prefix}changed`; }
    async get(meetingId) {
        return parse(await this.redis.get(this.key(meetingId)));
    }
    /** Unconditional write (single-process callers). The service uses `putIfVersion`. */
    async put(state) {
        // Overwrite whatever is there, retrying only if a writer slips in between.
        for (let i = 0; i < 5; i++) {
            const current = await this.get(state.meetingId);
            if (await this.putIfVersion(state, current?.version ?? 0))
                return;
        }
        throw new Error('RedisMeetingStateStore: put kept losing to concurrent writers');
    }
    async putIfVersion(state, expectedVersion) {
        const result = await this.script(exports.MEETING_CAS_SCRIPT, [this.key(state.meetingId)], [
            JSON.stringify(state), expectedVersion, this.ttlSeconds, this.subscriber ? this.channel : '',
        ]);
        return Number(result) === 1;
    }
    async delete(meetingId) {
        await this.redis.del(this.key(meetingId));
    }
    /** Without a `subscriber` there is nothing to listen on: a no-op. */
    watch(onState) {
        if (!this.subscriber)
            return () => undefined;
        this.watchers.add(onState);
        if (!this.subscribed && this.subscriber) {
            this.subscribed = true;
            void Promise.resolve(this.subscriber.subscribe(this.channel, (message) => {
                const state = parse(message);
                if (!state)
                    return;
                for (const w of this.watchers) {
                    try {
                        w((0, types_1.cloneState)(state));
                    }
                    catch { /* a watcher's error is its own */ }
                }
            })).catch(() => { this.subscribed = false; });
        }
        return () => {
            this.watchers.delete(onState);
            if (this.watchers.size === 0 && this.subscribed) {
                this.subscribed = false;
                void Promise.resolve(this.subscriber?.unsubscribe?.(this.channel)).catch(() => undefined);
            }
        };
    }
    async script(script, keys, args) {
        const r = this.redis;
        if (typeof r.sendCommand === 'function')
            return r.sendCommand(['EVAL', script, String(keys.length), ...keys, ...args.map(String)]);
        if (typeof r.call === 'function')
            return r.call('EVAL', script, keys.length, ...keys, ...args);
        if (typeof r.eval === 'function')
            return r.eval(script, keys.length, ...keys, ...args);
        if (typeof r.command === 'function')
            return r.command('EVAL', script, keys.length, ...keys, ...args);
        throw new Error('MeetingStateRedis: compare-and-set requires sendCommand/call/eval/command');
    }
}
exports.RedisMeetingStateStore = RedisMeetingStateStore;
//# sourceMappingURL=RedisMeetingStateStore.js.map