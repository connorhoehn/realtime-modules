"use strict";
// realtime-modules/src/chat/SubscriptionTracker.ts
//
// Lifted from gateway/src/utils/subscription-tracker.ts on a conservative
// basis. Kept local to the chat module for Cut 2 because the sibling
// realtime-modules/src/presence/ directory is still empty — once the
// presence extraction lands, this file should move up to a shared
// location (likely realtime-modules/src/server/SubscriptionTracker.ts
// alongside the existing store contracts) and both chat + presence will
// import from there.
//
// The class is byte-identical to the gateway origin so existing gateway
// tests that touch `service.clientChannels.set/.get/.has/.delete` keep
// working unchanged when the gateway eventually swaps to consume this
// version.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionTracker = void 0;
/**
 * SubscriptionTracker — local in-memory tracking of `clientId → Set<channelId>`.
 *
 * Per-instance, in-memory only. Each service owns its own tracker.
 */
class SubscriptionTracker extends Map {
    /**
     * Track that `clientId` is subscribed to `channel`. Idempotent —
     * subscribing the same client to the same channel twice is a no-op.
     */
    addSubscription(clientId, channel) {
        let set = this.get(clientId);
        if (!set) {
            set = new Set();
            this.set(clientId, set);
        }
        set.add(channel);
    }
    /**
     * Untrack a single (clientId, channel) pair. If `clientId` ends up
     * with no remaining tracked channels, the `clientId` entry is removed
     * entirely so `size` reflects only clients that still have
     * subscriptions.
     *
     * @returns true if the channel was previously tracked, false otherwise.
     */
    removeSubscription(clientId, channel) {
        const set = this.get(clientId);
        if (!set)
            return false;
        const had = set.delete(channel);
        if (set.size === 0) {
            this.delete(clientId);
        }
        return had;
    }
    /**
     * Untrack all subscriptions for `clientId` and return the channels
     * that were tracked. Callers typically iterate the returned list to
     * issue downstream unsubscribe operations against the message router.
     */
    removeClient(clientId) {
        const channels = this.getChannels(clientId);
        if (channels.length > 0) {
            this.delete(clientId);
        }
        return channels;
    }
    /** Snapshot of channels currently tracked for `clientId`. */
    getChannels(clientId) {
        const set = this.get(clientId);
        return set ? Array.from(set) : [];
    }
    /** Whether `clientId` is currently tracked as subscribed to `channel`. */
    hasSubscription(clientId, channel) {
        return this.get(clientId)?.has(channel) ?? false;
    }
    /**
     * Iterate clientIds currently subscribed to `channel`. Used by
     * services that need to fan out a message locally without going
     * through the distributed message router (test mode, single-node
     * fallback).
     */
    *clientsSubscribedTo(channel) {
        for (const [clientId, channels] of this.entries()) {
            if (channels.has(channel)) {
                yield clientId;
            }
        }
    }
    /**
     * Standard stats shape that every consumer service returned from its
     * own `getStats()`. Exposed here so services can delegate verbatim.
     */
    getStats() {
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
exports.SubscriptionTracker = SubscriptionTracker;
//# sourceMappingURL=SubscriptionTracker.js.map