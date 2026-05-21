import { type AvailableReaction, type Reaction, type ReactionLogger, type ReactionMessageRouter, type ReactionMetricsCollector, type ReactionServiceOptions } from './types';
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface ReactionService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   plus Map-compatible has/get/set/delete/size.
 */
declare class SubscriptionTracker extends Map<string, Set<string>> {
    addSubscription(clientId: string, channel: string): void;
    removeSubscription(clientId: string, channel: string): boolean;
    removeClient(clientId: string): string[];
    clientsSubscribedTo(channel: string): IterableIterator<string>;
}
export declare class ReactionService {
    messageRouter: ReactionMessageRouter | null;
    logger: ReactionLogger;
    metricsCollector: ReactionMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    reactionHistory: Map<string, Reaction[]>;
    maxHistorySize: number;
    maxChannelNameLength: number;
    isDistributed: boolean;
    availableReactions: Record<string, AvailableReaction>;
    private authorizeChannel;
    constructor(opts: ReactionServiceOptions);
    /**
     * Discard transient in-memory reaction-aggregator state for a room.
     * Reactions are ephemeral by design — there is no persisted store to
     * preserve. Drops the recent-reaction history list for the channel.
     *
     * Gateway's ownership-cleanup-coordinator (room/Raft eviction) wires
     * this method as the `onLost` handler; here we expose it as a
     * public method so the adapter layer owns the coordinator coupling.
     */
    cleanupRoom(roomId: string): Promise<void>;
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleSubscribeToReactions(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleUnsubscribeFromReactions(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleSendReaction(clientId: string, { channel, emoji, position, metadata, }: {
        channel: string;
        emoji: string;
        position?: unknown;
        metadata?: Record<string, unknown>;
    }): Promise<void>;
    handleGetAvailableReactions(clientId: string): Promise<void>;
    generateReactionId(): string;
    broadcastToLocalChannel(channel: string, message: unknown): void;
    sendToClient(clientId: string, message: unknown): void;
    sendSuccess(clientId: string, action: string, data: unknown): void;
    sendError(clientId: string, message: string, errorCode?: string): void;
    /** Cleanup when a client disconnects: drop tracking + downstream unsubs. */
    handleDisconnect(clientId: string): Promise<void>;
    getStats(): {
        connectedClients: number;
        activeChannels: number;
        totalReactions: number;
        availableReactionsCount: number;
    };
}
export default ReactionService;
//# sourceMappingURL=ReactionService.d.ts.map