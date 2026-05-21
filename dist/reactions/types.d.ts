/**
 * One reaction event as broadcast to subscribers and retained in the
 * per-channel history ring buffer. Field set is preserved from gateway's
 * original reaction-service so the WS wire surface stays byte-identical.
 */
export interface Reaction {
    id: string;
    clientId: string;
    channel: string;
    emoji: string;
    effect: string;
    /** Optional spatial coordinates (e.g. floating-emoji UI). Free-form. */
    position: unknown;
    metadata: Record<string, unknown>;
    /** ISO-8601 — generation timestamp. */
    timestamp: string;
}
/**
 * One row of the available-reactions catalog. `effect` is a free-form
 * string the client renders (CSS animation class, particle preset, …).
 */
export interface AvailableReaction {
    name: string;
    effect: string;
}
/**
 * Optional construction-time tunables. All defaults come from
 * `manifest.ts` env-var declarations; this is the runtime-override path
 * (mainly for tests and per-deployment overrides).
 */
export interface ReactionConfig {
    /** Max reactions retained per channel in the history ring buffer. Default 50. */
    maxHistorySize?: number;
    /** Max accepted channel name length. Default 50. */
    maxChannelNameLength?: number;
    /**
     * Override or extend the available-reactions catalog. When provided,
     * REPLACES the built-in catalog entirely (consumers wanting to extend
     * must spread `DEFAULT_AVAILABLE_REACTIONS` themselves).
     */
    availableReactions?: Record<string, AvailableReaction>;
    /**
     * Authorization hook. Called before honouring a subscribe action.
     * Return false to deny (the service emits an error frame and the
     * client is NOT added to the subscriber set). Default: allow all.
     *
     * Replaces gateway's authz-interceptor coupling: consumers wire any
     * policy they like (RBAC, OAuth scopes, room ownership, etc.).
     */
    authorizeChannel?: (clientId: string, channel: string) => boolean;
}
/**
 * The MessageRouter slice ReactionService needs. Kept narrow on purpose:
 * the only verbs it actually uses are per-client send + per-channel
 * subscribe/unsubscribe/send. When `messageRouter` is null the service
 * runs in single-node "local" mode and falls back to
 * broadcastToLocalChannel.
 */
export interface ReactionMessageRouter {
    sendToLocalClient?(clientId: string, message: unknown): void;
    sendToChannel(channel: string, message: unknown): void | Promise<void>;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
}
/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface ReactionLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}
/**
 * Optional metrics sink. Mirrors the subset gateway's MetricsCollector
 * exposes that ReactionService actually called.
 */
export interface ReactionMetricsCollector {
    recordError(code: string): void;
}
/**
 * Options bag for the lifted ReactionService constructor. Replaces the
 * original positional `(messageRouter, logger, metricsCollector)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 */
export interface ReactionServiceOptions {
    /** Router for cross-node fan-out. Pass null/undefined for local mode. */
    messageRouter?: ReactionMessageRouter | null;
    logger: ReactionLogger;
    metricsCollector?: ReactionMetricsCollector | null;
    config?: ReactionConfig;
}
/**
 * Built-in catalog: 12 emoji with paired effect tokens. Frozen so
 * consumers don't accidentally mutate the shared module-level object.
 */
export declare const DEFAULT_AVAILABLE_REACTIONS: Readonly<Record<string, AvailableReaction>>;
/** Minimal error envelope; mirrors the gateway createErrorResponse shape. */
export interface ReactionErrorFrame {
    type: 'error';
    service: 'reaction';
    error: {
        code: string;
        message: string;
        timestamp: string;
        service: 'reaction';
        clientId: string;
    };
}
/** Default error code emitted when sendError is called without an explicit code. */
export declare const DEFAULT_ERROR_CODE = "SERVICE_INTERNAL_ERROR";
//# sourceMappingURL=types.d.ts.map