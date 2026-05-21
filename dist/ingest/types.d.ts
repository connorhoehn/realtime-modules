/**
 * The valid ingest WS channel patterns. Subscribers attach to one of:
 *   - 'ingest:progress'           — all ingest progress events
 *   - 'ingest:source:<sourceId>'  — events scoped to one ingest source
 */
export type IngestEventChannel = 'ingest:progress' | `ingest:source:${string}`;
/**
 * Shape of an event broadcast by the upstream ingest engine. The lifted
 * service is event-agnostic — it forwards whatever the bridge hands it.
 * Common `type` values include: sync.started, sync.file.fetched,
 * item.status, item.mapped, item.materialized, item.pipeline.spawned,
 * item.failed, sync.completed, source.status.
 */
export interface IngestEvent {
    type: string;
    sourceId?: string;
    [key: string]: unknown;
}
/**
 * The frame delivered to subscribed WS clients.
 */
export interface IngestFrame {
    type: 'ingest:event';
    event: IngestEvent;
    channel: string;
    /** ISO-8601 timestamp at emit time. */
    timestamp: string;
}
/**
 * The MessageRouter slice IngestService needs. Kept narrow on purpose:
 * the only verbs it actually uses are per-client send + per-channel
 * subscribe/unsubscribe/send. When `messageRouter` is null the service
 * runs in single-node "local" mode and falls back to
 * _broadcastToLocalSubscribers.
 */
export interface IngestMessageRouter {
    sendToClient(clientId: string, message: unknown): void;
    sendToChannel(channel: string, message: unknown): void | Promise<void>;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
}
/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface IngestLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}
/**
 * Optional metrics sink. Reserved for future use — the gateway original
 * threaded a metricsCollector through but never called into it. Kept on
 * the options bag so consumers can wire one without a constructor break
 * when emit-side metrics are eventually added.
 */
export interface IngestMetricsCollector {
    recordError?(code: string): void;
}
/**
 * Optional construction-time tunables.
 */
export interface IngestConfig {
    /** Max length of an accepted channel name. Default 100. */
    maxChannelLength?: number;
}
/**
 * Options bag for the lifted IngestService constructor. Replaces the
 * original positional `(messageRouter, logger, metricsCollector)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 */
export interface IngestServiceOptions {
    /** Router for cross-node fan-out. Pass null/undefined for local mode. */
    messageRouter?: IngestMessageRouter | null;
    logger: IngestLogger;
    metricsCollector?: IngestMetricsCollector | null;
    config?: IngestConfig;
}
//# sourceMappingURL=types.d.ts.map