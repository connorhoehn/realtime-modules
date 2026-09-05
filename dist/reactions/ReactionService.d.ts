import { type AvailableReaction, type Reaction, type ReactionLogger, type ReactionMessageRouter, type ReactionMetricsCollector, type ReactionServiceOptions, type StoredReaction } from './types';
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
    private identityResolver;
    private onReaction;
    private store;
    private maxHistoryReplay;
    constructor(opts: ReactionServiceOptions);
    /**
     * Discard transient in-memory reaction-aggregator state for a room.
     * Drops the recent-reaction ring for the channel only: stored (targeted)
     * reactions are channel state and outlive whichever node owns the room,
     * so losing ownership must not delete them.
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
    handleSendReaction(clientId: string, { channel, emoji, position, metadata, targetId, }: {
        channel: string;
        emoji: string;
        position?: unknown;
        metadata?: Record<string, unknown>;
        targetId?: unknown;
    }): Promise<void>;
    /**
     * Take back a reaction. Only meaningful for targeted reactions with a
     * store behind them — the floating emoji thrown at a call is an event
     * that already happened and cannot be un-thrown.
     *
     * Removing a reaction that is not there succeeds: two clicks racing on
     * the same chip should settle on "not reacted", not on an error.
     */
    handleRemoveReaction(clientId: string, { channel, emoji, targetId }: {
        channel: string;
        emoji: string;
        targetId?: unknown;
    }): Promise<void>;
    /** A reaction is durable when it names what it is attached to. */
    _isTargeted(reaction: Reaction): boolean;
    _toStored(reaction: Reaction): StoredReaction;
    /**
     * Stored rows are re-broadcast as ordinary Reactions so clients need one
     * inbound shape, not two. The id is derived from the key rather than
     * generated, so replaying twice cannot look like two reactions.
     */
    _fromStored(stored: StoredReaction): Reaction;
    _replayStoredReactions(clientId: string, channel: string): Promise<void>;
    /**
     * Resolve the sender identity for a connection, or null. A throwing
     * resolver is logged and treated as "no identity" (mirrors
     * ChatService._resolveIdentity semantics).
     */
    _resolveIdentity(clientId: string): {
        userId?: string;
        displayName?: string;
    } | null;
    /**
     * Invoke the configured `onReaction` tap. Sync throws are caught and
     * logged; rejected promises are .catch-ed and logged. Never awaited.
     */
    _emitReaction(reaction: Reaction): void;
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