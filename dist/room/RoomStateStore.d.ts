import type { RoomMemberRecord } from './types';
/** Detailed snapshot of one member as stored by the state store. */
export interface RoomMemberSnapshot extends RoomMemberRecord {
    clientId: string;
    joinedAt: number;
}
export interface RoomStateStore {
    /**
     * Add a member to a room. Idempotent — repeated calls refresh the
     * metadata + bump the TTL.
     */
    addMember(slug: string, clientId: string, userId: string, displayName: string, participantId: string): Promise<void>;
    /**
     * Remove a member. Idempotent. Returns the post-removal count, or
     * null when the room/member wasn't present.
     */
    removeMember(slug: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    /** All current members of a room, ordered by joinedAt ascending. */
    listMembers(slug: string): Promise<RoomMemberSnapshot[]>;
    /** Headcount only — cheaper than listMembers when names aren't needed. */
    countMembers(slug: string): Promise<number>;
    /**
     * Sidebar index. Returns counts (and a small member preview) for up
     * to N rooms cluster-wide. Capped to avoid SCAN-ing the entire
     * keyspace; the cap is implementation-defined (default 200).
     */
    listAllRoomCounts(limit?: number): Promise<Array<{
        slug: string;
        count: number;
        members: RoomMemberRecord[];
    }>>;
    /**
     * Refresh the TTL on a member's hash + the room's sorted-set without
     * mutating membership. Called on heartbeat ticks so long-lived
     * memberships don't reap mid-session.
     */
    touch(slug: string, clientId: string): Promise<void>;
}
export declare class InMemoryRoomStateStore implements RoomStateStore {
    private rooms;
    addMember(slug: string, clientId: string, userId: string, displayName: string, participantId: string): Promise<void>;
    removeMember(slug: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    listMembers(slug: string): Promise<RoomMemberSnapshot[]>;
    countMembers(slug: string): Promise<number>;
    listAllRoomCounts(limit?: number): Promise<Array<{
        slug: string;
        count: number;
        members: RoomMemberRecord[];
    }>>;
    touch(_slug: string, _clientId: string): Promise<void>;
}
export interface RoomStateRedis {
    zAdd?(key: string, members: {
        score: number;
        value: string;
    } | Array<{
        score: number;
        value: string;
    }>): Promise<unknown>;
    zadd?(key: string, score: number, member: string): Promise<unknown>;
    zRem?(key: string, members: string | string[]): Promise<unknown>;
    zrem?(key: string, member: string): Promise<unknown>;
    zRange?(key: string, start: number, stop: number): Promise<string[]>;
    zrange?(key: string, start: number, stop: number): Promise<string[]>;
    zCard?(key: string): Promise<number>;
    zcard?(key: string): Promise<number>;
    hSet?(key: string, fields: Record<string, string>): Promise<unknown>;
    hset?(key: string, ...args: any[]): Promise<unknown>;
    hGetAll?(key: string): Promise<Record<string, string>>;
    hgetall?(key: string): Promise<Record<string, string>>;
    del(...keys: string[]): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    scan?(cursor: string | number, options?: {
        MATCH?: string;
        COUNT?: number;
    }): Promise<{
        cursor: string | number;
        keys: string[];
    }> | Promise<[string, string[]]>;
}
export declare class RedisRoomStateStore implements RoomStateStore {
    private redis;
    constructor(redis: RoomStateRedis);
    private membersKey;
    private clientKey;
    private zAdd;
    private zRem;
    private zRange;
    private zCard;
    private hSet;
    private hGetAll;
    addMember(slug: string, clientId: string, userId: string, displayName: string, participantId: string): Promise<void>;
    removeMember(slug: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    listMembers(slug: string): Promise<RoomMemberSnapshot[]>;
    countMembers(slug: string): Promise<number>;
    listAllRoomCounts(limit?: number): Promise<Array<{
        slug: string;
        count: number;
        members: RoomMemberRecord[];
    }>>;
    touch(slug: string, clientId: string): Promise<void>;
}
//# sourceMappingURL=RoomStateStore.d.ts.map