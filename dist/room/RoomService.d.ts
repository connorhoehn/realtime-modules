import { type RoomActionPayload, type RoomLogger, type RoomMessageRouter, type RoomServiceOptions } from './types';
import type { RoomMemberSnapshot } from './RoomStateStore';
export declare class RoomService {
    messageRouter: RoomMessageRouter;
    logger: RoomLogger;
    private stateStore;
    private crossNodePubSub;
    private crossNodeUnsubscribe;
    private nodeId;
    private readonly metricsHooks;
    private occupancyDebounceMs;
    private maxMembersPerDelta;
    private occupancyCacheTtlMs;
    /** Local per-room membership cache. Per-node only — peer-node members
     *  are reflected in RoomStateStore (Redis) and surfaced via
     *  `listMembers(slug)` reads on demand for index snapshots. Kept as a
     *  fast write path + single-node fallback when no state-store is
     *  wired. Reads (getRoomOccupancyCount / getRoomMembers) prefer the
     *  state-store for cluster-wide truth — see audit #8. */
    private activeRooms;
    /** Reverse index: which rooms is each LOCAL client a member of. */
    private clientToRooms;
    /** Per-slug occupancy read cache: short-TTL'd memo of the last
     *  state-store result. Keeps WS-heartbeat-rate callers from beating
     *  on Redis. Cleared on local mutation so writers see their own
     *  effects without waiting for the TTL. */
    private occupancyCache;
    /** Per-slug subscriber sets. */
    private roomSubscribers;
    /** Reverse index — which slugs each clientId is subscribed to. */
    private clientToSubscriptions;
    /** rooms:index subscriber set. */
    private indexSubscribers;
    /** Pending occupancy changes awaiting the next debounce flush. Slug
     *  is the map key so a flurry of joins/leaves for the same room
     *  collapses to a single entry. */
    private pendingDeltas;
    private debounceTimer;
    constructor(opts: RoomServiceOptions);
    /** Stop the cross-node subscription + flush any pending debounce.
     *  Called on shutdown so the timer doesn't keep the event loop alive. */
    dispose(): Promise<void>;
    /** Server invokes shutdown on every service; alias to dispose. */
    shutdown(): Promise<void>;
    handleAction(clientId: string, action: string, data: RoomActionPayload | null | undefined): Promise<void>;
    private handleSubscribeIndex;
    private handleUnsubscribeIndex;
    private handleSubscribe;
    private handleUnsubscribe;
    /**
     * Record that a user joined a room. Idempotent on (slug, clientId).
     * Fans out `member-joined` to per-room subscribers and schedules a
     * debounced occupancy-delta for index subscribers. Replicates to
     * peer nodes via cross-node pubsub when wired.
     */
    handleMemberJoined(slug: string, userId: string, clientId: string, participantId: string, displayName: string): Promise<void>;
    /**
     * Record that a user left a room. Idempotent. Fans out `member-left`
     * to per-room subscribers and schedules a debounced occupancy-delta.
     *
     * `reason` distinguishes the leave path for observability:
     *   - 'explicit'   — user-status:'left' (or any direct caller-driven leave)
     *   - 'disconnect' — server's disconnect cleanup loop (WS closed)
     * Defaults to 'explicit' so existing call sites that haven't been
     * updated yet stay backwards-compatible.
     */
    handleMemberLeft(slug: string, userId: string, clientId: string, reason?: 'explicit' | 'disconnect'): Promise<void>;
    /**
     * Drop a client from every room they were a member of + clear their
     * subscriptions. Called from the server's disconnect loop via the
     * `handleDisconnect` alias below.
     */
    handleDisconnect(clientId: string): Promise<void>;
    private handleCrossNodeEvent;
    private fanOutToRoomSubscribers;
    private schedulePendingDelta;
    private flushPendingDeltas;
    private computeOccupancyDelta;
    /**
     * Get the current cluster-wide occupancy count for a room.
     *
     * Reads from RoomStateStore (authoritative). Falls back to the local
     * activeRooms Map if the state-store throws OR if no state-store is
     * wired (single-node deployment / tests). Result is memoised for up
     * to `occupancyCacheTtlMs` (default 250ms) to keep WS-heartbeat-rate
     * callers from hammering Redis.
     */
    getRoomOccupancyCount(slug: string): Promise<number>;
    /**
     * Get the full member list for a room, cluster-wide.
     *
     * Same semantics as getRoomOccupancyCount — state-store first,
     * local-map fallback, short-TTL cache. The returned array is sorted
     * by joinedAt ascending when the state-store implementation
     * supports it (both InMemoryRoomStateStore and RedisRoomStateStore
     * do today).
     */
    getRoomMembers(slug: string): Promise<RoomMemberSnapshot[]>;
    private collectFullSnapshot;
    sendError(clientId: string, message: string): void;
    getStats(): {
        stateful: true;
        activeRooms: number;
        trackedClients: number;
        indexSubscribers: number;
        roomSubscribers: number;
    };
}
export default RoomService;
//# sourceMappingURL=RoomService.d.ts.map