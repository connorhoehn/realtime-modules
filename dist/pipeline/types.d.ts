/**
 * The valid pipeline WS channel patterns. Subscribers attach to one of:
 *   - 'pipeline:all'                — every pipeline event (observability)
 *   - 'pipeline:approvals'          — approval.requested / approval.recorded
 *   - 'pipeline:run:<runId>'        — events scoped to one run
 */
export type PipelineEventChannel = 'pipeline:all' | 'pipeline:approvals' | `pipeline:run:${string}`;
/**
 * BusEvent envelope as the gateway PipelineBridge hands it to emitEvent.
 * The router only reads seq / sourceNodeId / emittedAt for the wire frame;
 * everything else is forwarded as `payload`.
 */
export interface PipelineBusEnvelope {
    seq?: number;
    sourceNodeId?: string;
    emittedAt?: number | string;
    [key: string]: unknown;
}
/**
 * The frame delivered to subscribed WS clients. Shape matches
 * PIPELINES_PLAN.md §14.3.
 */
export interface PipelineFrame {
    type: 'pipeline:event';
    eventType: string;
    payload: unknown;
    channel: string;
    seq?: number;
    sourceNodeId?: string;
    emittedAt?: number | string;
}
/**
 * The MessageRouter slice PipelineWsRouter needs. Kept narrow on purpose:
 * the only verbs it actually uses are per-client send + per-channel
 * subscribe/unsubscribe/send. When `messageRouter` is null the router
 * runs in single-node "local" mode and falls back to
 * _broadcastToLocalSubscribers.
 */
export interface PipelineMessageRouter {
    sendToClient(clientId: string, message: unknown): void;
    sendToChannel(channel: string, message: unknown): void | Promise<void>;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
}
/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface PipelineLogger {
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
export interface PipelineMetricsCollector {
    recordError?(code: string): void;
}
/**
 * Optional construction-time tunables.
 */
export interface PipelineConfig {
    /** Max length of an accepted channel name. Default 100. */
    maxChannelLength?: number;
}
/**
 * Options bag for the PipelineWsRouter constructor. Replaces the
 * gateway PipelineService's positional `(messageRouter, logger, metrics, opts)`
 * signature so additional dependencies can be added without breaking
 * existing call sites.
 */
export interface PipelineWsRouterOptions {
    /** Router for cross-node fan-out. Pass null/undefined for local mode. */
    messageRouter?: PipelineMessageRouter | null;
    logger: PipelineLogger;
    metricsCollector?: PipelineMetricsCollector | null;
    config?: PipelineConfig;
}
//# sourceMappingURL=types.d.ts.map