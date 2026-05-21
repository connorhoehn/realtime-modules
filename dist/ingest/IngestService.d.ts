import type { IngestEvent, IngestLogger, IngestMessageRouter, IngestMetricsCollector, IngestServiceOptions } from './types';
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface IngestService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   getStats, plus Map-compatible has/get/set/delete/size.
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
export declare class IngestService {
    /**
     * Static channel allow-list retained from the gateway original for
     * back-compat with any consumer that read `IngestService.VALID_CHANNELS`.
     * Validation actually goes through `_isValidChannel`, which also
     * accepts the dynamic `ingest:source:<id>` form.
     */
    static VALID_CHANNELS: string[];
    /**
     * Default max channel length. Mirrors the gateway original. Instances
     * read `this.maxChannelLength` (configurable via options) so this
     * static is purely cosmetic / back-compat.
     */
    static MAX_CHANNEL_LENGTH: number;
    messageRouter: IngestMessageRouter | null;
    logger: IngestLogger;
    metricsCollector: IngestMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxChannelLength: number;
    constructor(opts: IngestServiceOptions);
    /**
     * Dispatch an incoming action to its handler. Unknown actions reply
     * with an error frame.
     */
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    /**
     * Subscribe a client to an ingest channel. Valid formats:
     *   - ingest:progress
     *   - ingest:source:{sourceId}
     */
    handleSubscribe(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    /**
     * Unsubscribe a client from a previously-subscribed ingest channel.
     */
    handleUnsubscribe(clientId: string, { channel }: {
        channel?: string;
    }): Promise<void>;
    /**
     * Broadcast an ingest event to all subscribers of the given channel.
     * Called by the gateway ingest bridge when an IngestEvent arrives
     * from the engine's event bus.
     */
    emitEvent(channel: string, event: IngestEvent): Promise<void>;
    /**
     * Local-only fallback broadcast (used when no messageRouter is
     * available, e.g. tests or single-node mode).
     */
    _broadcastToLocalSubscribers(channel: string, message: unknown): void;
    /**
     * Validates that a channel string matches one of the allowed ingest
     * channel formats.
     */
    _isValidChannel(channel: unknown): boolean;
    /**
     * Cleanup on client disconnect — unsubscribes from all tracked channels.
     */
    handleDisconnect(clientId: string): Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
    sendError(clientId: string, message: string): void;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export default IngestService;
//# sourceMappingURL=IngestService.d.ts.map