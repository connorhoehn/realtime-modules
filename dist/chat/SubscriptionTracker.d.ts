/**
 * SubscriptionTracker — local in-memory tracking of `clientId → Set<channelId>`.
 *
 * Per-instance, in-memory only. Each service owns its own tracker.
 */
export declare class SubscriptionTracker extends Map<string, Set<string>> {
    /**
     * Track that `clientId` is subscribed to `channel`. Idempotent —
     * subscribing the same client to the same channel twice is a no-op.
     */
    addSubscription(clientId: string, channel: string): void;
    /**
     * Untrack a single (clientId, channel) pair. If `clientId` ends up
     * with no remaining tracked channels, the `clientId` entry is removed
     * entirely so `size` reflects only clients that still have
     * subscriptions.
     *
     * @returns true if the channel was previously tracked, false otherwise.
     */
    removeSubscription(clientId: string, channel: string): boolean;
    /**
     * Untrack all subscriptions for `clientId` and return the channels
     * that were tracked. Callers typically iterate the returned list to
     * issue downstream unsubscribe operations against the message router.
     */
    removeClient(clientId: string): string[];
    /** Snapshot of channels currently tracked for `clientId`. */
    getChannels(clientId: string): string[];
    /** Whether `clientId` is currently tracked as subscribed to `channel`. */
    hasSubscription(clientId: string, channel: string): boolean;
    /**
     * Iterate clientIds currently subscribed to `channel`. Used by
     * services that need to fan out a message locally without going
     * through the distributed message router (test mode, single-node
     * fallback).
     */
    clientsSubscribedTo(channel: string): IterableIterator<string>;
    /**
     * Standard stats shape that every consumer service returned from its
     * own `getStats()`. Exposed here so services can delegate verbatim.
     */
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
//# sourceMappingURL=SubscriptionTracker.d.ts.map