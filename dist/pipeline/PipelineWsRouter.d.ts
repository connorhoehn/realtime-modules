import type { PipelineBusEnvelope, PipelineLogger, PipelineMessageRouter, PipelineMetricsCollector, PipelineWsRouterOptions } from './types';
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface PipelineWsRouter actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   getStats, plus Map-compatible has/get/set/delete/size for tests that
 *   poke at it directly.
 */
declare class SubscriptionTracker extends Map<string, Set<string>> {
    addSubscription(clientId: string, channel: string): void;
    removeSubscription(clientId: string, channel: string): boolean;
    removeClient(clientId: string): string[];
    clientsSubscribedTo(channel: string): IterableIterator<string>;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
/**
 * PipelineWsRouter — pure WS subscription + frame-projection surface for
 * pipeline events. Composes any pipeline backend (PipelineModule,
 * platform-api executor, …) with a uniform `pipeline:event` wire format.
 *
 * The gateway-side PipelineService composes this router with its trigger /
 * cancel / approval / audit / tracing logic — see CLAUDE-mentioned
 * src/services/pipeline-service.ts.
 */
export declare class PipelineWsRouter {
    /**
     * Channel prefixes the router accepts. Preserved as a static for
     * back-compat with anything that imported the gateway's
     * `PipelineService.CHANNEL_PREFIXES` array.
     */
    static CHANNEL_PREFIXES: string[];
    /**
     * Default max channel length. Mirrors the gateway original. Instances
     * read `this.maxChannelLength` (configurable via options) so this
     * static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_LENGTH: number;
    messageRouter: PipelineMessageRouter | null;
    logger: PipelineLogger;
    metricsCollector: PipelineMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelLength: number;
    constructor(opts: PipelineWsRouterOptions);
    /**
     * Dispatch an incoming action to its handler. Only subscribe /
     * unsubscribe are owned here — the gateway composite service layers
     * trigger / cancel / approval / etc. above this router and falls
     * through to handleAction for the WS subscription verbs.
     */
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    /**
     * Subscribe a client to a pipeline channel. Valid formats:
     *   - pipeline:run:{runId}
     *   - pipeline:all
     *   - pipeline:approvals
     */
    handleSubscribe(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    /**
     * Unsubscribe a client from a previously-subscribed pipeline channel.
     */
    handleUnsubscribe(clientId: string, { channel }: {
        channel?: string;
    }): Promise<void>;
    /**
     * Project a BusEvent into a `pipeline:event` frame and broadcast it to
     * all subscribers of the given channel. Called by the gateway-side
     * pipeline-bridge when the embedded PipelineModule's EventBus emits a
     * BusEvent. Shape matches PIPELINES_PLAN.md §14.3 minus the optional
     * traceparent / tracestate fields (tracing stays gateway-side).
     */
    emitEvent(channel: string, eventType: string, payload: unknown, envelope?: PipelineBusEnvelope): Promise<void>;
    /**
     * Local-only fallback broadcast (used when no messageRouter is
     * available, e.g. tests or single-node mode).
     */
    _broadcastToLocalSubscribers(channel: string, message: unknown): void;
    /**
     * Validates that a channel string matches one of the allowed pipeline
     * channel formats.
     */
    _isValidChannel(channel: unknown): boolean;
    /**
     * Cleanup on client disconnect — unsubscribes from all tracked channels.
     */
    handleDisconnect(clientId: string): Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
    sendError(clientId: string, message: string, correlationId?: unknown): void;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export default PipelineWsRouter;
//# sourceMappingURL=PipelineWsRouter.d.ts.map