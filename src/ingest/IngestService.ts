// realtime-modules/src/ingest/IngestService.ts
//
// Lifted from gateway's src/services/ingest-service.ts (204 LOC, Wave 2
// extraction). The WS-side ingest subscription surface only: tracking,
// subscribe/unsubscribe, channel-validation, emitEvent fan-out, and a
// local-only fallback. No persistence, no DDB, no bridge wiring.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional `(router, logger, metrics)` to
//     a single `IngestServiceOptions` bag so callers can wire optional
//     config (max channel length, metrics, …) without an ever-growing
//     signature.
//   - `SubscriptionTracker` lifted inline (~40 LOC) so the module stays
//     dependency-free.
//   - `MAX_CHANNEL_LENGTH` becomes an instance field (configurable via
//     options) instead of a class-level static. The static is preserved
//     on the class for back-compat with any consumer reading
//     `IngestService.MAX_CHANNEL_LENGTH` directly.
//
// Everything else (action dispatch, validation rules, broadcast frame
// shape, disconnect cleanup, getStats) is byte-faithful to the original.
//
// NOT lifted (stays in gateway):
//   - ingest-bridge / ingest-relay (event-bus → emitEvent plumbing)
//   - any DDB persistence
//   - platform-api ingest engine

import type {
    IngestConfig,
    IngestEvent,
    IngestFrame,
    IngestLogger,
    IngestMessageRouter,
    IngestMetricsCollector,
    IngestServiceOptions,
} from './types';

const DEFAULT_MAX_CHANNEL_LENGTH = 100;
const PROGRESS_CHANNEL = 'ingest:progress';
const SOURCE_CHANNEL_PREFIX = 'ingest:source:';

/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface IngestService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   getStats, plus Map-compatible has/get/set/delete/size.
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

export class IngestService {
    /**
     * Static channel allow-list retained from the gateway original for
     * back-compat with any consumer that read `IngestService.VALID_CHANNELS`.
     * Validation actually goes through `_isValidChannel`, which also
     * accepts the dynamic `ingest:source:<id>` form.
     */
    static VALID_CHANNELS: string[] = [PROGRESS_CHANNEL];

    /**
     * Default max channel length. Mirrors the gateway original. Instances
     * read `this.maxChannelLength` (configurable via options) so this
     * static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_LENGTH: number = DEFAULT_MAX_CHANNEL_LENGTH;

    messageRouter: IngestMessageRouter | null;
    logger: IngestLogger;
    metricsCollector: IngestMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelLength: number;

    constructor(opts: IngestServiceOptions) {
        if (!opts || !opts.logger) {
            throw new Error('IngestService: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const config: IngestConfig = opts.config ?? {};
        this.maxChannelLength = config.maxChannelLength ?? DEFAULT_MAX_CHANNEL_LENGTH;

        this.clientChannels = new SubscriptionTracker();
    }

    /**
     * Dispatch an incoming action to its handler. Unknown actions reply
     * with an error frame.
     */
    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        try {
            switch (action) {
                case 'subscribe':
                    return await this.handleSubscribe(clientId, data);
                case 'unsubscribe':
                    return await this.handleUnsubscribe(clientId, data);
                default:
                    this.sendError(clientId, `Unknown ingest action: ${action}`);
            }
        } catch (error) {
            this.logger.error(
                `Error handling ingest action ${action} for client ${clientId}:`,
                error,
            );
            this.sendError(clientId, 'Internal server error');
        }
    }

    /**
     * Subscribe a client to an ingest channel. Valid formats:
     *   - ingest:progress
     *   - ingest:source:{sourceId}
     */
    async handleSubscribe(
        clientId: string,
        { channel }: { channel: string },
    ): Promise<void> {
        if (!this._isValidChannel(channel)) {
            this.sendError(
                clientId,
                'channel is required (ingest:progress | ingest:source:{sourceId})',
            );
            return;
        }

        if (this.messageRouter) {
            await this.messageRouter.subscribeToChannel(clientId, channel);
        }

        this.clientChannels.addSubscription(clientId, channel);

        this.sendToClient(clientId, {
            type: 'ingest',
            action: 'subscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} subscribed to ingest channel ${channel}`);
    }

    /**
     * Unsubscribe a client from a previously-subscribed ingest channel.
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
            type: 'ingest',
            action: 'unsubscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} unsubscribed from ingest channel ${channel}`);
    }

    /**
     * Broadcast an ingest event to all subscribers of the given channel.
     * Called by the gateway ingest bridge when an IngestEvent arrives
     * from the engine's event bus.
     */
    async emitEvent(channel: string, event: IngestEvent): Promise<void> {
        if (!channel || !event) {
            this.logger.warn('[ingest] emitEvent called with missing channel/event', { channel });
            return;
        }

        const frame: IngestFrame = {
            type: 'ingest:event',
            event,
            channel,
            timestamp: new Date().toISOString(),
        };

        if (this.messageRouter) {
            try {
                await this.messageRouter.sendToChannel(channel, frame);
            } catch (err: any) {
                this.logger.error(
                    `[ingest] Failed to broadcast event to ${channel}:`,
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
     * Validates that a channel string matches one of the allowed ingest
     * channel formats.
     */
    _isValidChannel(channel: unknown): boolean {
        if (!channel || typeof channel !== 'string') return false;
        if (channel.length === 0 || channel.length > this.maxChannelLength) return false;
        if (channel === PROGRESS_CHANNEL) return true;
        if (
            channel.startsWith(SOURCE_CHANNEL_PREFIX) &&
            channel.length > SOURCE_CHANNEL_PREFIX.length
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
                    `Error unsubscribing client ${clientId} from ingest channel ${channel}:`,
                    error,
                );
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from ingest service`);
    }

    sendToClient(clientId: string, message: unknown): void {
        if (this.messageRouter) {
            this.messageRouter.sendToClient(clientId, message);
        }
    }

    sendError(clientId: string, message: string): void {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'ingest',
            message,
            timestamp: new Date().toISOString(),
        });
    }

    getStats(): { subscribedClients: number; totalSubscriptions: number } {
        return this.clientChannels.getStats();
    }
}

export default IngestService;
