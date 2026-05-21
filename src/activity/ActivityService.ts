// realtime-modules/src/activity/ActivityService.ts
//
// Activity-feed service — lifted from gateway's
// src/realtime-fanout/activity-service.ts on a conservative basis
// (Wave 2 — activity extraction).
//
// Lift changes vs the gateway original:
//
//   - Positional ctor `(messageRouter, logger, metricsCollector,
//     redisClient, dynamoClient)` replaced with a single
//     `ActivityServiceOpts` bag. `dynamoClient` is dropped entirely (the
//     inline-DDB fallback was retired in wave2-gw-5; durability is owned
//     by the event-catalog → message-queue path that stays in the gateway
//     adapter). `redisClient` is replaced by an `ActivityHistoryStore`
//     interface so the lifted module is transport-agnostic — the
//     Redis-backed concrete adapter stays in the gateway.
//
//   - `setEventCatalog` setter is REMOVED from the lifted surface. The
//     event-catalog durable publish + retry-with-backoff path lives in
//     the gateway adapter, not here. Lifted ActivityService is the WS
//     surface only.
//
//   - Validation constants (ACTIVITY_MAX_HISTORY_ITEMS, channel id
//     length cap) are inlined with the same values gateway/src/config/
//     constants.ts ships today. Consumers can override via the options
//     bag.
//
// Everything else — handleAction dispatch, subscribe/unsubscribe/publish/
// getHistory envelopes, auto-subscribe to BROADCAST_CHANNEL on connect,
// `_broadcastToLocalSubscribers` local fallback, history query path with
// store-empty fallback, error-frame shape — is preserved verbatim.

import {
    type ActivityHistoryStore,
    InMemoryActivityHistoryStore,
} from './ActivityHistoryStore';
import type { ActivityEvent, ActivityEventConfig } from './types';

// ---- Inlined config (gateway/config/constants.ts replacements) ------------

const DEFAULT_MAX_HISTORY_ITEMS = 200;
const DEFAULT_MAX_CHANNEL_ID_LENGTH = 100;

// ---- Options bag ----------------------------------------------------------

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

// ---- ActivityService ------------------------------------------------------

/**
 * Per-client local subscription tracker. Inlined here rather than
 * imported from a sibling because the activity service only needs the
 * Map-style surface + clientsSubscribedTo iterator. Mirrors the inlining
 * convention already used by ReactionService.
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
        for (const set of this.values()) total += set.size;
        return { subscribedClients: this.size, totalSubscriptions: total };
    }
}

export class ActivityService {
    static BROADCAST_CHANNEL = 'activity:broadcast';

    messageRouter: ActivityMessageRouter | null;
    logger: ActivityLogger;
    metricsCollector: any;
    historyStore: ActivityHistoryStore;
    clientChannels: SubscriptionTracker;

    readonly maxHistoryItems: number;
    readonly maxChannelIdLength: number;

    constructor(opts: ActivityServiceOpts) {
        if (!opts || !opts.logger) {
            throw new Error('ActivityService: logger is required');
        }

        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const cfg: ActivityEventConfig = opts.config ?? {};
        this.maxHistoryItems = cfg.maxHistoryItems ?? DEFAULT_MAX_HISTORY_ITEMS;
        this.maxChannelIdLength = cfg.maxChannelIdLength ?? DEFAULT_MAX_CHANNEL_ID_LENGTH;

        this.historyStore = opts.historyStore ?? new InMemoryActivityHistoryStore(this.maxHistoryItems);

        this.clientChannels = new SubscriptionTracker();
    }

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        try {
            switch (action) {
                case 'subscribe':
                    return await this.handleSubscribe(clientId, data);
                case 'unsubscribe':
                    return await this.handleUnsubscribe(clientId, data);
                case 'publish':
                    return await this.handlePublish(clientId, data);
                case 'getHistory':
                    return await this.handleGetHistory(clientId, data);
                default:
                    this.sendError(clientId, `Unknown activity action: ${action}`);
            }
        } catch (error: any) {
            this.logger.error('Error handling activity action', {
                action,
                clientId,
                errorMessage: error && error.message,
            });
            this.sendError(clientId, 'Internal server error');
        }
    }

    async handleSubscribe(clientId: string, { channelId }: { channelId: string }): Promise<void> {
        if (!channelId || typeof channelId !== 'string' || channelId.length === 0 || channelId.length > this.maxChannelIdLength) {
            this.sendError(
                clientId,
                `channelId is required (string, max ${this.maxChannelIdLength} chars)`,
            );
            return;
        }

        if (this.messageRouter && this.messageRouter.subscribeToChannel) {
            await this.messageRouter.subscribeToChannel(clientId, channelId);
        }

        this.clientChannels.addSubscription(clientId, channelId);

        this.sendToClient(clientId, {
            type: 'activity',
            action: 'subscribed',
            channelId,
            timestamp: new Date().toISOString(),
        });

        this.logger.info('Client subscribed to activity channel', { clientId, channelId });
    }

    async handleUnsubscribe(clientId: string, { channelId }: { channelId: string }): Promise<void> {
        if (!channelId) {
            this.sendError(clientId, 'channelId is required');
            return;
        }

        if (this.messageRouter && this.messageRouter.unsubscribeFromChannel) {
            await this.messageRouter.unsubscribeFromChannel(clientId, channelId);
        }

        this.clientChannels.removeSubscription(clientId, channelId);

        this.sendToClient(clientId, {
            type: 'activity',
            action: 'unsubscribed',
            channelId,
            timestamp: new Date().toISOString(),
        });

        this.logger.info('Client unsubscribed from activity channel', { clientId, channelId });
    }

    async handlePublish(clientId: string, data: any): Promise<void> {
        const { event } = data ?? {};

        if (!event || typeof event !== 'object') {
            this.sendError(clientId, 'event object is required');
            return;
        }

        if (!event.eventType || typeof event.eventType !== 'string') {
            this.sendError(clientId, 'event.eventType is required (string)');
            return;
        }

        const timestamp = new Date().toISOString();
        const clientData = this.messageRouter && this.messageRouter.getClientData
            ? this.messageRouter.getClientData(clientId)
            : null;
        const userId = clientData?.userContext?.userId ?? null;
        const displayName = clientData?.metadata?.displayName
            ?? clientData?.userContext?.displayName
            ?? clientData?.userContext?.username
            ?? userId
            ?? 'anonymous';

        const enrichedPayload: ActivityEvent = {
            eventType: event.eventType,
            detail: event.detail || {},
            timestamp,
            userId,
            displayName,
        };

        const broadcastMessage = {
            type: 'activity:event',
            payload: enrichedPayload,
        };

        // Persist event to history store (non-blocking).
        this.historyStore
            .append(ActivityService.BROADCAST_CHANNEL, enrichedPayload)
            .catch((err: any) =>
                this.logger.error('Failed to persist activity event', {
                    errorMessage: err && err.message,
                }),
            );

        // Broadcast to all subscribers of activity:broadcast.
        if (this.messageRouter && this.messageRouter.sendToChannel) {
            await this.messageRouter.sendToChannel(
                ActivityService.BROADCAST_CHANNEL,
                broadcastMessage,
            );
        } else {
            // Local-only mode: broadcast directly to all local subscribers.
            this._broadcastToLocalSubscribers(ActivityService.BROADCAST_CHANNEL, broadcastMessage);
        }

        // Confirm to the publishing client.
        this.sendToClient(clientId, {
            type: 'activity',
            action: 'published',
            eventType: event.eventType,
            timestamp,
        });

        this.logger.info('Client published activity event', { clientId, eventType: event.eventType });
    }

    /**
     * Auto-subscribe a newly connected client to the global
     * activity:broadcast channel. Called by the server on connection
     * setup.
     */
    async onClientConnect(clientId: string): Promise<void> {
        try {
            await this.handleSubscribe(clientId, { channelId: ActivityService.BROADCAST_CHANNEL });
            this.logger.debug('Client auto-subscribed to broadcast channel', {
                clientId,
                channel: ActivityService.BROADCAST_CHANNEL,
            });
        } catch (error: any) {
            this.logger.error('Failed to auto-subscribe client to broadcast channel', {
                clientId,
                channel: ActivityService.BROADCAST_CHANNEL,
                errorMessage: error && error.message,
            });
        }
    }

    /**
     * Broadcast a message to all local subscribers of a channel
     * (local-only / no-router fallback).
     */
    _broadcastToLocalSubscribers(channelId: string, message: any): void {
        for (const subscriberClientId of this.clientChannels.clientsSubscribedTo(channelId)) {
            this.sendToClient(subscriberClientId, message);
        }
    }

    /**
     * Return recent activity history from the store.
     * Client sends: { service: 'activity', action: 'getHistory', limit: 50 }
     */
    async handleGetHistory(clientId: string, data: any): Promise<void> {
        const limit = Math.min(
            Math.max(parseInt(data?.limit, 10) || 50, 1),
            this.maxHistoryItems,
        );
        const channelId = data?.channelId || ActivityService.BROADCAST_CHANNEL;

        try {
            const events = await this.historyStore.list(channelId, limit);
            this.sendToClient(clientId, {
                type: 'activity',
                action: 'history',
                events,
                channelId,
                timestamp: new Date().toISOString(),
            });
            this.logger.info('Sent history events to client', { clientId, eventCount: events.length });
        } catch (err: any) {
            this.logger.error('Error retrieving activity history', {
                clientId,
                errorMessage: err && err.message,
            });
            this.sendToClient(clientId, {
                type: 'activity',
                action: 'history',
                events: [],
                channelId,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async handleDisconnect(clientId: string): Promise<void> {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channelId of channels) {
            try {
                if (this.messageRouter && this.messageRouter.unsubscribeFromChannel) {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channelId);
                }
            } catch (error: any) {
                this.logger.error('Error unsubscribing client from activity channel', {
                    clientId,
                    channelId,
                    errorMessage: error && error.message,
                });
            }
        }
        this.logger.debug('Client disconnected from activity service', { clientId });
    }

    sendToClient(clientId: string, message: any): void {
        if (this.messageRouter) {
            this.messageRouter.sendToClient(clientId, message);
        }
    }

    sendError(clientId: string, message: string): void {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'activity',
            message,
            timestamp: new Date().toISOString(),
        });
    }

    getStats(): { subscribedClients: number; totalSubscriptions: number } {
        return this.clientChannels.getStats();
    }
}

export default ActivityService;
