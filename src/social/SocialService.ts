// realtime-modules/src/social/SocialService.ts
//
// Lifted from gateway's src/services/social-service.ts (131 LOC, Wave 2
// extraction). The WS-side social-event subscription surface only:
// tracking, subscribe/unsubscribe, channelId validation, and disconnect
// cleanup.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional `(router, logger, metrics)` to
//     a single `SocialServiceOptions` bag so callers can wire optional
//     config (max channelId length, metrics, …) without an ever-growing
//     signature.
//   - `SubscriptionTracker` lifted inline (~40 LOC) so the module stays
//     dependency-free.
//   - `MAX_CHANNEL_ID_LENGTH` becomes an instance field (configurable via
//     options); default 100 mirrors the gateway original.
//
// Everything else (action dispatch, validation rules, frame shape,
// disconnect cleanup, getStats) is byte-faithful to the original.
//
// NOT lifted (stays in gateway / platform-api):
//   - all social-api CRUD (platform-api owns)
//   - all publishing / broadcasting from social-api Redis side
//     (platform-api's BroadcastService is the producer)

import type {
    SocialConfig,
    SocialLogger,
    SocialMessageRouter,
    SocialMetricsCollector,
    SocialServiceOptions,
} from './types';

const DEFAULT_MAX_CHANNEL_ID_LENGTH = 100;

/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface SocialService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, getStats, plus
 *   Map-compatible has/get/set/delete/size.
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

export class SocialService {
    /**
     * Default max channelId length. Mirrors the gateway original (100).
     * Instances read `this.maxChannelIdLength` (configurable via options)
     * so this static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_ID_LENGTH: number = DEFAULT_MAX_CHANNEL_ID_LENGTH;

    messageRouter: SocialMessageRouter | null;
    logger: SocialLogger;
    metricsCollector: SocialMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelIdLength: number;

    constructor(opts: SocialServiceOptions) {
        if (!opts || !opts.logger) {
            throw new Error('SocialService: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const config: SocialConfig = opts.config ?? {};
        this.maxChannelIdLength = config.maxChannelIdLength ?? DEFAULT_MAX_CHANNEL_ID_LENGTH;

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
                    this.sendError(clientId, `Unknown social action: ${action}`);
            }
        } catch (error) {
            this.logger.error(
                `Error handling social action ${action} for client ${clientId}:`,
                error,
            );
            this.sendError(clientId, 'Internal server error');
        }
    }

    /**
     * Subscribe a client to a social channel. channelId must be a
     * non-empty string no longer than maxChannelIdLength (default 100).
     */
    async handleSubscribe(
        clientId: string,
        { channelId }: { channelId: string },
    ): Promise<void> {
        if (
            !channelId ||
            typeof channelId !== 'string' ||
            channelId.length === 0 ||
            channelId.length > this.maxChannelIdLength
        ) {
            this.sendError(
                clientId,
                `channelId is required (string, max ${this.maxChannelIdLength} chars)`,
            );
            return;
        }

        // Subscribe to channel via message router (registers node in Redis SET)
        if (this.messageRouter) {
            await this.messageRouter.subscribeToChannel(clientId, channelId);
        }

        // Track locally for cleanup on disconnect
        this.clientChannels.addSubscription(clientId, channelId);

        this.sendToClient(clientId, {
            type: 'social',
            action: 'subscribed',
            channelId,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} subscribed to social channel ${channelId}`);
    }

    /**
     * Unsubscribe a client from a previously-subscribed social channel.
     */
    async handleUnsubscribe(
        clientId: string,
        { channelId }: { channelId?: string },
    ): Promise<void> {
        if (!channelId) {
            this.sendError(clientId, 'channelId is required');
            return;
        }

        if (this.messageRouter) {
            await this.messageRouter.unsubscribeFromChannel(clientId, channelId);
        }

        this.clientChannels.removeSubscription(clientId, channelId);

        this.sendToClient(clientId, {
            type: 'social',
            action: 'unsubscribed',
            channelId,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} unsubscribed from social channel ${channelId}`);
    }

    /**
     * Cleanup on client disconnect — unsubscribes from all tracked channels.
     * Individual unsubscribe failures are logged but do not break the loop;
     * local tracking is always cleared.
     */
    async handleDisconnect(clientId: string): Promise<void> {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channelId of channels) {
            try {
                if (this.messageRouter) {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channelId);
                }
            } catch (error) {
                this.logger.error(
                    `Error unsubscribing client ${clientId} from social channel ${channelId}:`,
                    error,
                );
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from social service`);
    }

    sendToClient(clientId: string, message: unknown): void {
        if (this.messageRouter) {
            this.messageRouter.sendToClient(clientId, message);
        }
    }

    sendError(clientId: string, message: string): void {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'social',
            message,
            timestamp: new Date().toISOString(),
        });
    }

    getStats(): { subscribedClients: number; totalSubscriptions: number } {
        return this.clientChannels.getStats();
    }
}

export default SocialService;
