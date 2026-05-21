/**
 * Per-mode configuration for the built-in cursor catalog. `requiredFields`
 * gate validatePositionForMode (must all be present + numeric per mode);
 * `optionalFields` are advisory.
 */
export interface CursorModeConfig {
    name: string;
    description: string;
    requiredFields: string[];
    optionalFields: string[];
}
/**
 * A single cursor record as stored in clientCursors / channelCursors and
 * broadcast to subscribers. Shape preserved from the gateway original so
 * the WS wire surface stays byte-identical.
 */
export interface CursorData {
    clientId: string;
    channel: string;
    position: Record<string, unknown>;
    metadata: Record<string, unknown> & {
        mode: string;
        userInitials: string;
        userColor: string;
    };
    /** ISO-8601 — generation timestamp. */
    timestamp: string;
}
/**
 * Inbound cursor-update frame contents (the `data` body of a
 * `{ type: 'cursor', action: 'update', … }` WS message).
 */
export interface CursorUpdate {
    channel: string;
    position: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    /** Cursor mode — `freeform` | `table` | `text` | `canvas` (default freeform). */
    mode?: string;
}
/**
 * Optional construction-time tunables. All defaults come from `manifest.ts`
 * env-var declarations; this is the runtime-override path (mainly for tests
 * and per-deployment overrides).
 */
export interface CursorConfig {
    /** Per-client min interval (ms) between accepted updates. Default 250. */
    throttleInterval?: number;
    /** Cursor TTL (ms). Cursors older than this are evicted by the sweep. Default 30000. */
    cursorTTL?: number;
    /** Periodic-sweep interval (ms). Default 10000. */
    cleanupInterval?: number;
    /**
     * Override or extend the supported-modes catalog. When provided,
     * REPLACES the built-in 4-mode catalog (consumers wanting to extend
     * must spread `DEFAULT_SUPPORTED_MODES` themselves).
     */
    supportedModes?: Record<string, CursorModeConfig>;
    /**
     * Authorization hook. Called before honouring a subscribe action.
     * Return false to deny (the service emits an error frame and the
     * client is NOT subscribed). Default: allow all.
     *
     * Replaces gateway's authz-interceptor coupling: consumers wire any
     * policy they like (RBAC, OAuth scopes, room ownership, etc.).
     */
    authorizeChannel?: (clientId: string, channel: string) => boolean;
}
/**
 * The MessageRouter slice CursorService needs. Kept narrow on purpose: the
 * only verbs used are per-client send + per-channel subscribe/unsubscribe/
 * send. CursorService requires a router (no local-only mode is supported,
 * matching the gateway original's `messageRouter is required` invariant).
 */
export interface CursorMessageRouter {
    sendToClient(clientId: string, message: unknown): void;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string): void | Promise<void>;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
}
/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface CursorLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}
/**
 * Optional metrics sink. Mirrors the subset gateway's MetricsCollector
 * exposes that CursorService actually called.
 */
export interface CursorMetricsCollector {
    recordError(code: string): void;
}
/**
 * Options bag for the lifted CursorService constructor. Replaces the
 * original positional `(messageRouter, logger, metricsCollector)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 */
export interface CursorServiceOptions {
    /** Router for cross-node fan-out. Required. */
    messageRouter: CursorMessageRouter;
    logger: CursorLogger;
    metricsCollector?: CursorMetricsCollector | null;
    config?: CursorConfig;
}
/**
 * Built-in cursor-mode catalog (freeform / table / text / canvas). Frozen
 * so consumers don't accidentally mutate the shared module-level object.
 */
export declare const DEFAULT_SUPPORTED_MODES: Readonly<Record<string, CursorModeConfig>>;
/** Minimal error envelope; mirrors the gateway createErrorResponse shape. */
export interface CursorErrorFrame {
    type: 'error';
    service: 'cursor';
    error: {
        code: string;
        message: string;
        timestamp: string;
        service: 'cursor';
        clientId: string;
    };
}
/** Default error code emitted when sendError is called without an explicit code. */
export declare const DEFAULT_ERROR_CODE = "SERVICE_INTERNAL_ERROR";
/** Default tunables — keep in sync with manifest env-var defaults. */
export declare const DEFAULT_THROTTLE_INTERVAL_MS = 250;
export declare const DEFAULT_CURSOR_TTL_MS = 30000;
export declare const DEFAULT_CLEANUP_INTERVAL_MS = 10000;
//# sourceMappingURL=types.d.ts.map