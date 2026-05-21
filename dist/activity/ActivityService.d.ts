import { type ActivityHistoryStore } from './ActivityHistoryStore';
import type { ActivityEventConfig } from './types';
export interface ActivityLogger {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}
export interface ActivityMessageRouter {
    sendToClient(clientId: string, message: any): void;
    sendToChannel?(channel: string, message: any): Promise<void> | void;
    subscribeToChannel?(clientId: string, channel: string): Promise<void> | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    getClientData?(clientId: string): any;
}
export interface ActivityServiceOpts {
    /**
     * MessageRouter handle. May be null in zero-config / local-only mode;
     * in that case publishes fall through to `_broadcastToLocalSubscribers`
     * and subscribe/unsubscribe become tracking-only.
     */
    messageRouter: ActivityMessageRouter | null;
    logger: ActivityLogger;
    metricsCollector?: any;
    /**
     * History persistence backend. Defaults to InMemoryActivityHistoryStore
     * so the lifted module is usable in tests / zero-config consumers.
     * Gateway wires the concrete Redis-backed adapter here.
     */
    historyStore?: ActivityHistoryStore;
    /** Tunables — defaults mirror gateway/src/config/constants.ts. */
    config?: ActivityEventConfig;
}
/**
 * Per-client local subscription tracker. Inlined here rather than
 * imported from a sibling because the activity service only needs the
 * Map-style surface + clientsSubscribedTo iterator. Mirrors the inlining
 * convention already used by ReactionService.
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
export declare class ActivityService {
    static BROADCAST_CHANNEL: string;
    messageRouter: ActivityMessageRouter | null;
    logger: ActivityLogger;
    metricsCollector: any;
    historyStore: ActivityHistoryStore;
    clientChannels: SubscriptionTracker;
    readonly maxHistoryItems: number;
    readonly maxChannelIdLength: number;
    constructor(opts: ActivityServiceOpts);
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleSubscribe(clientId: string, { channelId }: {
        channelId: string;
    }): Promise<void>;
    handleUnsubscribe(clientId: string, { channelId }: {
        channelId: string;
    }): Promise<void>;
    handlePublish(clientId: string, data: any): Promise<void>;
    /**
     * Auto-subscribe a newly connected client to the global
     * activity:broadcast channel. Called by the server on connection
     * setup.
     */
    onClientConnect(clientId: string): Promise<void>;
    /**
     * Broadcast a message to all local subscribers of a channel
     * (local-only / no-router fallback).
     */
    _broadcastToLocalSubscribers(channelId: string, message: any): void;
    /**
     * Return recent activity history from the store.
     * Client sends: { service: 'activity', action: 'getHistory', limit: 50 }
     */
    handleGetHistory(clientId: string, data: any): Promise<void>;
    handleDisconnect(clientId: string): Promise<void>;
    sendToClient(clientId: string, message: any): void;
    sendError(clientId: string, message: string): void;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export default ActivityService;
//# sourceMappingURL=ActivityService.d.ts.map