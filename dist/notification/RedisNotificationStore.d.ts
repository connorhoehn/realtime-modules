import type { NotificationRecord, NotificationLogger } from './types';
/**
 * Minimal node-redis (v4, camelCase) surface this store needs. Declared
 * structurally so tests can pass a fake. The production `redisPublisher`
 * (node-redis client) satisfies it directly.
 */
export interface NotificationRedisClient {
    zAdd(key: string, member: {
        score: number;
        value: string;
    }): Promise<unknown>;
    zRange(key: string, start: number, stop: number): Promise<string[]>;
    zCard(key: string): Promise<number>;
    zRemRangeByRank(key: string, start: number, stop: number): Promise<unknown>;
    hSet(key: string, field: string, value: string): Promise<unknown>;
    hGetAll(key: string): Promise<Record<string, string>>;
    expire(key: string, seconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
}
interface RedisNotificationStoreOpts {
    redisClient: NotificationRedisClient | null;
    logger: NotificationLogger;
    /** Defaults to NOTIFICATION_MAX_PER_USER (200). */
    maxPerUser?: number;
    /** Defaults to NOTIFICATION_TTL_SEC (30 days). */
    ttlSec?: number;
    /** Override key prefixes — tests only. */
    listKeyPrefix?: string;
    readKeyPrefix?: string;
}
export declare class RedisNotificationStore {
    private readonly redis;
    private readonly logger;
    private readonly maxPerUser;
    private readonly ttlSec;
    private readonly listKeyPrefix;
    private readonly readKeyPrefix;
    constructor(opts: RedisNotificationStoreOpts);
    private listKey;
    private readKey;
    /**
     * Persist a notification for a user. Adds to the ZSET scored by
     * timestamp, trims to the most-recent `maxPerUser`, and refreshes the
     * TTL. Best-effort — never throws.
     */
    append(userId: string, record: NotificationRecord): Promise<void>;
    /**
     * Return a user's notifications oldest→newest, with `read` reconciled
     * against the read-state hash. Degrades to [] on any transport error.
     */
    list(userId: string): Promise<NotificationRecord[]>;
    /**
     * Return only the user's UNREAD notifications, oldest→newest. Used by the
     * on-connect bulk-update replay so we don't flood freshly-loaded tabs
     * with already-dismissed items.
     */
    listUnread(userId: string): Promise<NotificationRecord[]>;
    /** Read-state hash as a plain { [id]: true } map. [] / {} on error. */
    private readState;
    /** Mark a single notification read. Best-effort — never throws. */
    markRead(userId: string, id: string): Promise<void>;
    /**
     * Mark every currently-stored notification read. Returns the ids that
     * were marked (so the service can echo a `notification:read` per id to
     * the user's other tabs). Best-effort — never throws; returns [] on error.
     */
    markAllRead(userId: string): Promise<string[]>;
}
export {};
//# sourceMappingURL=RedisNotificationStore.d.ts.map