"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisPresenceStore = void 0;
const WRITE = `local old=redis.call('GET',KEYS[1])
if old then local prior=cjson.decode(old); for _,ch in ipairs(prior.channels) do
redis.call('SREM',ARGV[4]..ch,ARGV[1]) end end
local entry=cjson.decode(ARGV[2]); redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3])
for _,ch in ipairs(entry.channels) do local key=ARGV[4]..ch
redis.call('SADD',key,ARGV[1]); redis.call('PEXPIRE',key,ARGV[3]*2) end return 1`;
const REMOVE = `local old=redis.call('GET',KEYS[1]); if not old then return 0 end
local entry=cjson.decode(old); for _,ch in ipairs(entry.channels) do
redis.call('SREM',ARGV[2]..ch,ARGV[1]) end return redis.call('DEL',KEYS[1])`;
const PRUNE = "if redis.call('EXISTS',KEYS[1]) == 0 then return redis.call('SREM',KEYS[2],ARGV[1]) end return 0";
/** Namespace-isolated Redis roster storage. Client IDs must be globally
 * unique for a connection's lifetime, as required by RedisRealtimeRouter.
 * Expired channel-index members are pruned without removing a racing write. */
class RedisPresenceStore {
    redis;
    prefix;
    constructor(redis, namespace) {
        this.redis = redis;
        if (!namespace)
            throw new Error('Presence namespace is required');
        this.prefix = `presence:${encodeURIComponent(namespace)}:`;
    }
    key(clientId) { return `${this.prefix}client:${clientId}`; }
    channel(channel) { return `${this.prefix}channel:${channel}`; }
    async put(entry, ttlMs) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || !entry.clientId || !Array.isArray(entry.channels)) {
            throw new Error('Invalid shared presence entry or TTL');
        }
        await this.redis.command('EVAL', WRITE, '1', this.key(entry.clientId), entry.clientId, JSON.stringify(entry), String(ttlMs), `${this.prefix}channel:`);
    }
    async get(clientId) {
        const raw = await this.redis.command('GET', this.key(clientId));
        if (raw === null)
            return null;
        if (typeof raw !== 'string')
            throw new Error('Invalid shared presence value');
        const entry = JSON.parse(raw);
        if (!entry || entry.clientId !== clientId || !Array.isArray(entry.channels))
            throw new Error('Invalid shared presence identity');
        return entry;
    }
    async list(channel) {
        const ids = await this.redis.command('SMEMBERS', this.channel(channel));
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
            throw new Error('Invalid shared presence index');
        const rows = await Promise.all(ids.map(async (clientId) => {
            const entry = await this.get(clientId);
            if (!entry)
                await this.redis.command('EVAL', PRUNE, '2', this.key(clientId), this.channel(channel), clientId);
            return entry?.channels.includes(channel) ? entry : null;
        }));
        return rows.filter((entry) => entry !== null);
    }
    async remove(clientId) {
        await this.redis.command('EVAL', REMOVE, '1', this.key(clientId), clientId, `${this.prefix}channel:`);
    }
}
exports.RedisPresenceStore = RedisPresenceStore;
//# sourceMappingURL=PresenceStore.js.map