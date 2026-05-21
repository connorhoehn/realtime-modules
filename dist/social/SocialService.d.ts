import type { SocialLogger, SocialMessageRouter, SocialMetricsCollector, SocialServiceOptions } from './types';
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface SocialService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, getStats, plus
 *   Map-compatible has/get/set/delete/size.
 */
declare class SubscriptionTracker extends Map<string, Set<string>> {
    addSubscription(clientId: string, channel: string): void;
    removeSubscription(clientId: string, channel: string): boolean;
    removeClient(clientId: string): string[];
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export declare class SocialService {
    /**
     * Default max channelId length. Mirrors the gateway original (100).
     * Instances read `this.maxChannelIdLength` (configurable via options)
     * so this static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_ID_LENGTH: number;
    messageRouter: SocialMessageRouter | null;
    logger: SocialLogger;
    metricsCollector: SocialMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelIdLength: number;
    constructor(opts: SocialServiceOptions);
    /**
     * Dispatch an incoming action to its handler. Unknown actions reply
     * with an error frame.
     */
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    /**
     * Subscribe a client to a social channel. channelId must be a
     * non-empty string no longer than maxChannelIdLength (default 100).
     */
    handleSubscribe(clientId: string, { channelId }: {
        channelId: string;
    }): Promise<void>;
    /**
     * Unsubscribe a client from a previously-subscribed social channel.
     */
    handleUnsubscribe(clientId: string, { channelId }: {
        channelId?: string;
    }): Promise<void>;
    /**
     * Cleanup on client disconnect — unsubscribes from all tracked channels.
     * Individual unsubscribe failures are logged but do not break the loop;
     * local tracking is always cleared.
     */
    handleDisconnect(clientId: string): Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
    sendError(clientId: string, message: string): void;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export default SocialService;
//# sourceMappingURL=SocialService.d.ts.map