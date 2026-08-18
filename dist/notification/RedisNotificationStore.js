"use strict";
// realtime-modules/src/notification/RedisNotificationStore.ts
//
// Redis-backed persistence for user-scoped notifications.
//
// WHY Redis (not DDB): notifications are inherently recent-window data — a
// per-user inbox capped at the most-recent N entries with a rolling TTL.
// This is the exact shape the activity-feed history store already persists
// in Redis (RedisActivityHistoryStore: LPUSH + LTRIM + EXPIRE), so we follow
// that precedent rather than standing up a new DDB table this wave.
//
// Key shape (load-bearing — operator dashboards + tests assume these):
//
//   notif:list:<userId>   ZSET  — member = JSON(NotificationRecord),
//                                  score  = timestamp (ms since epoch).
//                                  Kept ordered oldest→newest. Capped to
//                                  NOTIFICATION_MAX_PER_USER via
//                                  ZREMRANGEBYRANK after every add. TTL
//                                  refreshed to NOTIFICATION_TTL_SEC on
//                                  every write.
//
//   notif:read:<userId>   HASH  — field = notificationId, value = '1' for
//                                  every notification the user has marked
//                                  read. Same TTL as the list. Read-state is
//                                  kept separate from the list so markRead is
//                                  a single HSET and never has to rewrite a
//                                  ZSET member.
//
// Behavioural parity with RedisActivityHistoryStore:
//   - All writes are best-effort: transport errors are logged + swallowed,
//     never thrown into the service handler.
//   - A null redisClient turns the store into a no-op (writes silently drop,
//     reads return []). Single-node / no-Redis dev keeps working — delivery
//     to live tabs still happens; only persistence + replay degrade.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisNotificationStore = void 0;
const constants_1 = require("./constants");
const LIST_KEY_PREFIX = 'notif:list:';
const READ_KEY_PREFIX = 'notif:read:';
class RedisNotificationStore {
    redis;
    logger;
    maxPerUser;
    ttlSec;
    listKeyPrefix;
    readKeyPrefix;
    constructor(opts) {
        if (!opts || !opts.logger) {
            throw new Error('RedisNotificationStore: logger is required');
        }
        this.redis = opts.redisClient ?? null;
        this.logger = opts.logger;
        this.maxPerUser = opts.maxPerUser ?? constants_1.NOTIFICATION_MAX_PER_USER;
        this.ttlSec = opts.ttlSec ?? constants_1.NOTIFICATION_TTL_SEC;
        this.listKeyPrefix = opts.listKeyPrefix ?? LIST_KEY_PREFIX;
        this.readKeyPrefix = opts.readKeyPrefix ?? READ_KEY_PREFIX;
    }
    listKey(userId) {
        return `${this.listKeyPrefix}${userId}`;
    }
    readKey(userId) {
        return `${this.readKeyPrefix}${userId}`;
    }
    /**
     * Persist a notification for a user. Adds to the ZSET scored by
     * timestamp, trims to the most-recent `maxPerUser`, and refreshes the
     * TTL. Best-effort — never throws.
     */
    async append(userId, record) {
        if (!this.redis)
            return;
        const key = this.listKey(userId);
        try {
            const score = toScore(record.timestamp);
            await this.redis.zAdd(key, { score, value: JSON.stringify(record) });
            // Trim: keep only the highest-scored (newest) maxPerUser members.
            // Removing rank range [0, -(max+1)] drops everything older than
            // the last `max` entries. No-op when card <= max.
            await this.redis.zRemRangeByRank(key, 0, -(this.maxPerUser + 1));
            await this.redis.expire(key, this.ttlSec);
        }
        catch (err) {
            this.logger.error('[notification] failed to persist notification', {
                userId,
                id: record.id,
                errorMessage: err && err.message,
            });
        }
    }
    /**
     * Return a user's notifications oldest→newest, with `read` reconciled
     * against the read-state hash. Degrades to [] on any transport error.
     */
    async list(userId) {
        if (!this.redis)
            return [];
        const key = this.listKey(userId);
        try {
            const [members, readMap] = await Promise.all([
                this.redis.zRange(key, 0, -1), // ascending by score = oldest→newest
                this.readState(userId),
            ]);
            const out = [];
            for (const raw of members) {
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed || typeof parsed.id !== 'string')
                        continue;
                    out.push(readMap[parsed.id] ? { ...parsed, read: true } : parsed);
                }
                catch {
                    // Drop unparsable entries silently — matches the
                    // activity-store `.filter(Boolean)` precedent.
                }
            }
            return out;
        }
        catch (err) {
            this.logger.error('[notification] failed to list notifications', {
                userId,
                errorMessage: err && err.message,
            });
            return [];
        }
    }
    /**
     * Return only the user's UNREAD notifications, oldest→newest. Used by the
     * on-connect bulk-update replay so we don't flood freshly-loaded tabs
     * with already-dismissed items.
     */
    async listUnread(userId) {
        const all = await this.list(userId);
        return all.filter((n) => !n.read);
    }
    /** Read-state hash as a plain { [id]: true } map. [] / {} on error. */
    async readState(userId) {
        if (!this.redis)
            return {};
        try {
            const hash = await this.redis.hGetAll(this.readKey(userId));
            const map = {};
            for (const id of Object.keys(hash ?? {}))
                map[id] = true;
            return map;
        }
        catch (err) {
            this.logger.error('[notification] failed to read notification read-state', {
                userId,
                errorMessage: err && err.message,
            });
            return {};
        }
    }
    /** Mark a single notification read. Best-effort — never throws. */
    async markRead(userId, id) {
        if (!this.redis)
            return;
        const key = this.readKey(userId);
        try {
            await this.redis.hSet(key, id, '1');
            await this.redis.expire(key, this.ttlSec);
        }
        catch (err) {
            this.logger.error('[notification] failed to mark notification read', {
                userId,
                id,
                errorMessage: err && err.message,
            });
        }
    }
    /**
     * Mark every currently-stored notification read. Returns the ids that
     * were marked (so the service can echo a `notification:read` per id to
     * the user's other tabs). Best-effort — never throws; returns [] on error.
     */
    async markAllRead(userId) {
        if (!this.redis)
            return [];
        const records = await this.list(userId);
        const ids = records.map((n) => n.id);
        if (ids.length === 0)
            return [];
        const key = this.readKey(userId);
        try {
            for (const id of ids) {
                await this.redis.hSet(key, id, '1');
            }
            await this.redis.expire(key, this.ttlSec);
        }
        catch (err) {
            this.logger.error('[notification] failed to mark all notifications read', {
                userId,
                errorMessage: err && err.message,
            });
            return [];
        }
        return ids;
    }
}
exports.RedisNotificationStore = RedisNotificationStore;
/**
 * Map an ISO timestamp to a numeric ZSET score (ms since epoch). Falls back
 * to Date.now() when the timestamp is missing/unparsable so ordering stays
 * monotonic-ish rather than throwing.
 */
function toScore(timestamp) {
    if (!timestamp)
        return Date.now();
    const t = Date.parse(timestamp);
    return Number.isNaN(t) ? Date.now() : t;
}
//# sourceMappingURL=RedisNotificationStore.js.map