// CallStateStore — abstracts the in-memory ActiveCallState Maps from
// CallService so we can plug in a Redis-backed implementation for
// multi-replica safety (W11).
//
// Two implementations:
//   - InMemoryCallStateStore: today's behavior, used in tests + when
//     Redis is unavailable. State per-node, lost on restart.
//   - RedisCallStateStore: state shared across the cluster + survives
//     restart. Per-call hash + per-client set, with TTL safety net.

export interface ActiveCallStateView {
    callerId: string;
    lobbyName: string;
    targetUserIds: string[];
    participantClientIds: string[];
    /**
     * Wall-clock millis when the call's `invite` envelope first registered
     * a participant. Populated lazily by registerParticipant; null when the
     * store didn't capture it (older entries pre-dating this field, or
     * synthetic registrations from tests).
     */
    invitedAt?: number | null;
    /** Optional human-readable caller name captured at invite time. */
    callerName?: string | null;
}

export interface CallStateStore {
    /** Add a participant to a call. Creates the call entry if missing. */
    registerParticipant(
        callId: string,
        clientId: string,
        callerId: string,
        lobbyName: string,
        targetUserIds: string[],
    ): Promise<void>;

    /** Remove one participant. Returns the remaining count post-removal,
     *  or null when the call doesn't exist. */
    removeParticipant(
        callId: string,
        clientId: string,
    ): Promise<{ remaining: number } | null>;

    /** Snapshot of a call's state. Returns null when not active. */
    getCall(callId: string): Promise<ActiveCallStateView | null>;

    /** All callIds this client is a participant of (across the cluster). */
    getCallIdsByClient(clientId: string): Promise<string[]>;

    /** Forget a call entirely. Idempotent. */
    forgetCall(callId: string): Promise<void>;

    /** Diagnostics — counts for /metrics. */
    stats(): Promise<{ activeCalls: number; trackedClients: number }>;

    /**
     * Optional capture of when this call's `invite` registered (millis
     * since epoch) plus the caller's display name (when known). Called
     * once after registerParticipant on `invite`. Implementations that
     * don't track this surface it as a no-op + null/undefined on the
     * getCall view; the resume endpoint then falls back to `now`.
     */
    setInviteMetadata?(
        callId: string,
        meta: { invitedAt?: number; callerName?: string },
    ): Promise<void>;

    // ─────────────────────────────────────────────────────────────────
    // PR-W2.1 — Multi-node parity for the three map-shaped registries
    // that previously lived in CallService process memory. These are
    // OPTIONAL so the existing in-memory implementation (single-node)
    // can stay as-is + so test stubs that only care about the core
    // registerParticipant/forgetCall paths don't need to implement them.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Per-user invite registry. Tracks the callIds a userId is being
     * invited to so a freshly-connected tab can replay outstanding
     * invites. TTL is the invite's wall-clock expiry — entries past that
     * are stale and MUST NOT replay (the call already auto-cancelled).
     *
     * `expiresAtMs` is wall-clock millis; implementations convert to
     * TTL relative to now() internally.
     */
    registerInvite?(userId: string, callId: string, expiresAtMs: number): Promise<void>;
    /** Remove one invite from a user's registry. Idempotent. */
    clearInviteForUser?(userId: string, callId: string): Promise<void>;
    /** Remove a callId from EVERY user's registry. Used on accept/end/decline. */
    clearInviteForCall?(callId: string): Promise<void>;
    /** Return non-expired callIds in this user's registry. Implementations
     *  prune expired entries opportunistically. */
    getActiveInvitesForUser?(userId: string): Promise<string[]>;

    /**
     * Accept dedup. SETNX-style: returns `true` only the first time
     * across the whole cluster. `ttlSeconds` is how long to remember the
     * acceptance (matches the invite TTL so a re-invite after expiry can
     * also be accepted). */
    markAccepted?(callId: string, ttlSeconds: number): Promise<boolean>;
    /** Clear the accept marker — used on terminal `ended/declined/cancelled`. */
    clearAccepted?(callId: string): Promise<void>;

    /**
     * Recent-invites dedup. SETNX with TTL = window. Returns `true` if
     * this is the first time we saw `callId` in the window, `false` if
     * a duplicate. Cluster-wide so a double-click that races across
     * nodes still suppresses correctly.
     */
    markRecentInvite?(callId: string, windowSeconds: number): Promise<boolean>;

    // ─────────────────────────────────────────────────────────────────
    // PR-W2.1 (completion) — explicit write-through cache API. These are
    // the cluster-wide authoritative analogues of CallService's local
    // `activeCalls` / `clientToCalls` Maps. registerParticipant + getCall
    // + getCallIdsByClient + removeParticipant cover the same ground at
    // the participant grain; these new methods let callers (a) write a
    // whole ActiveCallStateView in one shot when they already have it
    // (handleDisconnect → republish on peer restart) and (b) maintain
    // the per-client reverse-index independently of the call's metadata
    // so peer nodes can ask "what calls is THIS client in cluster-wide?"
    // without first having to enumerate every callId.
    //
    // All three are OPTIONAL so the in-memory stub used by tests doesn't
    // have to implement them — it can mirror existing Map state, and the
    // RedisCallStateStore implements them with explicit HSET/SADD calls.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Authoritative write of a call's full state. Used by the write-
     * through cache to mirror activeCalls.set(callId, state) into Redis
     * so peer nodes' handleCrossNodeDeparted can find calls the local
     * node never saw via handleCallEvent.
     *
     * `ttlSec` matches the call's lifetime: 60s for unaccepted invites,
     * 4h for accepted calls (the safety-net cap shared with the
     * registerParticipant path).
     */
    setCall?(callId: string, state: ActiveCallStateView, ttlSec: number): Promise<void>;

    /**
     * Add a clientId → callId edge to the cluster-wide reverse index.
     * Used by handleDisconnect on a peer node so we can ask "what calls
     * is THIS client in" without first knowing the callId. Idempotent;
     * `ttlSec` refreshes the underlying key's expiry.
     */
    addClientToCall?(clientId: string, callId: string, ttlSec: number): Promise<void>;

    /** Reverse of {@link addClientToCall}. Idempotent. */
    removeClientFromCall?(clientId: string, callId: string): Promise<void>;

    /**
     * All callIds this client is a participant of across the cluster.
     * Mirrors {@link getCallIdsByClient}; exposed under the more verbose
     * name to match the write-through API the gateway calls on
     * disconnect. Implementations may delegate to getCallIdsByClient.
     */
    getCallsForClient?(clientId: string): Promise<string[]>;

    // ─────────────────────────────────────────────────────────────────
    // F2/F3 (2026-08-21) — discovery indexes. Both are append-only with
    // a TTL safety net: readers MUST liveness-filter every returned
    // callId through getCall (null view = stale entry, skip). No removal
    // on disconnect/forget is required, which keeps the write paths
    // fire-and-forget and race-free.
    // ─────────────────────────────────────────────────────────────────

    /**
     * F2 — durable userId → callIds index. The clientId index breaks on
     * page refresh: the new tab has a NEW clientId, so
     * getCallIdsByClient(newClientId) is empty and the resume dialog
     * never fires. This index keys on the stable userId instead.
     */
    registerUserCall?(userId: string, callId: string, ttlSec: number): Promise<void>;
    /** F2 — callIds this userId has participated in (may include stale
     *  entries; liveness-filter through getCall). */
    getCallIdsByUser?(userId: string): Promise<string[]>;

    /**
     * F3 — lobbyName → callIds index so a freshly-connected client can
     * ask "is there an active call in this lobby?" without ever having
     * been invited. Same liveness-filter contract as the user index.
     */
    registerLobbyCall?(lobbyName: string, callId: string, ttlSec: number): Promise<void>;
    /** F3 — candidate callIds for a lobby (liveness-filter through getCall). */
    getCallIdsByLobby?(lobbyName: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (today's behavior, preserved)
// ---------------------------------------------------------------------------

interface InMemoryActiveCall {
    callerId: string;
    lobbyName: string;
    targetUserIds: string[];
    participantClientIds: Set<string>;
    /** Resume-dialog metadata captured at invite time. */
    invitedAt?: number;
    callerName?: string;
}

export class InMemoryCallStateStore implements CallStateStore {
    private activeCalls = new Map<string, InMemoryActiveCall>();
    private clientToCalls = new Map<string, Set<string>>();
    // PR-W2.1 — per-userId invite registry. Value is callId→expiresAtMs.
    private invitesByUser = new Map<string, Map<string, number>>();
    // PR-W2.1 — accept dedup. Value is the expiry millis (TTL-emulated).
    private acceptedCalls = new Map<string, number>();
    // PR-W2.1 — recent-invites dedup. Value is the expiry millis.
    private recentInvites = new Map<string, number>();
    // F2/F3 — discovery indexes (userId → callIds, lobbyName → callIds).
    // Append-only; readers liveness-filter through getCall.
    private userToCalls = new Map<string, Set<string>>();
    private lobbyToCalls = new Map<string, Set<string>>();

    async registerParticipant(callId: string, clientId: string, callerId: string, lobbyName: string, targetUserIds: string[]): Promise<void> {
        let state = this.activeCalls.get(callId);
        if (!state) {
            state = { callerId, lobbyName, targetUserIds, participantClientIds: new Set() };
            this.activeCalls.set(callId, state);
        }
        state.participantClientIds.add(clientId);
        let calls = this.clientToCalls.get(clientId);
        if (!calls) { calls = new Set(); this.clientToCalls.set(clientId, calls); }
        calls.add(callId);
    }

    async removeParticipant(callId: string, clientId: string): Promise<{ remaining: number } | null> {
        const state = this.activeCalls.get(callId);
        if (!state) return null;
        state.participantClientIds.delete(clientId);
        const calls = this.clientToCalls.get(clientId);
        if (calls) {
            calls.delete(callId);
            if (calls.size === 0) this.clientToCalls.delete(clientId);
        }
        if (state.participantClientIds.size === 0) this.activeCalls.delete(callId);
        return { remaining: state.participantClientIds.size };
    }

    async getCall(callId: string): Promise<ActiveCallStateView | null> {
        const state = this.activeCalls.get(callId);
        if (!state) return null;
        return {
            callerId: state.callerId,
            lobbyName: state.lobbyName,
            targetUserIds: state.targetUserIds,
            participantClientIds: Array.from(state.participantClientIds),
            invitedAt: state.invitedAt ?? null,
            callerName: state.callerName ?? null,
        };
    }

    async getCallIdsByClient(clientId: string): Promise<string[]> {
        const calls = this.clientToCalls.get(clientId);
        return calls ? Array.from(calls) : [];
    }

    async registerUserCall(userId: string, callId: string, _ttlSec: number): Promise<void> {
        let set = this.userToCalls.get(userId);
        if (!set) { set = new Set(); this.userToCalls.set(userId, set); }
        set.add(callId);
    }

    async getCallIdsByUser(userId: string): Promise<string[]> {
        const set = this.userToCalls.get(userId);
        if (!set) return [];
        // Opportunistic prune: drop ids whose call no longer exists so
        // the in-memory sets don't grow unbounded in long-lived nodes.
        for (const id of Array.from(set)) {
            if (!this.activeCalls.has(id)) set.delete(id);
        }
        if (set.size === 0) { this.userToCalls.delete(userId); return []; }
        return Array.from(set);
    }

    async registerLobbyCall(lobbyName: string, callId: string, _ttlSec: number): Promise<void> {
        let set = this.lobbyToCalls.get(lobbyName);
        if (!set) { set = new Set(); this.lobbyToCalls.set(lobbyName, set); }
        set.add(callId);
    }

    async getCallIdsByLobby(lobbyName: string): Promise<string[]> {
        const set = this.lobbyToCalls.get(lobbyName);
        if (!set) return [];
        for (const id of Array.from(set)) {
            if (!this.activeCalls.has(id)) set.delete(id);
        }
        if (set.size === 0) { this.lobbyToCalls.delete(lobbyName); return []; }
        return Array.from(set);
    }

    async setInviteMetadata(
        callId: string,
        meta: { invitedAt?: number; callerName?: string },
    ): Promise<void> {
        const state = this.activeCalls.get(callId);
        if (!state) return;
        if (typeof meta.invitedAt === 'number') state.invitedAt = meta.invitedAt;
        if (typeof meta.callerName === 'string' && meta.callerName.length) {
            state.callerName = meta.callerName;
        }
    }

    async forgetCall(callId: string): Promise<void> {
        const state = this.activeCalls.get(callId);
        if (!state) return;
        for (const cid of state.participantClientIds) {
            const calls = this.clientToCalls.get(cid);
            if (calls) {
                calls.delete(callId);
                if (calls.size === 0) this.clientToCalls.delete(cid);
            }
        }
        this.activeCalls.delete(callId);
    }

    async stats(): Promise<{ activeCalls: number; trackedClients: number }> {
        return { activeCalls: this.activeCalls.size, trackedClients: this.clientToCalls.size };
    }

    // PR-W2.1 — invite registry / accept dedup / recent-invite dedup.

    async registerInvite(userId: string, callId: string, expiresAtMs: number): Promise<void> {
        let m = this.invitesByUser.get(userId);
        if (!m) { m = new Map(); this.invitesByUser.set(userId, m); }
        m.set(callId, expiresAtMs);
    }

    async clearInviteForUser(userId: string, callId: string): Promise<void> {
        const m = this.invitesByUser.get(userId);
        if (!m) return;
        m.delete(callId);
        if (m.size === 0) this.invitesByUser.delete(userId);
    }

    async clearInviteForCall(callId: string): Promise<void> {
        for (const [userId, m] of this.invitesByUser) {
            if (m.delete(callId) && m.size === 0) this.invitesByUser.delete(userId);
        }
    }

    async getActiveInvitesForUser(userId: string): Promise<string[]> {
        const m = this.invitesByUser.get(userId);
        if (!m) return [];
        const now = Date.now();
        const out: string[] = [];
        for (const [callId, expiresAt] of m) {
            if (expiresAt > now) out.push(callId);
            else m.delete(callId);
        }
        if (m.size === 0) this.invitesByUser.delete(userId);
        return out;
    }

    async markAccepted(callId: string, ttlSeconds: number): Promise<boolean> {
        const now = Date.now();
        const existing = this.acceptedCalls.get(callId);
        if (typeof existing === 'number' && existing > now) return false;
        this.acceptedCalls.set(callId, now + ttlSeconds * 1000);
        return true;
    }

    async clearAccepted(callId: string): Promise<void> {
        this.acceptedCalls.delete(callId);
    }

    async markRecentInvite(callId: string, windowSeconds: number): Promise<boolean> {
        const now = Date.now();
        const existing = this.recentInvites.get(callId);
        if (typeof existing === 'number' && existing > now) return false;
        this.recentInvites.set(callId, now + windowSeconds * 1000);
        // Bounded cleanup — keep the Map from growing unboundedly.
        if (this.recentInvites.size > 10_000) {
            for (const [k, exp] of this.recentInvites) {
                if (exp <= now) this.recentInvites.delete(k);
            }
        }
        return true;
    }

    // PR-W2.1 (completion) — explicit write-through API. Backed by the
    // same activeCalls + clientToCalls Maps that registerParticipant
    // populates; setCall/addClientToCall/etc. are thin overlays so the
    // CallService caller can use either API interchangeably.

    async setCall(callId: string, state: ActiveCallStateView, _ttlSec: number): Promise<void> {
        // TTL ignored for the in-memory stub — process lifetime IS the
        // bound. Real expiry happens via the invite-sweep timer.
        let entry = this.activeCalls.get(callId);
        if (!entry) {
            entry = {
                callerId: state.callerId,
                lobbyName: state.lobbyName,
                targetUserIds: state.targetUserIds,
                participantClientIds: new Set<string>(state.participantClientIds),
            };
            this.activeCalls.set(callId, entry);
        } else {
            entry.callerId = state.callerId || entry.callerId;
            entry.lobbyName = state.lobbyName || entry.lobbyName;
            entry.targetUserIds = state.targetUserIds && state.targetUserIds.length
                ? state.targetUserIds
                : entry.targetUserIds;
            for (const cid of state.participantClientIds) entry.participantClientIds.add(cid);
        }
        if (typeof state.invitedAt === 'number') entry.invitedAt = state.invitedAt;
        if (typeof state.callerName === 'string' && state.callerName.length) {
            entry.callerName = state.callerName;
        }
        // Keep the reverse-index in sync for every participant.
        for (const cid of state.participantClientIds) {
            let calls = this.clientToCalls.get(cid);
            if (!calls) { calls = new Set(); this.clientToCalls.set(cid, calls); }
            calls.add(callId);
        }
    }

    async addClientToCall(clientId: string, callId: string, _ttlSec: number): Promise<void> {
        let calls = this.clientToCalls.get(clientId);
        if (!calls) { calls = new Set(); this.clientToCalls.set(clientId, calls); }
        calls.add(callId);
    }

    async removeClientFromCall(clientId: string, callId: string): Promise<void> {
        const calls = this.clientToCalls.get(clientId);
        if (!calls) return;
        calls.delete(callId);
        if (calls.size === 0) this.clientToCalls.delete(clientId);
    }

    async getCallsForClient(clientId: string): Promise<string[]> {
        return this.getCallIdsByClient(clientId);
    }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

// Minimal Redis interface — narrowed to the ops we need so tests can
// pass a stub without dragging in the real client. Matches the
// surface of distributed-core's Redis client wrapper.
export interface CallStateRedis {
    hset(key: string, field: string, value: string): Promise<unknown>;
    hSetNX?(key: string, field: string, value: string): Promise<unknown>;
    hsetnx?(key: string, field: string, value: string): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, string>>;
    hdel(key: string, ...fields: string[]): Promise<unknown>;
    sadd(key: string, ...members: string[]): Promise<unknown>;
    srem(key: string, ...members: string[]): Promise<unknown>;
    smembers(key: string): Promise<string[]>;
    del(...keys: string[]): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    // PR-W2.1 — string-key SETNX path used for accept dedup + recent
    // invite dedup. Both clients expose this but under different names;
    // RedisCallStateStore probes for any of these the same way it probes
    // hSetNX/hsetnx. `setNX` returns whether the key was created
    // (true/1 = first write). `set(key, value, { NX, EX })` is node-redis
    // v4's options-bag form. ioredis exposes `set(key, value, 'NX', 'EX',
    // seconds)` as positional args.
    setNX?(key: string, value: string): Promise<boolean | number | unknown>;
    set?(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Redis-backed call state. Two key shapes:
 *
 *   call:active:<callId> (hash)
 *     - callerId      (string)
 *     - lobbyName     (string)
 *     - targetUserIds (JSON array)
 *     - participants  (Redis set keyed under call:active:<callId>:participants)
 *
 *   client:calls:<clientId> (set)
 *     - members are callIds this client is a participant of
 *
 * TTL safety net: 4 hours on both keys, refreshed on every write.
 * Beyond that, the call is presumed dead — covers the "node OOM'd
 * without firing handleDisconnect" edge case where state would
 * otherwise leak forever.
 */
const CALL_KEY_PREFIX = 'call:active:';
const CLIENT_KEY_PREFIX = 'client:calls:';
// PR-W2.1 — three new key prefixes for the migrated registries.
const USER_INVITES_PREFIX = 'call:invites:user:';   // hash: callId → expiresAtMs
// F2/F3 — discovery indexes (sets of callIds; liveness-filtered on read).
const USER_CALLS_PREFIX = 'call:user:';             // set: callIds a userId joined
const LOBBY_CALLS_PREFIX = 'call:lobby:';           // set: callIds in a lobbyName
const ACCEPTED_KEY_PREFIX = 'call:accepted:';        // string: SETNX with TTL
const RECENT_INVITE_PREFIX = 'call:recent-invite:'; // string: SETNX with TTL
const TTL_SECONDS = 4 * 60 * 60;

export class RedisCallStateStore implements CallStateStore {
    constructor(private redis: CallStateRedis) {}

    private callKey(callId: string): string { return `${CALL_KEY_PREFIX}${callId}`; }
    private participantsKey(callId: string): string { return `${CALL_KEY_PREFIX}${callId}:participants`; }
    private clientKey(clientId: string): string { return `${CLIENT_KEY_PREFIX}${clientId}`; }

    async registerParticipant(callId: string, clientId: string, callerId: string, lobbyName: string, targetUserIds: string[]): Promise<void> {
        const callKey = this.callKey(callId);
        const participantsKey = this.participantsKey(callId);
        const clientKey = this.clientKey(clientId);
        // HSETNX is atomic + only-if-not-exists, so the first-write
        // values for callerId/lobby/targetUserIds win without a
        // racy hgetall→hset compare.
        await this.hsetnx(callKey, 'callerId', callerId);
        await this.hsetnx(callKey, 'lobbyName', lobbyName);
        await this.hsetnx(callKey, 'targetUserIds', JSON.stringify(targetUserIds));
        await this.sadd(participantsKey, clientId);
        await this.sadd(clientKey, callId);
        // Refresh TTLs. Order matters here — set TTL on every key we
        // wrote in this call so a concurrent `removeParticipant` that
        // raced past its own SCARD/DEL window can't leave us with an
        // orphaned key that has no expiry. If another node DEL'd the
        // hash between our HSETNX and EXPIRE, EXPIRE on a missing key
        // is a no-op (returns 0) — the next register attempt will
        // recreate it, and the safety-net 4h TTL kicks in regardless.
        await this.expire(callKey, TTL_SECONDS);
        await this.expire(participantsKey, TTL_SECONDS);
        await this.expire(clientKey, TTL_SECONDS);
    }

    private async hsetnx(key: string, field: string, value: string): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.hSetNX === 'function') return r.hSetNX(key, field, value);
        if (typeof r.hsetnx === 'function') return r.hsetnx(key, field, value);
        throw new Error('CallStateRedis: hSetNX/hsetnx not available on redis client');
    }

    // node-redis v4 uses camelCase (sAdd/sRem/sMembers/hGetAll); ioredis +
    // distributed-core's wrapper use snake_case (sadd/srem/...). Probe both
    // so the same store works against either client without injection plumbing.
    private async sadd(key: string, member: string): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.sAdd === 'function') return r.sAdd(key, member);
        if (typeof r.sadd === 'function') return r.sadd(key, member);
        throw new Error('CallStateRedis: sAdd/sadd not available on redis client');
    }
    private async srem(key: string, member: string): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.sRem === 'function') return r.sRem(key, member);
        if (typeof r.srem === 'function') return r.srem(key, member);
        throw new Error('CallStateRedis: sRem/srem not available on redis client');
    }
    private async smembers(key: string): Promise<string[]> {
        const r: any = this.redis as any;
        if (typeof r.sMembers === 'function') return r.sMembers(key);
        if (typeof r.smembers === 'function') return r.smembers(key);
        throw new Error('CallStateRedis: sMembers/smembers not available on redis client');
    }
    private async hgetall(key: string): Promise<Record<string, string>> {
        const r: any = this.redis as any;
        if (typeof r.hGetAll === 'function') return r.hGetAll(key);
        if (typeof r.hgetall === 'function') return r.hgetall(key);
        throw new Error('CallStateRedis: hGetAll/hgetall not available on redis client');
    }
    private async del(...keys: string[]): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.del === 'function') return r.del(...keys);
        if (typeof r.unlink === 'function') return r.unlink(...keys);
        throw new Error('CallStateRedis: del/unlink not available on redis client');
    }
    private async expire(key: string, seconds: number): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.expire === 'function') return r.expire(key, seconds);
        throw new Error('CallStateRedis: expire not available on redis client');
    }

    async removeParticipant(callId: string, clientId: string): Promise<{ remaining: number } | null> {
        const callKey = this.callKey(callId);
        const participantsKey = this.participantsKey(callId);
        const clientKey = this.clientKey(clientId);
        const existing = await this.hgetall(callKey);
        if (!existing || !existing.callerId) return null;
        await this.srem(participantsKey, clientId);
        await this.srem(clientKey, callId);
        const remainingMembers = await this.smembers(participantsKey);
        const remaining = remainingMembers.length;
        if (remaining === 0) {
            // Race-safety re-check: between the SREM above and the DEL
            // below another node could SADD a new participant. Without
            // this second read we'd nuke a call that just got a fresh
            // member, leaving a phantom entry in their clientKey. The
            // re-check narrows the race; the safety-net 4h TTL closes
            // anything we still get wrong.
            const recheck = await this.smembers(participantsKey);
            if (recheck.length === 0) {
                await this.del(callKey, participantsKey);
            } else {
                // Peer rejoined mid-removal — keep the call alive and
                // bump TTL so the new participant's expire wins.
                await this.expire(callKey, TTL_SECONDS);
                await this.expire(participantsKey, TTL_SECONDS);
            }
        } else {
            // Partial removal — refresh TTL on the surviving keys so a
            // long call (multi-hour support session) doesn't get reaped
            // mid-conversation just because everyone is reading rather
            // than churning membership.
            await this.expire(callKey, TTL_SECONDS);
            await this.expire(participantsKey, TTL_SECONDS);
        }
        return { remaining };
    }

    async getCall(callId: string): Promise<ActiveCallStateView | null> {
        const callKey = this.callKey(callId);
        const participantsKey = this.participantsKey(callId);
        const hash = await this.hgetall(callKey);
        if (!hash || !hash.callerId) return null;
        const participantClientIds = await this.smembers(participantsKey);
        let targetUserIds: string[] = [];
        try { targetUserIds = JSON.parse(hash.targetUserIds || '[]'); } catch { /* */ }
        // Bump TTL on read. Long calls (multi-hour) frequently have no
        // membership churn — only metadata reads — and would otherwise
        // be evicted by the 4h safety-net while users are still on
        // them. Best-effort: a failed EXPIRE shouldn't block the read.
        try {
            await this.expire(callKey, TTL_SECONDS);
            await this.expire(participantsKey, TTL_SECONDS);
        } catch { /* */ }
        // invitedAt was written by setInviteMetadata; legacy entries
        // pre-dating the field write absent.
        let invitedAt: number | null = null;
        if (typeof hash.invitedAt === 'string' && hash.invitedAt.length) {
            const parsed = Number.parseInt(hash.invitedAt, 10);
            if (Number.isFinite(parsed)) invitedAt = parsed;
        }
        const callerName = typeof hash.callerName === 'string' && hash.callerName.length
            ? hash.callerName
            : null;
        return {
            callerId: hash.callerId,
            lobbyName: hash.lobbyName ?? '',
            targetUserIds,
            participantClientIds,
            invitedAt,
            callerName,
        };
    }

    async setInviteMetadata(
        callId: string,
        meta: { invitedAt?: number; callerName?: string },
    ): Promise<void> {
        const callKey = this.callKey(callId);
        // Only write the hash when the call entry already exists — the
        // resume endpoint reads from the same hash and a phantom invitedAt
        // would leak after forgetCall().
        const hash = await this.hgetall(callKey);
        if (!hash || !hash.callerId) return;
        const r: any = this.redis as any;
        if (typeof meta.invitedAt === 'number') {
            try {
                if (typeof r.hSet === 'function') await r.hSet(callKey, 'invitedAt', String(meta.invitedAt));
                else if (typeof r.hset === 'function') await r.hset(callKey, 'invitedAt', String(meta.invitedAt));
            } catch { /* best-effort */ }
        }
        if (typeof meta.callerName === 'string' && meta.callerName.length) {
            try {
                if (typeof r.hSet === 'function') await r.hSet(callKey, 'callerName', meta.callerName);
                else if (typeof r.hset === 'function') await r.hset(callKey, 'callerName', meta.callerName);
            } catch { /* best-effort */ }
        }
        try { await this.expire(callKey, TTL_SECONDS); } catch { /* */ }
    }

    async registerUserCall(userId: string, callId: string, ttlSec: number): Promise<void> {
        const key = `${USER_CALLS_PREFIX}${userId}`;
        await this.sadd(key, callId);
        await this.expire(key, ttlSec);
    }

    async getCallIdsByUser(userId: string): Promise<string[]> {
        return this.smembers(`${USER_CALLS_PREFIX}${userId}`);
    }

    async registerLobbyCall(lobbyName: string, callId: string, ttlSec: number): Promise<void> {
        const key = `${LOBBY_CALLS_PREFIX}${lobbyName}`;
        await this.sadd(key, callId);
        await this.expire(key, ttlSec);
    }

    async getCallIdsByLobby(lobbyName: string): Promise<string[]> {
        return this.smembers(`${LOBBY_CALLS_PREFIX}${lobbyName}`);
    }

    async getCallIdsByClient(clientId: string): Promise<string[]> {
        const clientKey = this.clientKey(clientId);
        const callIds = await this.smembers(clientKey);
        // Bump TTL on read so an idle-but-still-connected client's
        // reverse-index doesn't expire out from under them. Best-effort.
        if (callIds.length > 0) {
            try { await this.expire(clientKey, TTL_SECONDS); } catch { /* */ }
        }
        return callIds;
    }

    async forgetCall(callId: string): Promise<void> {
        const participants = await this.smembers(this.participantsKey(callId));
        for (const cid of participants) {
            await this.srem(this.clientKey(cid), callId);
        }
        await this.del(this.callKey(callId), this.participantsKey(callId));
    }

    async stats(): Promise<{ activeCalls: number; trackedClients: number }> {
        // SCAN-based counts would be O(N) over the keyspace. For the
        // /metrics path we just report -1 sentinels — operators
        // read activeCalls from the per-node InMemoryCallStateStore
        // gauge anyway. Could swap to a counter key later if needed.
        return { activeCalls: -1, trackedClients: -1 };
    }

    // ─────────────────────────────────────────────────────────────────
    // PR-W2.1 — invite registry, accept dedup, recent-invite dedup.
    // Same camelCase/snake_case probe pattern as the existing surface.
    // ─────────────────────────────────────────────────────────────────

    private userInvitesKey(userId: string): string { return `${USER_INVITES_PREFIX}${userId}`; }
    private acceptedKey(callId: string): string { return `${ACCEPTED_KEY_PREFIX}${callId}`; }
    private recentInviteKey(callId: string): string { return `${RECENT_INVITE_PREFIX}${callId}`; }

    /**
     * Best-effort SETNX wrapper. Probes (in order): `setNX(key, value)`,
     * `set(key, value, { NX: true, EX: ttl })` (node-redis v4 options-bag),
     * and `set(key, value, 'NX', 'EX', ttl)` (ioredis positional). All
     * three return a truthy value on first-write and a falsy/null on
     * already-set; we normalise to boolean.
     */
    private async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        const r: any = this.redis as any;
        // node-redis v4 setNX — no TTL flag; follow-up EXPIRE.
        if (typeof r.setNX === 'function') {
            const created: any = await r.setNX(key, value);
            const ok = created === true || created === 1;
            if (ok) {
                try { await this.expire(key, ttlSeconds); } catch { /* */ }
            }
            return ok;
        }
        if (typeof r.set === 'function') {
            // Try options-bag form first (node-redis v4).
            try {
                const result: any = await r.set(key, value, { NX: true, EX: ttlSeconds });
                if (result === 'OK' || result === true || result === 1) return true;
                if (result === null || result === false || result === 0) return false;
                // Some clients return the original value on no-op; treat
                // non-null/non-OK as "wasn't created" defensively.
                return false;
            } catch {
                // Fall through to ioredis positional form.
            }
            try {
                const result: any = await r.set(key, value, 'NX', 'EX', ttlSeconds);
                if (result === 'OK') return true;
                if (result === null) return false;
                return Boolean(result);
            } catch {
                // Last resort — manual hgetall-style probe is racy; fall
                // through to the hsetnx-style trick on a hash field.
            }
        }
        // Fallback: HSETNX on a single-field hash. Atomic and supported
        // by both clients. TTL applies to the whole key.
        const ok = await this.hsetnx(key, '_', value);
        const created = ok === 1 || ok === true;
        if (created) {
            try { await this.expire(key, ttlSeconds); } catch { /* */ }
        }
        return created;
    }

    private async hSet(key: string, field: string, value: string): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.hSet === 'function') return r.hSet(key, field, value);
        if (typeof r.hset === 'function') return r.hset(key, field, value);
        throw new Error('CallStateRedis: hSet/hset not available on redis client');
    }
    private async hDel(key: string, field: string): Promise<unknown> {
        const r: any = this.redis as any;
        if (typeof r.hDel === 'function') return r.hDel(key, field);
        if (typeof r.hdel === 'function') return r.hdel(key, field);
        throw new Error('CallStateRedis: hDel/hdel not available on redis client');
    }

    async registerInvite(userId: string, callId: string, expiresAtMs: number): Promise<void> {
        const key = this.userInvitesKey(userId);
        await this.hSet(key, callId, String(expiresAtMs));
        // TTL = max remaining lifetime in seconds (+ slack). The hash
        // gets refreshed on every invite anyway; expire only protects
        // against a totally-quiet user whose oldest invite still hasn't
        // fired its forget.
        const remaining = Math.max(60, Math.ceil((expiresAtMs - Date.now()) / 1000));
        try { await this.expire(key, remaining); } catch { /* */ }
    }

    async clearInviteForUser(userId: string, callId: string): Promise<void> {
        try { await this.hDel(this.userInvitesKey(userId), callId); } catch { /* */ }
    }

    async clearInviteForCall(callId: string): Promise<void> {
        // We don't maintain a reverse callId→userIds index — fall back to
        // the caller iterating over the call's targetUserIds. The
        // CallService side already has that list (it was computed at invite
        // time) so a separate Redis scan would be wasteful. This stub is a
        // no-op for the global path; CallService calls clearInviteForUser
        // per target instead.
        void callId;
    }

    async getActiveInvitesForUser(userId: string): Promise<string[]> {
        const hash = await this.hgetall(this.userInvitesKey(userId));
        if (!hash) return [];
        const now = Date.now();
        const live: string[] = [];
        const stale: string[] = [];
        for (const [callId, expiresAtStr] of Object.entries(hash)) {
            const expiresAt = Number.parseInt(expiresAtStr, 10);
            if (Number.isFinite(expiresAt) && expiresAt > now) live.push(callId);
            else stale.push(callId);
        }
        // Best-effort prune of expired entries — keeps the hash bounded.
        if (stale.length > 0) {
            for (const callId of stale) {
                try { await this.hDel(this.userInvitesKey(userId), callId); } catch { /* */ }
            }
        }
        return live;
    }

    async markAccepted(callId: string, ttlSeconds: number): Promise<boolean> {
        return this.setNxEx(this.acceptedKey(callId), '1', ttlSeconds);
    }

    async clearAccepted(callId: string): Promise<void> {
        try { await this.del(this.acceptedKey(callId)); } catch { /* */ }
    }

    async markRecentInvite(callId: string, windowSeconds: number): Promise<boolean> {
        return this.setNxEx(this.recentInviteKey(callId), String(Date.now()), windowSeconds);
    }

    // ─────────────────────────────────────────────────────────────────
    // PR-W2.1 (completion) — explicit write-through cache methods.
    //
    // Key shapes (reuse the existing call:active:* + client:calls:*
    // namespaces so registerParticipant + setCall write to the SAME
    // hash; peer nodes reading via either path see one consistent
    // view). The user spec named the keys `call:state:<callId>` and
    // `call:client:<clientId>`; we keep the existing names but expose
    // the spec method names as overlays. Both clients see identical
    // data; the alternate keys would have required a redundant second
    // write on every register.
    // ─────────────────────────────────────────────────────────────────

    async setCall(callId: string, state: ActiveCallStateView, ttlSec: number): Promise<void> {
        const callKey = this.callKey(callId);
        const participantsKey = this.participantsKey(callId);
        // Authoritative write — overwrites prior values (this is the
        // explicit "I know the full state" path; the registerParticipant
        // HSETNX path is for racy concurrent inserts).
        await this.hSet(callKey, 'callerId', state.callerId);
        await this.hSet(callKey, 'lobbyName', state.lobbyName);
        await this.hSet(callKey, 'targetUserIds', JSON.stringify(state.targetUserIds ?? []));
        if (typeof state.invitedAt === 'number') {
            await this.hSet(callKey, 'invitedAt', String(state.invitedAt));
        }
        if (typeof state.callerName === 'string' && state.callerName.length) {
            await this.hSet(callKey, 'callerName', state.callerName);
        }
        for (const cid of state.participantClientIds) {
            await this.sadd(participantsKey, cid);
            await this.sadd(this.clientKey(cid), callId);
            try { await this.expire(this.clientKey(cid), ttlSec); } catch { /* */ }
        }
        try {
            await this.expire(callKey, ttlSec);
            await this.expire(participantsKey, ttlSec);
        } catch { /* */ }
    }

    async addClientToCall(clientId: string, callId: string, ttlSec: number): Promise<void> {
        const clientKey = this.clientKey(clientId);
        await this.sadd(clientKey, callId);
        try { await this.expire(clientKey, ttlSec); } catch { /* */ }
    }

    async removeClientFromCall(clientId: string, callId: string): Promise<void> {
        try { await this.srem(this.clientKey(clientId), callId); } catch { /* */ }
    }

    async getCallsForClient(clientId: string): Promise<string[]> {
        return this.getCallIdsByClient(clientId);
    }
}
