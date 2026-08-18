// realtime-modules/src/social/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// SocialService.
//
// Lift scope (Wave 2): the WS-side social-event subscription surface
// only.
//   - subscribe / unsubscribe / disconnect for social channels (per room)
//   - channelId validation (max length cap)
//   - frame shape ({ type: 'social', action, channelId, timestamp })
//
// Deliberately left in gateway / platform-api:
//   - all social-api CRUD (post, comment, like, member, …) — platform-api
//   - all publishing / broadcasting from social-api's Redis side —
//     platform-api's BroadcastService is the producer; this service is
//     subscribe-only on the WS edge.
//
// See manifest.ts for tunable env vars.

/**
 * The discrete social-event types broadcast on a subscribed channel.
 * The lifted service is event-agnostic at the wire level — it only
 * manages subscriptions; events are produced upstream by social-api's
 * BroadcastService and routed via the cross-node message router. This
 * type is exported so consumers wiring the producer side can stay in
 * sync with the canonical event vocabulary.
 */
export type SocialEventType =
    | 'social:post'
    | 'social:comment'
    | 'social:like'
    | 'social:member_joined'
    | 'social:member_left';

/**
 * One social event as broadcast to subscribed clients. The lifted
 * service does NOT produce these — they are produced by social-api's
 * BroadcastService and routed via the message router. Exported here so
 * consumers wiring the producer side have a single source of truth for
 * the wire shape.
 */
export interface SocialEvent {
    type: SocialEventType;
    /** The room channelId this event belongs to. */
    channelId: string;
    /** Free-form event payload — service-agnostic. */
    payload?: Record<string, unknown>;
    /** ISO-8601 emit timestamp. */
    timestamp?: string;
}

/**
 * The frame delivered to subscribed WS clients in response to subscribe
 * / unsubscribe actions. Confirmation acknowledgements only — actual
 * event delivery uses the SocialEvent shape above.
 */
export interface SocialFrame {
    type: 'social';
    action: 'subscribed' | 'unsubscribed';
    channelId: string;
    /** ISO-8601 timestamp at frame creation. */
    timestamp: string;
}

/**
 * The MessageRouter slice SocialService needs. Kept narrow on purpose:
 * the only verbs it actually uses are per-client send + per-channel
 * subscribe/unsubscribe. The service is subscribe-only on the WS edge
 * (no fan-out from this service), so there is no sendToChannel call.
 */
export interface SocialMessageRouter {
    sendToClient(clientId: string, message: unknown): void;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
}

/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface SocialLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}

/**
 * Optional metrics sink. Reserved for future use — the gateway original
 * threaded a metricsCollector through but never called into it. Kept on
 * the options bag so consumers can wire one without a constructor break
 * when edge-side metrics are eventually added.
 */
export interface SocialMetricsCollector {
    recordError?(code: string): void;
}

/**
 * Optional construction-time tunables.
 */
export interface SocialConfig {
    /** Max length of an accepted channelId. Default 100. */
    maxChannelIdLength?: number;
}

/**
 * Options bag for the lifted SocialService constructor. Replaces the
 * original positional `(messageRouter, logger, metricsCollector)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 */
export interface SocialServiceOptions {
    /** Router for cross-node fan-out. Pass null/undefined for local mode. */
    messageRouter?: SocialMessageRouter | null;
    logger: SocialLogger;
    metricsCollector?: SocialMetricsCollector | null;
    config?: SocialConfig;
}
