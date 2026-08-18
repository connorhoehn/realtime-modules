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
    registerParticipant(callId: string, clientId: string, callerId: string, lobbyName: string, targetUserIds: string[]): Promise<void>;
    /** Remove one participant. Returns the remaining count post-removal,
     *  or null when the call doesn't exist. */
    removeParticipant(callId: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    /** Snapshot of a call's state. Returns null when not active. */
    getCall(callId: string): Promise<ActiveCallStateView | null>;
    /** All callIds this client is a participant of (across the cluster). */
    getCallIdsByClient(clientId: string): Promise<string[]>;
    /** Forget a call entirely. Idempotent. */
    forgetCall(callId: string): Promise<void>;
    /** Diagnostics — counts for /metrics. */
    stats(): Promise<{
        activeCalls: number;
        trackedClients: number;
    }>;
    /**
     * Optional capture of when this call's `invite` registered (millis
     * since epoch) plus the caller's display name (when known). Called
     * once after registerParticipant on `invite`. Implementations that
     * don't track this surface it as a no-op + null/undefined on the
     * getCall view; the resume endpoint then falls back to `now`.
     */
    setInviteMetadata?(callId: string, meta: {
        invitedAt?: number;
        callerName?: string;
    }): Promise<void>;
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
}
export declare class InMemoryCallStateStore implements CallStateStore {
    private activeCalls;
    private clientToCalls;
    private invitesByUser;
    private acceptedCalls;
    private recentInvites;
    registerParticipant(callId: string, clientId: string, callerId: string, lobbyName: string, targetUserIds: string[]): Promise<void>;
    removeParticipant(callId: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    getCall(callId: string): Promise<ActiveCallStateView | null>;
    getCallIdsByClient(clientId: string): Promise<string[]>;
    setInviteMetadata(callId: string, meta: {
        invitedAt?: number;
        callerName?: string;
    }): Promise<void>;
    forgetCall(callId: string): Promise<void>;
    stats(): Promise<{
        activeCalls: number;
        trackedClients: number;
    }>;
    registerInvite(userId: string, callId: string, expiresAtMs: number): Promise<void>;
    clearInviteForUser(userId: string, callId: string): Promise<void>;
    clearInviteForCall(callId: string): Promise<void>;
    getActiveInvitesForUser(userId: string): Promise<string[]>;
    markAccepted(callId: string, ttlSeconds: number): Promise<boolean>;
    clearAccepted(callId: string): Promise<void>;
    markRecentInvite(callId: string, windowSeconds: number): Promise<boolean>;
    setCall(callId: string, state: ActiveCallStateView, _ttlSec: number): Promise<void>;
    addClientToCall(clientId: string, callId: string, _ttlSec: number): Promise<void>;
    removeClientFromCall(clientId: string, callId: string): Promise<void>;
    getCallsForClient(clientId: string): Promise<string[]>;
}
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
    setNX?(key: string, value: string): Promise<boolean | number | unknown>;
    set?(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}
export declare class RedisCallStateStore implements CallStateStore {
    private redis;
    constructor(redis: CallStateRedis);
    private callKey;
    private participantsKey;
    private clientKey;
    registerParticipant(callId: string, clientId: string, callerId: string, lobbyName: string, targetUserIds: string[]): Promise<void>;
    private hsetnx;
    private sadd;
    private srem;
    private smembers;
    private hgetall;
    private del;
    private expire;
    removeParticipant(callId: string, clientId: string): Promise<{
        remaining: number;
    } | null>;
    getCall(callId: string): Promise<ActiveCallStateView | null>;
    setInviteMetadata(callId: string, meta: {
        invitedAt?: number;
        callerName?: string;
    }): Promise<void>;
    getCallIdsByClient(clientId: string): Promise<string[]>;
    forgetCall(callId: string): Promise<void>;
    stats(): Promise<{
        activeCalls: number;
        trackedClients: number;
    }>;
    private userInvitesKey;
    private acceptedKey;
    private recentInviteKey;
    /**
     * Best-effort SETNX wrapper. Probes (in order): `setNX(key, value)`,
     * `set(key, value, { NX: true, EX: ttl })` (node-redis v4 options-bag),
     * and `set(key, value, 'NX', 'EX', ttl)` (ioredis positional). All
     * three return a truthy value on first-write and a falsy/null on
     * already-set; we normalise to boolean.
     */
    private setNxEx;
    private hSet;
    private hDel;
    registerInvite(userId: string, callId: string, expiresAtMs: number): Promise<void>;
    clearInviteForUser(userId: string, callId: string): Promise<void>;
    clearInviteForCall(callId: string): Promise<void>;
    getActiveInvitesForUser(userId: string): Promise<string[]>;
    markAccepted(callId: string, ttlSeconds: number): Promise<boolean>;
    clearAccepted(callId: string): Promise<void>;
    markRecentInvite(callId: string, windowSeconds: number): Promise<boolean>;
    setCall(callId: string, state: ActiveCallStateView, ttlSec: number): Promise<void>;
    addClientToCall(clientId: string, callId: string, ttlSec: number): Promise<void>;
    removeClientFromCall(clientId: string, callId: string): Promise<void>;
    getCallsForClient(clientId: string): Promise<string[]>;
}
//# sourceMappingURL=CallStateStore.d.ts.map