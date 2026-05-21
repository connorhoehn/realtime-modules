// realtime-modules/src/reactions/ReactionService.ts
//
// Lifted from gateway's src/realtime-fanout/reaction-service.ts (337 LOC,
// Wave 2 extraction). Pure in-memory emoji-reaction fan-out with a small
// LRU history per channel. No persistence, no DDB, no Redis.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional `(router, logger, metrics)` to
//     a single `ReactionServiceOptions` bag so callers can wire optional
//     config (custom catalog, authz hook, history size, …) without an
//     ever-growing signature.
//   - `enforceChannelPermission` interceptor coupling replaced with a
//     pluggable `authorizeChannel` hook (defaults to allow-all).
//   - `ErrorCodes` / `createErrorResponse` import removed; the equivalent
//     error envelope is inlined locally (DEFAULT_ERROR_CODE in types).
//   - `ownership-cleanup-coordinator` registration removed entirely —
//     gateway-specific (room/Raft eviction) and lives on at the gateway
//     wiring layer. `_cleanupRoom` is kept as a public method so the
//     gateway adapter can drive it.
//   - `SubscriptionTracker` lifted inline (~30 LOC) so the module stays
//     dependency-free.
//
// Everything else (action dispatch, validation, history ring buffer,
// reaction-id generation, broadcast semantics, getStats) is byte-faithful
// to the original.

import {
    DEFAULT_AVAILABLE_REACTIONS,
    DEFAULT_ERROR_CODE,
    type AvailableReaction,
    type Reaction,
    type ReactionConfig,
    type ReactionErrorFrame,
    type ReactionLogger,
    type ReactionMessageRouter,
    type ReactionMetricsCollector,
    type ReactionServiceOptions,
} from './types';

const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 50;

/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface ReactionService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   plus Map-compatible has/get/set/delete/size.
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
}

export class ReactionService {
    messageRouter: ReactionMessageRouter | null;
    logger: ReactionLogger;
    metricsCollector: ReactionMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    reactionHistory: Map<string, Reaction[]>;
    maxHistorySize: number;
    maxChannelNameLength: number;
    isDistributed: boolean;
    availableReactions: Record<string, AvailableReaction>;

    private authorizeChannel: (clientId: string, channel: string) => boolean;

    constructor(opts: ReactionServiceOptions) {
        if (!opts || !opts.logger) {
            throw new Error('ReactionService: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const config: ReactionConfig = opts.config ?? {};
        this.maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY;
        this.maxChannelNameLength = config.maxChannelNameLength ?? DEFAULT_MAX_CHANNEL_NAME_LENGTH;
        this.availableReactions = config.availableReactions
            ? { ...config.availableReactions }
            : { ...DEFAULT_AVAILABLE_REACTIONS };
        this.authorizeChannel = config.authorizeChannel ?? (() => true);

        this.clientChannels = new SubscriptionTracker();
        this.reactionHistory = new Map();
        this.isDistributed = !!this.messageRouter;
    }

    /**
     * Discard transient in-memory reaction-aggregator state for a room.
     * Reactions are ephemeral by design — there is no persisted store to
     * preserve. Drops the recent-reaction history list for the channel.
     *
     * Gateway's ownership-cleanup-coordinator (room/Raft eviction) wires
     * this method as the `onLost` handler; here we expose it as a
     * public method so the adapter layer owns the coordinator coupling.
     */
    async cleanupRoom(roomId: string): Promise<void> {
        if (!roomId) return;
        const had = this.reactionHistory.delete(roomId);
        this.logger.info(
            `reaction-service flushed transient reaction state for roomId ${roomId}` +
                (had ? '' : ' (no state present)'),
        );
    }

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        try {
            switch (action) {
                case 'subscribe':
                    await this.handleSubscribeToReactions(clientId, data);
                    return;
                case 'unsubscribe':
                    await this.handleUnsubscribeFromReactions(clientId, data);
                    return;
                case 'send':
                    await this.handleSendReaction(clientId, data);
                    return;
                case 'getAvailable':
                    await this.handleGetAvailableReactions(clientId);
                    return;
                default:
                    this.sendError(clientId, `Unknown reaction action: ${action}`);
            }
        } catch (error: any) {
            this.logger.error(`Error handling reaction action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
    }

    async handleSubscribeToReactions(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        if (typeof channel !== 'string' || channel.length === 0 || channel.length > this.maxChannelNameLength) {
            this.sendError(
                clientId,
                `Channel name must be a string between 1 and ${this.maxChannelNameLength} characters`,
            );
            return;
        }

        try {
            if (!this.authorizeChannel(clientId, channel)) {
                this.sendError(clientId, `Not authorized for channel: ${channel}`);
                return;
            }

            this.clientChannels.addSubscription(clientId, channel);

            if (this.isDistributed && this.messageRouter) {
                await this.messageRouter.subscribeToChannel(clientId, `reactions:${channel}`);
            }

            this.sendSuccess(clientId, 'reaction_subscribed', {
                channel,
                message: `Subscribed to reactions in channel: ${channel}`,
                availableReactions: Object.keys(this.availableReactions),
            });

            this.logger.info(`Client ${clientId} subscribed to reactions in channel: ${channel}`);
        } catch (error: any) {
            this.logger.error(`Error subscribing to reactions for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to reactions');
        }
    }

    async handleUnsubscribeFromReactions(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        this.clientChannels.removeSubscription(clientId, channel);

        if (this.isDistributed && this.messageRouter) {
            await this.messageRouter.unsubscribeFromChannel(clientId, `reactions:${channel}`);
        }

        this.sendSuccess(clientId, 'reaction_unsubscribed', {
            channel,
            message: `Unsubscribed from reactions in channel: ${channel}`,
        });

        this.logger.info(`Client ${clientId} unsubscribed from reactions in channel: ${channel}`);
    }

    async handleSendReaction(
        clientId: string,
        {
            channel,
            emoji,
            position = null,
            metadata = {},
        }: { channel: string; emoji: string; position?: unknown; metadata?: Record<string, unknown> },
    ): Promise<void> {
        if (!channel || !emoji) {
            this.sendError(clientId, 'Channel and emoji are required');
            return;
        }

        if (!this.availableReactions[emoji]) {
            this.sendError(clientId, 'Invalid emoji reaction');
            return;
        }

        const reaction: Reaction = {
            id: this.generateReactionId(),
            clientId,
            channel,
            emoji,
            effect: this.availableReactions[emoji].effect,
            position,
            metadata,
            timestamp: new Date().toISOString(),
        };

        if (!this.reactionHistory.has(channel)) {
            this.reactionHistory.set(channel, []);
        }
        const history = this.reactionHistory.get(channel)!;
        history.push(reaction);

        if (history.length > this.maxHistorySize) {
            history.shift();
        }

        const reactionMessage = {
            type: 'reaction',
            action: 'reaction_received',
            data: reaction,
        };

        if (this.isDistributed && this.messageRouter) {
            await this.messageRouter.sendToChannel(`reactions:${channel}`, reactionMessage);
        } else {
            this.broadcastToLocalChannel(channel, reactionMessage);
        }

        this.sendSuccess(clientId, 'reaction_sent', {
            reactionId: reaction.id,
            emoji,
            channel,
            timestamp: reaction.timestamp,
        });

        this.logger.info(`Client ${clientId} sent reaction ${emoji} in channel: ${channel}`);
    }

    async handleGetAvailableReactions(clientId: string): Promise<void> {
        this.sendSuccess(clientId, 'available_reactions', {
            reactions: this.availableReactions,
        });
    }

    generateReactionId(): string {
        return `reaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    broadcastToLocalChannel(channel: string, message: unknown): void {
        for (const clientId of this.clientChannels.clientsSubscribedTo(channel)) {
            this.sendToClient(clientId, message);
        }
    }

    sendToClient(clientId: string, message: unknown): void {
        if (this.messageRouter && this.messageRouter.sendToLocalClient) {
            this.messageRouter.sendToLocalClient(clientId, message);
        }
    }

    sendSuccess(clientId: string, action: string, data: unknown): void {
        this.sendToClient(clientId, {
            type: 'reaction',
            action,
            success: true,
            data,
        });
    }

    sendError(clientId: string, message: string, errorCode: string = DEFAULT_ERROR_CODE): void {
        const errorFrame: ReactionErrorFrame = {
            type: 'error',
            service: 'reaction',
            error: {
                code: errorCode,
                message,
                timestamp: new Date().toISOString(),
                service: 'reaction',
                clientId,
            },
        };

        this.sendToClient(clientId, errorFrame);

        if (this.metricsCollector) {
            this.metricsCollector.recordError(errorCode);
        }
    }

    /** Cleanup when a client disconnects: drop tracking + downstream unsubs. */
    async handleDisconnect(clientId: string): Promise<void> {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channel of channels) {
            if (this.isDistributed && this.messageRouter) {
                await this.messageRouter.unsubscribeFromChannel(clientId, `reactions:${channel}`);
            }
        }

        this.logger.debug(`Cleaned up reactions for disconnected client: ${clientId}`);
    }

    getStats(): {
        connectedClients: number;
        activeChannels: number;
        totalReactions: number;
        availableReactionsCount: number;
    } {
        let totalReactions = 0;
        for (const history of this.reactionHistory.values()) {
            totalReactions += history.length;
        }
        return {
            connectedClients: this.clientChannels.size,
            activeChannels: this.reactionHistory.size,
            totalReactions,
            availableReactionsCount: Object.keys(this.availableReactions).length,
        };
    }
}

export default ReactionService;
