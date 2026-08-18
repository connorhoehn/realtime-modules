// realtime-modules/src/typed-documents/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// DocumentEventsService.
//
// Lift scope (Wave 2): WS subscription tracking + subscribe/unsubscribe
// action handlers only. Everything persistence-side stays in the gateway
// (the typed-document repository, the wizard CRUD endpoints, validation
// rules, bulk-import logic). This module is intentionally agnostic of how
// document events are PUBLISHED — gateway / social-api / platform-api
// publish directly to the `doc-comments:{documentId}` and `doc:{documentId}`
// Redis channels and the module just owns the subscriber half.
//
// See manifest.ts for tunable env vars (only the documentId length cap is
// exposed today; the channel pattern is hard-coded for compat).

/**
 * Per-document subscription event delivered to a client. The frame shape
 * is preserved byte-identically to the gateway original so existing
 * frontend listeners continue to parse it without change.
 *
 * `action` is one of:
 *   - 'subscribed'   — emitted in response to a successful subscribe
 *   - 'unsubscribed' — emitted in response to a successful unsubscribe
 *
 * Note: the actual document-events fan-out (comments, reviews, items,
 * workflows) goes through the channel router as `{ type: 'document-events',
 * ...payload }` frames published by social-api / platform-api; those
 * frames are out of scope for this module — it only owns the
 * subscription-management ack frames.
 */
export interface DocumentSubscriptionFrame {
    type: 'document-events';
    action: 'subscribed' | 'unsubscribed';
    documentId: string;
    /** ISO-8601. */
    timestamp: string;
}

/** Minimal error envelope; mirrors gateway's document-events error shape. */
export interface DocumentErrorFrame {
    type: 'error';
    service: 'document-events';
    message: string;
    /** ISO-8601. */
    timestamp: string;
}

/**
 * Optional construction-time tunables. Defaults match gateway's hard-coded
 * 100-character documentId cap.
 */
export interface DocumentEventsConfig {
    /** Hard cap on documentId length accepted by handleSubscribe. Default 100. */
    maxDocumentIdLength?: number;
}

/**
 * The MessageRouter slice DocumentEventsService needs. Kept narrow on
 * purpose — only the four verbs the original service called.
 *
 * Implementations MUST tolerate both sync and async returns from
 * subscribe/unsubscribe; sendToClient is fire-and-forget.
 */
export interface DocumentEventsMessageRouter {
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
}

/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface DocumentEventsLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}

/**
 * Optional metrics sink. The gateway original accepted a metricsCollector
 * positional arg but never called it; we keep the slot so consumers that
 * already pass one through don't have to rewire, and so future error
 * counters can be plumbed without a constructor change.
 */
export interface DocumentEventsMetricsCollector {
    recordError(code: string): void;
}

/**
 * Options bag for the lifted DocumentEventsService constructor. Replaces
 * the original positional `(messageRouter, logger, metricsCollector)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 *
 * `messageRouter` may be null — sendToClient/sendError become no-ops and
 * subscribe/unsubscribe still update the local SubscriptionTracker. This
 * mirrors gateway's defensive `if (this.messageRouter)` guards.
 */
export interface DocumentEventsServiceOptions {
    messageRouter?: DocumentEventsMessageRouter | null;
    logger: DocumentEventsLogger;
    metricsCollector?: DocumentEventsMetricsCollector | null;
    config?: DocumentEventsConfig;
}
