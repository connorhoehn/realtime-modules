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
//   - Legacy single-target `targetUserId` coerced into 1-element
//     `targetUserIds`.
//
// Left behind in gateway:
//   - enforceChannelPermission authz interceptor — replaced by the
//     `authorize` hook below (defaults to allow-all).
//   - ErrorCodes / createErrorResponse — inlined to a minimal shape
//     matching the gateway-original error frame.
//   - The prom shadow counter wiring (src/observability/metrics).
//     Consumers expose a `recordCallAction` callback via CallConfig.

/** Verbs allowed on the call WS surface. */
export type CallAction = 'invite' | 'accepted' | 'declined' | 'cancelled' | 'ended';

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
    /** Legacy single-target field; coerced into 1-element targetUserIds. */
    targetUserId?: string;
    /** Originating user's id; FE supplies it for the self-filter on recipients. */
    callerId?: string;
    /** Free-form pass-through (callerName, avatarUrl, ringtone, …). */
    [k: string]: unknown;
}

/**
 * Outbound envelope written to each recipient's WS. Shape is byte-faithful
 * to the gateway original so the FE banner code keeps working unchanged.
 */
export interface CallEvent {
    type: 'call';
    action: CallAction | string;
    data: CallInvite;
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
 * gateway original.
 */
export interface UserClientMatch {
    clientId: string;
    userId: string;
}

/**
 * The MessageRouter slice CallService needs (the M3 seam). Kept narrow
 * on purpose — these three verbs are the entire surface area.
 *
 *   - `getClientsByUserId(userIds, excludeClientId)` resolves authenticated
 *     userIds → clientId matches. The future Redis cross-replica resolver
 *     drops in here without touching CallService.
 *   - `sendToClient(clientId, message)` writes to one socket. May return
 *     false on closed sockets, and may throw (sync or async) when the
 *     publish path errors; CallService uses Promise.allSettled so a
 *     single failure does not short-circuit the rest.
 *   - `broadcastToAll(message, excludeClientId)` fans out to every
 *     connected client (sender excluded).
 */
export interface CallMessageRouter {
    getClientsByUserId?(userIds: string[], excludeClientId: string): UserClientMatch[];
    sendToClient(clientId: string, message: unknown): boolean | Promise<boolean | void> | void;
    broadcastToAll(message: unknown, excludeClientId: string): Promise<void> | void;
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
     * Optional metrics sink. Called for every successfully-dispatched
     * action with the targetKind discriminator. Consumers wire this to
     * their prom registry / CloudWatch collector / whatever.
     */
    recordCallAction?: (action: CallAction, targetKind: 'targeted' | 'broadcast') => void;
}

/**
 * Options bag for the lifted CallService constructor. Replaces the
 * gateway original's positional `(messageRouter, logger, metricsCollector)`
 * so additional dependencies can be added without breaking call sites.
 */
export interface CallServiceOptions {
    messageRouter: CallMessageRouter;
    logger: CallLogger;
    config?: CallConfig;
}

/** Minimal error envelope; mirrors the gateway createErrorResponse shape. */
export interface CallErrorFrame {
    type: 'error';
    service: 'call';
    message: string;
    timestamp: string;
}

/** Verbs accepted by `handleAction`. Exposed for consumer dispatch tables. */
export const ALLOWED_CALL_ACTIONS: ReadonlySet<CallAction> = new Set<CallAction>([
    'invite',
    'accepted',
    'declined',
    'cancelled',
    'ended',
]);
