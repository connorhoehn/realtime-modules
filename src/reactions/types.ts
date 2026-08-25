// realtime-modules/src/reactions/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// ReactionService.
//
// Lift scope (Wave 2): pure in-memory reaction fan-out. No persistence,
// no DDB, no Redis. Gateway-specific concerns left behind:
//   - ownership-cleanup-coordinator integration (_cleanupRoom / onLost)
//   - enforceChannelPermission interceptor (replaced with `authorizeChannel` hook)
//   - ErrorCodes / createErrorResponse coupling (inlined to minimal shape)
//
// See manifest.ts for tunable env vars.

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
    /**
     * Stable user id stamped at send time when an `identityResolver` is
     * configured; null/absent otherwise (anonymous or unresolvable sender).
     */
    userId?: string | null;
    /** Human-readable sender name stamped alongside `userId`. */
    displayName?: string;
    /**
     * Opaque per-target discriminator forwarded verbatim from the inbound
     * send frame (the client hook sends it top-level; see useReactions).
     * The service never interprets it — clients filter on it.
     */
    targetId?: unknown;
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
    /**
     * Sender-identity hook. Called at send time to stamp `userId` /
     * `displayName` onto the broadcast Reaction. A throwing resolver is
     * logged and treated as "no identity" (mirrors ChatService semantics);
     * null/undefined results are tolerated. Default: no stamping.
     */
    identityResolver?: (clientId: string) => { userId?: string; displayName?: string } | null | undefined;
    /**
     * Post-broadcast tap. Invoked AFTER the reaction has been fanned out,
     * fire-and-forget: sync throws are caught and logged, rejected promises
     * are .catch-ed and logged — a failing hook can never block or fail the
     * send path (the success ack is already on the wire). Consumers use it
     * for durable capture (e.g. gateway publishing call:reaction.recorded).
     */
    onReaction?: (reaction: Reaction) => void | Promise<void>;
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
export const DEFAULT_AVAILABLE_REACTIONS: Readonly<Record<string, AvailableReaction>> = Object.freeze({
    '❤️': { name: 'heart', effect: 'pulse-red' },
    '\u{1F602}': { name: 'laugh', effect: 'shake' },
    '\u{1F44D}': { name: 'thumbs-up', effect: 'bounce-green' },
    '\u{1F44E}': { name: 'thumbs-down', effect: 'bounce-red' },
    '\u{1F62E}': { name: 'wow', effect: 'zoom' },
    '\u{1F622}': { name: 'sad', effect: 'fade-blue' },
    '\u{1F621}': { name: 'angry', effect: 'shake-red' },
    '\u{1F389}': { name: 'party', effect: 'confetti' },
    '\u{1F525}': { name: 'fire', effect: 'flicker-orange' },
    '⚡': { name: 'lightning', effect: 'flash-yellow' },
    '\u{1F4AF}': { name: 'hundred', effect: 'spin-gold' },
    '\u{1F680}': { name: 'rocket', effect: 'fly-up' },
});

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
export const DEFAULT_ERROR_CODE = 'SERVICE_INTERNAL_ERROR';
