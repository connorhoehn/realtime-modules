// realtime-modules/src/room/RoomStateStore.ts
//
// Redis-backed cross-node member set per room. Two key shapes:
//
//   room:members:<slug>   (ZSET) — member=clientId, score=joinedAtMs.
//                                  ZSET (not SET) so we can iterate by
//                                  join order for "newest first" lists
//                                  without a second lookup.
//
//   room:client:<clientId> (HASH) — per-client metadata pinned for the
//                                   lifetime of the membership:
//                                     - slug
//                                     - userId
//                                     - displayName
//                                     - participantId
//                                     - joinedAt (ms)
//                                   Lets `listMembers(slug)` return a
//                                   single HMGET-fanout shaped result
//                                   without a second roundtrip per
//                                   member to read names.
//
// TTL safety net: 1 hour on both key shapes, refreshed on every write.
// Beyond that, the membership is presumed dead — covers the "node
// OOM'd without firing handleDisconnect" edge case where state would
// otherwise leak forever and inflate occupancy counts.
//
// Two implementations:
//   - InMemoryRoomStateStore: used in tests + when Redis is unavailable.
//   - RedisRoomStateStore: state shared across the cluster + survives
//     restart. Both implement the same RoomStateStore interface.

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
    addMember(
        slug: string,
        clientId: string,
        userId: string,
        displayName: string,
        participantId: string,
    ): Promise<void>;

    /**
     * Remove a member. Idempotent. Returns the post-removal count, or
     * null when the room/member wasn't present.
     */
    removeMember(slug: string, clientId: string): Promise<{ remaining: number } | null>;

    /** All current members of a room, ordered by joinedAt ascending. */
    listMembers(slug: string): Promise<RoomMemberSnapshot[]>;

    /** Headcount only — cheaper than listMembers when names aren't needed. */
    countMembers(slug: string): Promise<number>;

    /**
     * Sidebar index. Returns counts (and a small member preview) for up
     * to N rooms cluster-wide. Capped to avoid SCAN-ing the entire
     * keyspace; the cap is implementation-defined (default 200).
     */
    listAllRoomCounts(limit?: number): Promise<Array<{ slug: string; count: number; members: RoomMemberRecord[] }>>;

    /**
     * Refresh the TTL on a member's hash + the room's sorted-set without
     * mutating membership. Called on heartbeat ticks so long-lived
     * memberships don't reap mid-session.
     */
    touch(slug: string, clientId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + single-node fallback)
// ---------------------------------------------------------------------------

interface InMemoryMember {
    clientId: string;
    userId: string;
    displayName: string;
    participantId: string;
    joinedAt: number;
}

export class InMemoryRoomStateStore implements RoomStateStore {
    private rooms = new Map<string, Map<string, InMemoryMember>>();

    async addMember(slug: string, clientId: string, userId: string, displayName: string, participantId: string): Promise<void> {
        let room = this.rooms.get(slug);
        if (!room) {
            room = new Map();
            this.rooms.set(slug, room);
        }
        const existing = room.get(clientId);
        room.set(clientId, {
            clientId,
            userId,
            displayName,
            participantId,
            joinedAt: existing ? existing.joinedAt : Date.now(),
        });
    }

    async removeMember(slug: string, clientId: string): Promise<{ remaining: number } | null> {
        const room = this.rooms.get(slug);
        if (!room) return null;
        const had = room.delete(clientId);
        if (!had) return { remaining: room.size };
        if (room.size === 0) this.rooms.delete(slug);
        return { remaining: room.size };
    }

    async listMembers(slug: string): Promise<RoomMemberSnapshot[]> {
        const room = this.rooms.get(slug);
        if (!room) return [];
        return Array.from(room.values())
            .sort((a, b) => a.joinedAt - b.joinedAt)
            .map((m) => ({
                clientId: m.clientId,
                userId: m.userId,
                displayName: m.displayName,
                participantId: m.participantId,
                joinedAt: m.joinedAt,
            }));
    }

    async countMembers(slug: string): Promise<number> {
        return this.rooms.get(slug)?.size ?? 0;
    }

    async listAllRoomCounts(limit = 200): Promise<Array<{ slug: string; count: number; members: RoomMemberRecord[] }>> {
        const out: Array<{ slug: string; count: number; members: RoomMemberRecord[] }> = [];
        let n = 0;
        for (const [slug, room] of this.rooms) {
            if (n >= limit) break;
            if (room.size === 0) continue;
            out.push({
                slug,
                count: room.size,
                members: Array.from(room.values()).map((m) => ({
                    userId: m.userId,
                    displayName: m.displayName,
                    participantId: m.participantId,
                })),
            });
            n += 1;
        }
        return out;
    }

    async touch(_slug: string, _clientId: string): Promise<void> {
        // In-memory store has no TTL — no-op.
    }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

// Narrowed interface — only the ops we need so tests can pass a stub
// without dragging in the real client. Matches the surface of the
// gateway's redisPublisher (a node-redis v4 client).
export interface RoomStateRedis {
    zAdd?(key: string, members: { score: number; value: string } | Array<{ score: number; value: string }>): Promise<unknown>;
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
    scan?(cursor: string | number, options?: { MATCH?: string; COUNT?: number }): Promise<{ cursor: string | number; keys: string[] }> | Promise<[string, string[]]>;
}

const ROOM_MEMBERS_PREFIX = 'room:members:';
const ROOM_CLIENT_PREFIX = 'room:client:';
const TTL_SECONDS = 60 * 60; // 1h safety net; refreshed on every write.
const SCAN_BATCH = 100;
const SCAN_MAX_ITERATIONS = 20; // hard cap so listAllRoomCounts can't run forever

export class RedisRoomStateStore implements RoomStateStore {
    constructor(private redis: RoomStateRedis) {}

    private membersKey(slug: string): string { return `${ROOM_MEMBERS_PREFIX}${slug}`; }
    private clientKey(clientId: string): string { return `${ROOM_CLIENT_PREFIX}${clientId}`; }

    private async zAdd(key: string, score: number, value: string): Promise<void> {
        const r: any = this.redis;
        if (typeof r.zAdd === 'function') {
            await r.zAdd(key, { score, value });
            return;
        }
        if (typeof r.zadd === 'function') {
            await r.zadd(key, score, value);
            return;
        }
        throw new Error('RoomStateRedis: zAdd/zadd not available');
    }

    private async zRem(key: string, value: string): Promise<void> {
        const r: any = this.redis;
        if (typeof r.zRem === 'function') {
            await r.zRem(key, value);
            return;
        }
        if (typeof r.zrem === 'function') {
            await r.zrem(key, value);
            return;
        }
        throw new Error('RoomStateRedis: zRem/zrem not available');
    }

    private async zRange(key: string, start: number, stop: number): Promise<string[]> {
        const r: any = this.redis;
        if (typeof r.zRange === 'function') return r.zRange(key, start, stop);
        if (typeof r.zrange === 'function') return r.zrange(key, start, stop);
        throw new Error('RoomStateRedis: zRange/zrange not available');
    }

    private async zCard(key: string): Promise<number> {
        const r: any = this.redis;
        if (typeof r.zCard === 'function') return r.zCard(key);
        if (typeof r.zcard === 'function') return r.zcard(key);
        throw new Error('RoomStateRedis: zCard/zcard not available');
    }

    private async hSet(key: string, fields: Record<string, string>): Promise<void> {
        const r: any = this.redis;
        if (typeof r.hSet === 'function') {
            await r.hSet(key, fields);
            return;
        }
        if (typeof r.hset === 'function') {
            // node-redis legacy / ioredis: flatten or pass an object — try array form
            const flat: string[] = [];
            for (const [k, v] of Object.entries(fields)) { flat.push(k, v); }
            await r.hset(key, ...flat);
            return;
        }
        throw new Error('RoomStateRedis: hSet/hset not available');
    }

    private async hGetAll(key: string): Promise<Record<string, string>> {
        const r: any = this.redis;
        if (typeof r.hGetAll === 'function') return r.hGetAll(key);
        if (typeof r.hgetall === 'function') return r.hgetall(key);
        throw new Error('RoomStateRedis: hGetAll/hgetall not available');
    }

    async addMember(slug: string, clientId: string, userId: string, displayName: string, participantId: string): Promise<void> {
        const now = Date.now();
        const membersKey = this.membersKey(slug);
        const clientKey = this.clientKey(clientId);
        await this.zAdd(membersKey, now, clientId);
        await this.hSet(clientKey, {
            slug,
            userId,
            displayName,
            participantId,
            joinedAt: String(now),
        });
        // Refresh TTL on both keys — set every write so a long-running
        // room without churn stays alive while still being reaped after
        // 1h of total silence (i.e. handleDisconnect was missed).
        await this.redis.expire(membersKey, TTL_SECONDS);
        await this.redis.expire(clientKey, TTL_SECONDS);
    }

    async removeMember(slug: string, clientId: string): Promise<{ remaining: number } | null> {
        const membersKey = this.membersKey(slug);
        const clientKey = this.clientKey(clientId);
        await this.zRem(membersKey, clientId);
        await this.redis.del(clientKey);
        const remaining = await this.zCard(membersKey);
        if (remaining === 0) {
            await this.redis.del(membersKey);
        } else {
            // Refresh TTL on the surviving set so a popular long-lived
            // room doesn't get reaped mid-session.
            await this.redis.expire(membersKey, TTL_SECONDS);
        }
        return { remaining };
    }

    async listMembers(slug: string): Promise<RoomMemberSnapshot[]> {
        const membersKey = this.membersKey(slug);
        const clientIds = await this.zRange(membersKey, 0, -1);
        if (!Array.isArray(clientIds) || clientIds.length === 0) return [];
        const out: RoomMemberSnapshot[] = [];
        for (const cid of clientIds) {
            const hash = await this.hGetAll(this.clientKey(cid));
            if (!hash || !hash.userId) continue; // stale ZSET entry
            out.push({
                clientId: cid,
                userId: hash.userId,
                displayName: hash.displayName ?? '',
                participantId: hash.participantId ?? '',
                joinedAt: Number(hash.joinedAt ?? '0'),
            });
        }
        return out;
    }

    async countMembers(slug: string): Promise<number> {
        return this.zCard(this.membersKey(slug));
    }

    async listAllRoomCounts(limit = 200): Promise<Array<{ slug: string; count: number; members: RoomMemberRecord[] }>> {
        const r: any = this.redis;
        if (typeof r.scan !== 'function') return [];
        const out: Array<{ slug: string; count: number; members: RoomMemberRecord[] }> = [];
        let cursor: string | number = 0;
        let iterations = 0;
        do {
            // node-redis v4: returns { cursor, keys }; ioredis: returns [cursor, keys[]].
            const result: any = await r.scan(cursor, { MATCH: `${ROOM_MEMBERS_PREFIX}*`, COUNT: SCAN_BATCH });
            let keys: string[] = [];
            if (Array.isArray(result)) {
                cursor = result[0];
                keys = result[1] ?? [];
            } else if (result && typeof result === 'object') {
                cursor = result.cursor;
                keys = result.keys ?? [];
            } else {
                break;
            }
            for (const key of keys) {
                if (out.length >= limit) break;
                // Skip composite keys; only top-level "room:members:<slug>"
                // entries qualify. We don't currently emit any composite
                // shape under this prefix but the guard keeps future
                // additions safe.
                const slug = key.slice(ROOM_MEMBERS_PREFIX.length);
                if (!slug || slug.includes(':')) continue;
                const count = await this.zCard(key);
                if (count === 0) continue;
                const members = await this.listMembers(slug);
                out.push({
                    slug,
                    count,
                    members: members.map((m) => ({
                        userId: m.userId,
                        displayName: m.displayName,
                        participantId: m.participantId,
                    })),
                });
            }
            iterations += 1;
            if (iterations >= SCAN_MAX_ITERATIONS) break;
        } while (String(cursor) !== '0' && out.length < limit);
        return out;
    }

    async touch(slug: string, clientId: string): Promise<void> {
        try {
            await this.redis.expire(this.membersKey(slug), TTL_SECONDS);
            await this.redis.expire(this.clientKey(clientId), TTL_SECONDS);
        } catch {
            /* best-effort — touch failures are non-fatal */
        }
    }
}
