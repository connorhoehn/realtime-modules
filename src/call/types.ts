// realtime-modules/src/call/types.ts
//
// Wire shapes + construction-time tunables for the lifted CallService.
//
// SCOPE — this module is hangout/call **invite signaling** only. It is
// not WebRTC, not SDP exchange, not ICE/TURN, not SFU media-plane
// signaling. The frontend's useVideoCall talks to platform-api for the
// actual media negotiation; this service simply fans out 5 lifecycle
// events (invite/accepted/declined/cancelled/ended) between users over
// the existing WS connection.
//
// Lift scope (Wave 2 catch-up):
//   - WS handleAction for the 5-action protocol.
//   - Targeted user routing via MessageRouterContract.getClientsByUserId,
//     plus broadcast fallback when no targets are supplied.
//
// Left behind in gateway:
//   - enforceChannelPermission authz interceptor — replaced by the
//     `authorize` hook below (defaults to allow-all).
//   - ErrorCodes / createErrorResponse — inlined to a minimal shape
//     matching the gateway-original error frame.
//   - The prom shadow counter wiring (src/observability/metrics).
//     Consumers expose a `recordCallAction` callback via CallConfig.

/** Verbs allowed on the call WS surface. */
export type CallAction =
    | 'invite'
    | 'accepted'
    | 'declined'
    | 'cancelled'
    | 'ended'
    /** In-call broadcast: peer publishes displayName + screen-sharing flag.
     *  Receivers merge into their remoteParticipantState map so the grid
     *  tile renders real names instead of opaque participantIds. */
    | 'participant-state'
    /** In-call broadcast: presence-style status (in-call, on-hold).
     *  Receivers can dim sidebars, suppress invites, etc. */
    | 'user-status'
    /** F3 (2026-08-21) — client → server query: "is there an active call
     *  in this lobby?" Server replies to the SENDER ONLY with an
     *  `active-call` envelope (never broadcast). Lets a freshly connected
     *  client discover an in-progress group call it was never invited to
     *  (or reconnect-discover one it left) without any HTTP roundtrip. */
    | 'status'
    /** F3 — server → client reply to `status`. data: { lobbyName,
     *  active, callId?, callerId?, callerName?, startedAt?,
     *  participantCount?, participantUserIds? }. */
    | 'active-call';

/**
 * Wire-form payload supplied by the FE alongside a call action. All
 * fields are optional at this layer — `invite` enforces callId+lobbyName
 * specifically; other actions are pass-through.
 */
export interface CallInvite {
    /** Stable per-call identifier (FE-generated UUID). Required on invite. */
    callId?: string;
    /** Human-readable lobby name shown in recipient UI. Required on invite. */
    lobbyName?: string;
    /** Preferred multi-target list. Empty/missing → broadcast. */
    targetUserIds?: string[];
    /** Originating user's id; FE supplies it for the self-filter on recipients. */
    callerId?: string;
    /** Free-form pass-through (callerName, avatarUrl, ringtone, …). */
    [k: string]: unknown;
}

/**
 * In-call broadcast payload for `participant-state` and `user-status` verbs.
 * Distinct from CallInvite because the field set is different and
 * load-bearing fields (participantId, callId, callerId, lobbyName) are NOT
 * actually optional at the room-bridge call site — passing them via
 * CallInvite + `as any` casts was masking missing-field bugs (see room
 * occupancy index corruption in HangoutOverlay.tsx late-join rebroadcast).
 *
 * FE-emitted fields are still permitted via the index signature for forward-
 * compat with new badges (e.g. handRaised) without a wire-protocol bump.
 */
export interface ParticipantStateBroadcast {
    /** SFU participant id — required for room bridge dedup and tile mapping. */
    participantId?: string;
    /** Stable per-call identifier. */
    callId?: string;
    /** Originating user's id. */
    callerId?: string;
    /** Lobby scoping key (e.g. `room:<slug>` or `global-hangout`). */
    lobbyName?: string;
    /** Human-readable name for the grid tile. */
    displayName?: string;
    /** True when the peer's screen-share producer is live. */
    screenSharing?: boolean;
    /** True when the peer's camera is enabled. Undefined treated as true (legacy). */
    cameraOn?: boolean;
    /** True when the peer's mic is unmuted. Undefined treated as true (legacy). */
    audioOn?: boolean;
    /** For `user-status` verb: 'in-call' | 'left' | 'on-hold' etc. */
    status?: string;
    /** Legacy displayName source. */
    callerName?: string;
    /** Forward-compat for additional badges. */
    [k: string]: unknown;
}

/** Type guard for participant-state / user-status payloads. */
export function isParticipantStateBroadcast(p: unknown): p is ParticipantStateBroadcast {
    return typeof p === 'object' && p !== null;
}

/**
 * Outbound envelope written to each recipient's WS. Shape is byte-faithful
 * to the gateway original so the FE banner code keeps working unchanged.
 */
export interface CallEvent {
    type: 'call';
    action: CallAction | string;
    data: CallInvite | ParticipantStateBroadcast;
    /** ISO-8601 timestamp; generated at envelope-build time. */
    timestamp: string;
}

/**
 * Logger contract. Matches the project's pino-like surface. Pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface CallLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}

/**
 * One match from `getClientsByUserId`. clientId is what CallService
 * actually routes to; userId is kept for logging/debug parity with the
 * gateway original. `nodeId` identifies the owning replica — local clients
 * carry this node's id, remote clients carry the peer node's id. Callers
 * generally don't need to branch on nodeId: `messageRouter.sendToClient`
 * routes via the per-node direct-message Redis pub/sub channel
 * transparently.
 */
export interface UserClientMatch {
    clientId: string;
    userId: string;
    nodeId?: string;
}

/**
 * The MessageRouter slice CallService needs (the M3 seam). Kept narrow
 * on purpose — these three verbs are the entire surface area.
 *
 *   - `getClientsByUserId(userIds, excludeClientId)` resolves authenticated
 *     userIds → clientId matches across the entire cluster (Redis-backed).
 *     Async: reads `websocket:user:<userId>:clients` hash + merges with the
 *     local in-memory scan.
 *   - `sendToClient(clientId, message)` writes to one socket. May return
 *     false on closed sockets, and may throw (sync or async) when the
 *     publish path errors; CallService uses Promise.allSettled so a
 *     single failure does not short-circuit the rest. Routes cross-node
 *     automatically when the clientId is owned by a peer replica.
 *   - `broadcastToAll(message, excludeClientId)` fans out to every
 *     connected client (sender excluded).
 */
export interface CallMessageRouter {
    getClientsByUserId?(
        userIds: string[],
        excludeClientId: string,
    ): UserClientMatch[] | Promise<UserClientMatch[]>;
    sendToClient(clientId: string, message: unknown): boolean | Promise<boolean | void> | void;
    broadcastToAll(message: unknown, excludeClientId: string): Promise<void> | void;
    /**
     * P5.2 — narrow accessor for the authed userId of a local client.
     * Used by `accepted` fan-out to route to the accepter's sibling
     * tabs (so they stop ringing). Returns null when the client isn't
     * known locally OR has no userContext.userId. Optional so existing
     * test implementations stay valid.
     */
    getUserIdForClient?(clientId: string): string | null;

    /**
     * Liveness probe — sync check that a clientId is locally connected
     * AND the underlying WebSocket is in OPEN readyState. Returns:
     *   - `true`  — local, open socket; safe to send
     *   - `false` — local socket exists but is closed/closing; ghost
     *   - `null`  — clientId is NOT local (could be on a peer node, or
     *               a stale Redis index entry from a crashed process);
     *               caller cannot determine liveness synchronously
     *
     * CallService uses this to skip ghost local sessions before fan-out
     * so we don't bump the failure counter on sockets we already know
     * are dead. Optional — implementations without it fall back to
     * trusting the index + sendToClient's silent-false return.
     */
    isClientLive?(clientId: string): boolean | null;
}

/**
 * Optional construction-time tunables. All hooks default to no-op /
 * allow-all so the service is usable without any wiring.
 */
export interface CallConfig {
    /**
     * Authorization hook. Called once per handleAction invocation BEFORE
     * any routing happens. Return false to deny (the service emits an
     * error frame and the action is dropped). Default: allow all.
     *
     * Replaces gateway's enforceChannelPermission interceptor — call
     * routing is direct user-to-user so there's no channel to gate, but
     * consumers may still want RBAC (e.g. block guest-mode initiations).
     */
    authorize?: (clientId: string, action: CallAction, data: CallInvite) => boolean;

    /**
     * Cross-user policy gate for `invite` actions ONLY. Called AFTER
     * `authorize` passes the callerId-spoof check. Receives the resolved
     * callerId (authenticated) plus the resolved targetUserIds (empty
     * array for broadcasts). Return false (or a Promise that resolves
     * false) to deny — the service emits an error frame and the action
     * is dropped without fan-out.
     *
     * Production wires this to a platform-api endpoint that returns
     * mutual-follow / org-membership / not-blocked. Dev/Tilt leaves it
     * undefined so any user can call any user.
     *
     * For broadcasts (empty targetUserIds), the hook is passed an empty
     * array — consumers can deny broadcast entirely by checking
     * `targetUserIds.length === 0`.
     */
    canCall?: (
        callerId: string,
        targetUserIds: string[],
    ) => boolean | Promise<boolean>;

    /**
     * Optional metrics sink. Called for every successfully-dispatched
     * action with the targetKind discriminator. Consumers wire this to
     * their prom registry / CloudWatch collector / whatever.
     */
    recordCallAction?: (action: CallAction, targetKind: 'targeted' | 'broadcast') => void;

    /**
     * Optional persistence hook for the call→session binding. Called on
     * `invite` (with caller's data) and `accepted` (with accepter's
     * data). The recording-completed webhook later uses this to map
     * channelArn → callId so the recording can be associated with the
     * correct call participants. No-op when undefined.
     */
    persistCallBinding?: (binding: {
        callId: string;
        callerId: string;
        lobbyName: string;
        clientId: string;
        action: 'invite' | 'accepted';
    }) => Promise<void> | void;
}

/**
 * Sync leadership check for the invite-sweep timer.  When wired and
 * returns `false`, the sweeper tick is skipped (a peer node owns the
 * sentinel and will run it instead).  When unwired (undefined) or
 * returns `true`, the sweeper runs locally — matching N=1 / pre-PR-W2.4
 * behaviour byte-for-byte.
 *
 * Optional callback so existing unit tests that build CallService
 * without a sweeper-leader continue to pass; the gateway wires this from
 * createSweeperLeader(SWEEPER_SENTINELS.CALL_INVITE) at server boot.
 */
export type CallSweeperIsLeader = () => boolean;

/**
 * Options bag for the lifted CallService constructor. Replaces the
 * gateway original's positional `(messageRouter, logger, metricsCollector)`
 * so additional dependencies can be added without breaking call sites.
 */
export interface CallServiceOptions {
    messageRouter: CallMessageRouter;
    logger: CallLogger;
    config?: CallConfig;
    /**
     * Optional CallStateStore implementation. When provided, CallService
     * delegates per-call state to it (Redis-backed for multi-replica
     * durability). When undefined, falls back to per-process in-memory
     * Maps (today's behavior, fine for single-node deployments).
     */
    stateStore?: import('./CallStateStore').CallStateStore;
    /**
     * Optional cross-node pub/sub adapter for P1 multi-replica safety.
     * When provided, CallService publishes a `call:client-departed`
     * event on disconnect, and other nodes receive it + fire synthetic
     * `ended` to peers they own. Without this, a multi-replica gateway
     * leaks call state across the partition boundary.
     *
     * Implementation note: the gateway wires this from the existing
     * RedisPubSubManager so it shares the connection pool with channel-
     * message routing. Single-node deployments leave it undefined.
     */
    crossNodePubSub?: CallCrossNodePubSub;
    /**
     * PR-W2.4 — sync leadership check for the per-tick invite sweeper.
     * When provided and returns false, the tick is skipped + a
     * `cleanup_skipped_total{sweeper="call_invite",reason="not_leader"}`
     * metric is incremented.  When omitted, the sweeper runs every tick
     * (pre-PR / N=1 behaviour).
     */
    sweeperIsLeader?: CallSweeperIsLeader;
    /**
     * PR-W2.4 — optional metric hook called whenever a sweeper tick is
     * skipped because `sweeperIsLeader()` returned false.  Gateway wires
     * this to `recordCleanupSkipped('call_invite', 'not_leader')`.
     * Tests can pass a jest spy to assert skip counts.
     */
    onSweepSkipped?: (reason: 'not_leader') => void;
    /**
     * Optional tracing seam (v0.18.0 extraction). handleAction wraps each
     * dispatch in `withSpan('call.<action>', attrs, fn)` when provided.
     * The gateway wires distributed-core's `withSpan`; when omitted the
     * handler runs unwrapped — this library deliberately does not depend
     * on distributed-core, so tracing is the consumer's to supply.
     */
    withSpan?: CallWithSpan;
}

/** Shape of the injectable tracing wrapper (matches distributed-core's withSpan). */
export type CallWithSpan = <T>(
    name: string,
    attrs: Record<string, string | number | boolean>,
    fn: (span: { setAttribute: (k: string, v: string | number | boolean) => void }) => T | Promise<T>,
    opts?: { tracerName?: string },
) => Promise<T>;

/**
 * Narrow contract for the cross-node pub/sub coupling. Lets CallService
 * stay decoupled from Redis specifics — tests + single-node deployments
 * can pass null/undefined and the in-memory disconnect path still works.
 */
export interface CallCrossNodePubSub {
    /** Publish a cross-node call event. Topic is internal to CallService. */
    publish(topic: string, payload: string): Promise<void> | void;
    /** Subscribe to a cross-node call event. Returns unsubscribe fn. */
    subscribe(topic: string, handler: (payload: string) => void): () => void;
}

/** Minimal error envelope; mirrors the gateway createErrorResponse shape. */
export interface CallErrorFrame {
    type: 'error';
    service: 'call';
    message: string;
    timestamp: string;
}

/**
 * Per-call signaling state used by the in-process active-invite registry.
 * Replay-on-connect needs enough of the original invite payload to
 * reconstruct the toast envelope when a freshly-connected client picks
 * up an invite that fired before they were online.
 */
export interface ActiveCallState {
    callerId: string;
    lobbyName: string;
    targetUserIds: string[];
    participantClientIds: Set<string>;
    invitedAt?: number;
    inviteExpiresAt?: number;
    originalCallerName?: string;
    originalLobbyName?: string;
    originalTargetUserIds?: string[];
}

/** Verbs accepted by `handleAction`. Exposed for consumer dispatch tables. */
export const ALLOWED_CALL_ACTIONS: ReadonlySet<CallAction> = new Set<CallAction>([
    'invite',
    'accepted',
    'declined',
    'cancelled',
    'ended',
    'participant-state',
    'user-status',
]);
