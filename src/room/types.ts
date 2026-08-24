// realtime-modules/src/room/types.ts
//
// Wire shapes + construction-time contracts for the new 'room' WS
// service. Distinct from CallService — RoomService is about live
// occupancy of named rooms (slug-addressed: 'lounge', 'standup', …)
// rather than the 1:1/N-target invite signaling that CallService owns.
//
// Two subscriber surfaces:
//
//   1. Per-room subscribers ('subscribe' / 'unsubscribe' with `{slug}`):
//      receive `member-joined` / `member-left` events for that one room.
//      Powers the per-room sidebar/header avatar strips.
//
//   2. Index subscribers ('subscribe-index' / 'unsubscribe-index'):
//      receive aggregated `occupancy-delta` snapshots covering every
//      room with non-zero membership. Powers the sidebar/index page
//      that lists all rooms + their current head-counts. Aggregated +
//      debounced (500ms) so a burst of joins/leaves coalesces into a
//      single frame.
//
// Membership ingress (W3) — for this pass we ride on the existing
// call WS surface: when a client emits `participant-state` for a
// `room:*` lobby, CallService records them as a room member via a
// thin RoomService.handleMemberJoined call. This avoids the
// cross-service HTTP plumbing (platform-api → gateway /internal/rooms
// /event) that the long-term design wants but is overkill for W3.
// The internal HMAC-signed endpoint can be added later without
// changing RoomService's public surface.

/** Verbs allowed on the room WS surface. */
export type RoomAction =
    | 'subscribe-index'
    | 'unsubscribe-index'
    | 'subscribe'
    | 'unsubscribe'
    | 'join'
    | 'leave'
    /** UX audit 2026-08-24 — client → server relay of a room lifecycle
     *  change the client just performed via REST (created/archived/
     *  updated). The gateway fans the event out to every rooms:index
     *  subscriber (all nodes) so other users' sidebars update without a
     *  reload. This is an ANNOUNCEMENT, not authority: the rooms list's
     *  source of truth stays the REST API — receivers merely merge/
     *  refetch. Payload: { event: 'created'|'updated'|'archived', slug,
     *  room? (full entity passthrough) }. */
    | 'announce';

/** Verbs accepted by `handleAction`. Exposed for consumer dispatch tables. */
export const ALLOWED_ROOM_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
    'subscribe-index',
    'unsubscribe-index',
    'subscribe',
    'unsubscribe',
    'join',
    'leave',
    'announce',
]);

/** Lifecycle events relayable via `announce`. */
export const ROOM_ANNOUNCE_EVENTS = ['created', 'updated', 'archived'] as const;
export type RoomAnnounceEvent = (typeof ROOM_ANNOUNCE_EVENTS)[number];

/**
 * Wire-form payload supplied by the FE alongside a room action. All
 * fields are optional at this layer — `subscribe`/`unsubscribe` enforce
 * `slug` specifically; index variants ignore it.
 */
export interface RoomActionPayload {
    /** Target room slug for per-room subscribe/unsubscribe. */
    slug?: string;
    /** Free-form pass-through for future expansion. */
    [k: string]: unknown;
}

/**
 * One member record as it appears on the wire. Mirrors what the FE
 * needs to render an avatar tile — userId for identity, displayName for
 * the chip, participantId so it can correlate with the call grid.
 */
export interface RoomMemberRecord {
    userId: string;
    displayName: string;
    participantId: string;
}

/**
 * Aggregated per-room delta sent to `rooms:index` subscribers. `count`
 * is the post-change member count; `members` is the full current set
 * (capped client-side for very large rooms). Sending the full set —
 * rather than just the change — keeps the FE state machine trivial:
 * receivers overwrite their cached entry for `slug` with whatever the
 * server most recently said.
 */
export interface RoomOccupancyDelta {
    slug: string;
    count: number;
    members: RoomMemberRecord[];
}

/**
 * Outbound envelope written to subscribers. The discriminator union
 * carries the per-action payload shape. Byte-shape kept simple so the
 * FE can `switch (msg.action)` without re-validating.
 */
export type RoomServerEvent =
    | {
        type: 'room';
        action: 'member-joined';
        data: { slug: string; userId: string; displayName: string; participantId: string };
        timestamp: string;
    }
    | {
        type: 'room';
        action: 'member-left';
        data: { slug: string; userId: string };
        timestamp: string;
    }
    | {
        type: 'room';
        action: 'occupancy-delta';
        data: { deltas: RoomOccupancyDelta[] };
        timestamp: string;
    }
    | {
        type: 'room';
        action: 'created';
        /** `room` — full entity passthrough from the announcing client's
         *  REST create response, so receivers can merge without a
         *  refetch (useHangoutRooms's room.created case needs it). */
        data: { slug: string; name?: string; room?: Record<string, unknown> };
        timestamp: string;
    }
    | {
        type: 'room';
        action: 'updated';
        data: { slug: string; room?: Record<string, unknown> };
        timestamp: string;
    }
    | {
        type: 'room';
        action: 'archived';
        data: { slug: string; room?: Record<string, unknown> };
        timestamp: string;
    };

/**
 * Logger contract. Matches the project's pino-like surface. Pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface RoomLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}

/**
 * The MessageRouter slice RoomService needs. Narrowed to the two verbs
 * we actually use — `sendToClient` for targeted fan-out to subscribers,
 * `broadcastToAll` is intentionally absent (every room frame is
 * subscription-scoped, never cluster-wide).
 */
export interface RoomMessageRouter {
    sendToClient(clientId: string, message: unknown): boolean | Promise<boolean | void> | void;
    /** Optional accessor for the connected client's userContext — used by
     *  the WS-driven `room:join` / `room:leave` handlers to derive userId
     *  + displayName when the FE doesn't echo them on the envelope. The
     *  real MessageRouter exposes `getClientData(clientId)` returning
     *  `{ userContext: {...} }`; tests may stub this to undefined. */
    getClientData?: (clientId: string) => { userContext?: { userId?: string; displayName?: string } } | null;
}

/**
 * Narrow contract for the cross-node pub/sub coupling. Lets RoomService
 * stay decoupled from Redis specifics — tests + single-node deployments
 * can pass null/undefined and the local-only path still works.
 */
export interface RoomCrossNodePubSub {
    /** Publish a cross-node room event. Topic format: `room:event:<verb>`. */
    publish(topic: string, payload: string): Promise<void> | void;
    /** Subscribe to a cross-node room event. Returns unsubscribe fn. */
    subscribe(topic: string, handler: (payload: string) => void): () => void;
}

/** Minimal error envelope; mirrors the gateway createErrorResponse shape. */
export interface RoomErrorFrame {
    type: 'error';
    service: 'room';
    message: string;
    timestamp: string;
}

/**
 * Per-room member entry kept in-process for fast subscriber fan-out.
 * The cross-node mirror lives in RoomStateStore (Redis).
 */
export interface RoomMemberLocal {
    clientId: string;
    userId: string;
    displayName: string;
    participantId: string;
}

/**
 * Cross-node event payload. Carries everything a peer node needs to
 * mirror its local Map state and fan out to its own subscribers.
 */
export interface CrossNodeRoomEvent {
    verb: 'member-joined' | 'member-left' | 'lifecycle';
    slug: string;
    clientId: string;
    userId: string;
    displayName?: string;
    participantId?: string;
    sourceNodeId?: string;
    /** verb === 'lifecycle' only — which lifecycle event to relay. */
    event?: RoomAnnounceEvent;
    /** verb === 'lifecycle' only — full room entity passthrough. */
    room?: Record<string, unknown>;
}

/** Topic naming pattern for cross-node room events. */
export const CROSS_NODE_ROOM_TOPIC = 'room:event';

/**
 * Optional construction-time tunables. All defaults are sensible for
 * dev/Tilt; production wires the cross-node pub/sub + state store.
 */
export interface RoomConfig {
    /** Debounce window for aggregated occupancy-delta frames. Default 500ms. */
    occupancyDebounceMs?: number;
    /** Per-room member cap echoed in occupancy-delta `members[]`. Default 50. */
    maxMembersPerDelta?: number;
    /**
     * Cache TTL (ms) for getRoomOccupancyCount / getRoomMembers reads
     * against RoomStateStore. Audit #8 — WS heartbeat handlers can call
     * these dozens of times per second; the cache coalesces them into
     * one Redis hit per slug per window. Default 250ms; set 0 to
     * disable. Cache is invalidated on local mutation so writers see
     * their own effects without waiting for TTL.
     */
    occupancyCacheTtlMs?: number;
}

/**
 * Options bag for the RoomService constructor.
 */
export interface RoomServiceOptions {
    messageRouter: RoomMessageRouter;
    logger: RoomLogger;
    config?: RoomConfig;
    /**
     * Optional RoomStateStore implementation. When provided, RoomService
     * delegates membership state to it (Redis-backed for multi-replica
     * durability). When undefined, falls back to per-process in-memory
     * Maps only — fine for single-node deployments and tests.
     */
    stateStore?: import('./RoomStateStore').RoomStateStore;
    /**
     * Optional cross-node pub/sub adapter. When provided, RoomService
     * publishes member-joined/left to peer nodes so subscribers on any
     * replica see the same occupancy stream.
     */
    crossNodePubSub?: RoomCrossNodePubSub;
    /** Stable id for this node — included in cross-node payloads for loop-suppression. */
    nodeId?: string;
    /**
     * Optional metric hooks (v0.18.0 extraction seam). The gateway wires
     * these to its observability layer; when omitted each is a no-op. The
     * `org` argument is derived from the room slug prefix.
     */
    metrics?: RoomMetricsHooks;
}

/** Injectable metric hooks — every field optional, every call best-effort. */
export interface RoomMetricsHooks {
    recordMemberJoined?: (org: string) => void;
    recordMemberLeft?: (org: string, reason: string) => void;
    setActiveCount?: (count: number) => void;
}
