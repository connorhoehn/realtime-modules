// realtime-modules/src/pipeline/PipelineWsRouter.ts
//
// Lifted from gateway's src/services/pipeline-service.ts (~1010 LOC, Wave 2
// extraction). Only the WS-side subscription surface is lifted; gateway keeps
// the much larger composite service that adds trigger / cancel / approval
// / audit / authz / tracing on top of this router.
//
// Lift changes vs the gateway PipelineService:
//   - Renamed to `PipelineWsRouter` to disambiguate from the gateway-side
//     composite PipelineService.
//   - Constructor switched from positional
//     `(messageRouter, logger, metrics, options)` to a single
//     `PipelineWsRouterOptions` bag so callers can wire optional config
//     (max channel length, metrics, …) without an ever-growing signature.
//   - `SubscriptionTracker` lifted inline (~40 LOC) so the module stays
//     dependency-free.
//   - `MAX_CHANNEL_LENGTH` becomes an instance field (configurable via
//     options); the static is preserved on the class for back-compat with
//     any consumer reading `PipelineWsRouter.MAX_CHANNEL_LENGTH` directly.
//   - `CHANNEL_PREFIXES` static preserved verbatim for back-compat.
//   - `handleAction` dispatcher trimmed to just subscribe/unsubscribe.
//     Unknown actions return an error frame so the composite service can
//     layer its own action handlers above this router (gateway dispatches
//     trigger/cancel/etc. before falling through to handleAction).
//   - `emitEvent` frame projection lifted as-is, MINUS the W3C traceparent
//     injection (Phase 51) — tracing stays gateway-side. The lifted frame
//     shape matches the gateway frame minus the optional `traceparent` /
//     `tracestate` fields.
//
// Everything else (validation rules, broadcast frame shape, disconnect
// cleanup, getStats) is byte-faithful to the original.
//
// NOT lifted (stays in gateway pipeline-service.ts):
//   - handleTrigger / triggerFromWebhook / _invokeTrigger
//   - handleCancel / handleResolveApproval / _doResolveApproval
//   - handleResumeFromStep / _doResumeFromStep
//   - handleGetRun / handleGetHistory / handleResolveBreakpoint
//   - handleTestEmit / handleSimEmit (dev shims)
//   - AuditLog wiring (setAuditLog, _audit, _resolveUserId — Phase 52)
//   - ApprovalAuthz predicate (setApprovalAuthz — Phase 52)
//   - tracing instrumentation (withSpan, injectTraceparent — Phase 51)
//   - PipelineModule reference (setPipelineModule)
//   - pipelineEventSource reference (setEventSource)
//   - cancelHandler / resolveApprovalHandler (Phase 4 fallback wires)
//   - in-memory mock store (_ensureMockStore, _mockTrigger, _emitMock,
//     _mockGetRun, _mockGetHistory)

import type {
    PipelineBusEnvelope,
    PipelineConfig,
    PipelineFrame,
    PipelineLogger,
    PipelineMessageRouter,
    PipelineMetricsCollector,
    PipelineWsRouterOptions,
} from './types';

const DEFAULT_MAX_CHANNEL_LENGTH = 100;
const CHANNEL_ALL = 'pipeline:all';
const CHANNEL_APPROVALS = 'pipeline:approvals';
const RUN_CHANNEL_PREFIX = 'pipeline:run:';

/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface PipelineWsRouter actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   getStats, plus Map-compatible has/get/set/delete/size for tests that
 *   poke at it directly.
 */
class SubscriptionTracker extends Map<string, Set<string>> {
    addSubscription(clientId: string, channel: string): void {
        let set = this.get(clientId);
        if (!set) {
            set = new Set();
            this.set(clientId, set);
        }
        set.add(channel);
    }

    removeSubscription(clientId: string, channel: string): boolean {
        const set = this.get(clientId);
        if (!set) return false;
        const had = set.delete(channel);
        if (set.size === 0) {
            this.delete(clientId);
        }
        return had;
    }

    removeClient(clientId: string): string[] {
        const set = this.get(clientId);
        if (!set) return [];
        const channels = Array.from(set);
        this.delete(clientId);
        return channels;
    }

    *clientsSubscribedTo(channel: string): IterableIterator<string> {
        for (const [clientId, channels] of this.entries()) {
            if (channels.has(channel)) {
                yield clientId;
            }
        }
    }

    getStats(): { subscribedClients: number; totalSubscriptions: number } {
        let total = 0;
        for (const set of this.values()) {
            total += set.size;
        }
        return {
            subscribedClients: this.size,
            totalSubscriptions: total,
        };
    }
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
export class PipelineWsRouter {
    /**
     * Channel prefixes the router accepts. Preserved as a static for
     * back-compat with anything that imported the gateway's
     * `PipelineService.CHANNEL_PREFIXES` array.
     */
    static CHANNEL_PREFIXES: string[] = [
        RUN_CHANNEL_PREFIX,
        CHANNEL_ALL,
        CHANNEL_APPROVALS,
    ];

    /**
     * Default max channel length. Mirrors the gateway original. Instances
     * read `this.maxChannelLength` (configurable via options) so this
     * static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_LENGTH: number = DEFAULT_MAX_CHANNEL_LENGTH;

    messageRouter: PipelineMessageRouter | null;
    logger: PipelineLogger;
    metricsCollector: PipelineMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelLength: number;

    constructor(opts: PipelineWsRouterOptions) {
        if (!opts || !opts.logger) {
            throw new Error('PipelineWsRouter: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const config: PipelineConfig = opts.config ?? {};
        this.maxChannelLength = config.maxChannelLength ?? DEFAULT_MAX_CHANNEL_LENGTH;

        this.clientChannels = new SubscriptionTracker();
    }

    /**
     * Dispatch an incoming action to its handler. Only subscribe /
     * unsubscribe are owned here — the gateway composite service layers
     * trigger / cancel / approval / etc. above this router and falls
     * through to handleAction for the WS subscription verbs.
     */
    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        try {
            switch (action) {
                case 'subscribe':
                    return await this.handleSubscribe(clientId, data);
                case 'unsubscribe':
                    return await this.handleUnsubscribe(clientId, data);
                default:
                    this.sendError(clientId, `Unknown pipeline action: ${action}`);
            }
        } catch (error) {
            this.logger.error(
                `Error handling pipeline action ${action} for client ${clientId}:`,
                error,
            );
            this.sendError(clientId, 'Internal server error');
        }
    }

    /**
     * Subscribe a client to a pipeline channel. Valid formats:
     *   - pipeline:run:{runId}
     *   - pipeline:all
     *   - pipeline:approvals
     */
    async handleSubscribe(
        clientId: string,
        { channel }: { channel: string },
    ): Promise<void> {
        if (!this._isValidChannel(channel)) {
            this.sendError(
                clientId,
                'channel is required (pipeline:run:{runId} | pipeline:all | pipeline:approvals)',
            );
            return;
        }

        if (this.messageRouter) {
            await this.messageRouter.subscribeToChannel(clientId, channel);
        }

        this.clientChannels.addSubscription(clientId, channel);

        this.sendToClient(clientId, {
            type: 'pipeline',
            action: 'subscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(
            `Client ${clientId} subscribed to pipeline channel ${channel}`,
        );
    }

    /**
     * Unsubscribe a client from a previously-subscribed pipeline channel.
     */
    async handleUnsubscribe(
        clientId: string,
        { channel }: { channel?: string },
    ): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'channel is required');
            return;
        }

        if (this.messageRouter) {
            await this.messageRouter.unsubscribeFromChannel(clientId, channel);
        }

        this.clientChannels.removeSubscription(clientId, channel);

        this.sendToClient(clientId, {
            type: 'pipeline',
            action: 'unsubscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(
            `Client ${clientId} unsubscribed from pipeline channel ${channel}`,
        );
    }

    /**
     * Project a BusEvent into a `pipeline:event` frame and broadcast it to
     * all subscribers of the given channel. Called by the gateway-side
     * pipeline-bridge when the embedded PipelineModule's EventBus emits a
     * BusEvent. Shape matches PIPELINES_PLAN.md §14.3 minus the optional
     * traceparent / tracestate fields (tracing stays gateway-side).
     */
    async emitEvent(
        channel: string,
        eventType: string,
        payload: unknown,
        envelope?: PipelineBusEnvelope,
    ): Promise<void> {
        if (!channel || !eventType) {
            this.logger.warn(
                '[pipeline] emitEvent called with missing channel/eventType',
                { channel, eventType },
            );
            return;
        }

        const frame: PipelineFrame = {
            type: 'pipeline:event',
            eventType,
            payload,
            channel,
            seq: envelope?.seq,
            sourceNodeId: envelope?.sourceNodeId,
            emittedAt: envelope?.emittedAt,
        };

        if (this.messageRouter) {
            try {
                await this.messageRouter.sendToChannel(channel, frame);
            } catch (err: any) {
                this.logger.error(
                    `[pipeline] Failed to broadcast event to ${channel}:`,
                    err && err.message ? err.message : err,
                );
            }
        } else {
            this._broadcastToLocalSubscribers(channel, frame);
        }
    }

    /**
     * Local-only fallback broadcast (used when no messageRouter is
     * available, e.g. tests or single-node mode).
     */
    _broadcastToLocalSubscribers(channel: string, message: unknown): void {
        for (const subscriberClientId of this.clientChannels.clientsSubscribedTo(channel)) {
            this.sendToClient(subscriberClientId, message);
        }
    }

    /**
     * Validates that a channel string matches one of the allowed pipeline
     * channel formats.
     */
    _isValidChannel(channel: unknown): boolean {
        if (!channel || typeof channel !== 'string') return false;
        if (channel.length === 0 || channel.length > this.maxChannelLength) return false;
        if (channel === CHANNEL_ALL || channel === CHANNEL_APPROVALS) return true;
        if (
            channel.startsWith(RUN_CHANNEL_PREFIX) &&
            channel.length > RUN_CHANNEL_PREFIX.length
        ) {
            return true;
        }
        return false;
    }

    /**
     * Cleanup on client disconnect — unsubscribes from all tracked channels.
     */
    async handleDisconnect(clientId: string): Promise<void> {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channel of channels) {
            try {
                if (this.messageRouter) {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channel);
                }
            } catch (error) {
                this.logger.error(
                    `Error unsubscribing client ${clientId} from pipeline channel ${channel}:`,
                    error,
                );
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from pipeline service`);
    }

    sendToClient(clientId: string, message: unknown): void {
        if (this.messageRouter) {
            this.messageRouter.sendToClient(clientId, message);
        }
    }

    sendError(clientId: string, message: string, correlationId?: unknown): void {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'pipeline',
            message,
            ...(correlationId ? { correlationId } : {}),
            timestamp: new Date().toISOString(),
        });
    }

    getStats(): { subscribedClients: number; totalSubscriptions: number } {
        return this.clientChannels.getStats();
    }
}

export default PipelineWsRouter;
