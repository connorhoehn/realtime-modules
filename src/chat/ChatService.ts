// realtime-modules/src/chat/ChatService.ts
//
// Chat service — lifted from gateway's src/realtime-fanout/chat-service.ts
// on a conservative basis (Wave 2 / Cut 2).
//
// Logic changes vs. the gateway original are isolated to the
// constructor wiring — handler bodies, validation thresholds, and wire
// envelopes are preserved verbatim:
//
//   - The `(messageRouter, logger, metricsCollector, dynamoClient)`
//     positional ctor is replaced with a single options-bag ctor that
//     takes a `ChatStore` (defaults to InMemoryChatStore) instead of a
//     `dynamoClient`. Gateway-specific DDB wiring is gone — the
//     concrete `DynamoChatStore` adapter stays in gateway.
//
//   - `enforceChannelPermission` (gateway authz middleware) becomes an
//     optional `authz` hook on the options bag, matching the convention
//     established by CRDT Cut 1. Defaults to permissive pass-through so
//     the lifted module is usable in tests / zero-config consumers.
//
//   - `ErrorCodes` / `createErrorResponse` from gateway/utils are
//     inlined as minimal constants so the lifted module has no
//     gateway-source imports.
//
//   - The ownership-cleanup-coordinator wiring (`_registerOwnershipHandlers`,
//     `_cleanupRoom`, and the `require('../services/ownership-cleanup-coordinator')`
//     side-effect import) is LEFT IN GATEWAY. It depends on the gateway's
//     Raft-eviction lifecycle and would re-introduce a gateway import here.
//
//   - Validation constants (CHAT_*, MAX_METADATA_*, MAX_CHANNEL_NAME_LENGTH)
//     are inlined with the same values gateway/src/config/constants.ts
//     ships today. Consumers can override via the options bag.
//
// Everything else — handleAction dispatch, channel-cache LRU,
// subscription tracking, DDB fallback on history reads, periodic
// channel-cache sweep, shutdown — is preserved verbatim.

import { LRUCache } from 'lru-cache';
import { PeriodicSweep } from 'distributed-core';

import { SubscriptionTracker } from './SubscriptionTracker';
import { InMemoryChatStore, type ChatStore } from './ChatStore';
import type { ChatMessage } from './types';

// ---- Inlined config (gateway/config/constants.ts replacements) ------------

const DEFAULT_MAX_METADATA_KEYS = 20;
const DEFAULT_MAX_METADATA_SIZE = 4096;
const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 100;
const DEFAULT_CACHE_CLEANUP_INTERVAL_MS = 300_000;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_JOIN_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 50;

// ---- Inlined error helpers (gateway/utils/error-codes.ts replacement) -----

const ErrorCodes = {
    SERVICE_INTERNAL_ERROR: 'SERVICE_INTERNAL_ERROR',
} as const;

function createErrorResponse(
    code: string,
    message: string,
    context: Record<string, any> = {}
): { error: Record<string, any> } {
    return { error: { code, message, ...context } };
}

// ---- Options bag ----------------------------------------------------------

export interface ChatLogger {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}

export interface ChatMessageRouter {
    sendToClient(clientId: string, message: any): void;
    sendToChannel(channel: string, message: any): Promise<void> | void;
    subscribeToChannel?(clientId: string, channel: string): Promise<void> | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    getClientData?(clientId: string): any;
    /** Optional flag — when explicitly `false`, broadcast warns about Redis. */
    redisAvailable?: boolean;
}

export interface ChatServiceOpts {
    messageRouter: ChatMessageRouter;
    logger: ChatLogger;
    metricsCollector?: any;
    /**
     * Persistence backend. Defaults to `InMemoryChatStore` so the lifted
     * module is usable in tests / zero-config consumers. Gateway wires the
     * concrete DynamoDB adapter here.
     */
    chatStore?: ChatStore;
    /**
     * Optional authz hook. Returns true if the client is permitted to
     * access the channel; false (after sending its own error message)
     * otherwise. Defaults to permissive — gateway swaps in a wrapper over
     * `enforceChannelPermission` from its authz middleware.
     */
    authz?: (clientId: string, channel: string, service: ChatService) => boolean;

    // ---- Tunables (all default to gateway/config/constants.ts values) ----
    maxMessagesPerChannel?: number;
    maxMessageLength?: number;
    maxChannelNameLength?: number;
    maxMetadataKeys?: number;
    maxMetadataSize?: number;
    defaultHistoryLimit?: number;
    joinHistoryLimit?: number;
    cacheCleanupIntervalMs?: number;
}

// ---- Helpers --------------------------------------------------------------

function validateMetadata(
    metadata: any,
    logger: ChatLogger,
    maxKeys: number,
    maxSize: number
): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object') return {};

    // Limit number of keys
    const keys = Object.keys(metadata);
    if (keys.length > maxKeys) {
        logger.warn(`Metadata exceeds key limit: ${keys.length}/${maxKeys}`);
        const truncated: any = {};
        for (let i = 0; i < maxKeys; i++) {
            truncated[keys[i]] = metadata[keys[i]];
        }
        metadata = truncated;
    }

    // Limit total serialized size
    const serialized = JSON.stringify(metadata);
    if (serialized.length > maxSize) {
        logger.warn(`Metadata exceeds size limit: ${serialized.length}/${maxSize}`);
        return { _truncated: true, displayName: metadata.displayName || 'unknown' };
    }

    return metadata;
}

// ---- ChatService ----------------------------------------------------------

export class ChatService {
    messageRouter: ChatMessageRouter;
    logger: ChatLogger;
    metricsCollector: any;
    chatStore: ChatStore;
    authz: (clientId: string, channel: string, service: ChatService) => boolean;

    clientChannels: SubscriptionTracker;
    channelCaches: Map<string, LRUCache<string, ChatMessage>>;

    readonly maxMessagesPerChannel: number;
    readonly maxMessageLength: number;
    readonly maxChannelNameLength: number;
    readonly maxMetadataKeys: number;
    readonly maxMetadataSize: number;
    readonly defaultHistoryLimit: number;
    readonly joinHistoryLimit: number;
    readonly cacheCleanupIntervalMs: number;

    isDistributed: boolean;
    private readonly _cleanupSweep: PeriodicSweep;

    constructor(opts: ChatServiceOpts) {
        if (!opts || !opts.messageRouter) {
            throw new Error('ChatService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('ChatService: logger is required');
        }

        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;
        this.chatStore = opts.chatStore ?? new InMemoryChatStore();
        this.authz = opts.authz ?? (() => true);

        this.maxMessagesPerChannel = opts.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;
        this.maxMessageLength = opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
        this.maxChannelNameLength = opts.maxChannelNameLength ?? DEFAULT_MAX_CHANNEL_NAME_LENGTH;
        this.maxMetadataKeys = opts.maxMetadataKeys ?? DEFAULT_MAX_METADATA_KEYS;
        this.maxMetadataSize = opts.maxMetadataSize ?? DEFAULT_MAX_METADATA_SIZE;
        this.defaultHistoryLimit = opts.defaultHistoryLimit ?? DEFAULT_HISTORY_LIMIT;
        this.joinHistoryLimit = opts.joinHistoryLimit ?? DEFAULT_JOIN_HISTORY_LIMIT;
        this.cacheCleanupIntervalMs = opts.cacheCleanupIntervalMs ?? DEFAULT_CACHE_CLEANUP_INTERVAL_MS;

        // Local state management
        this.clientChannels = new SubscriptionTracker();
        this.channelCaches = new Map();

        // Configuration — distributed iff the router exposes the
        // subscribe/unsubscribe helpers (gateway always does).
        this.isDistributed = typeof this.messageRouter.subscribeToChannel === 'function';

        this._cleanupSweep = new PeriodicSweep({
            intervalMs: this.cacheCleanupIntervalMs,
            fn: () => {
                for (const [channelId, cache] of this.channelCaches.entries()) {
                    if (cache.size === 0) {
                        this.channelCaches.delete(channelId);
                    }
                }
            },
            onError: (err) => this.logger.error('Chat cache cleanup error', err),
        });
        this._cleanupSweep.start();
    }

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        const startTime = Date.now();
        try {
            switch (action) {
                case 'join':
                    await this.handleJoinChannel(clientId, data);
                    return;
                case 'leave':
                    await this.handleLeaveChannel(clientId, data);
                    return;
                case 'send':
                    await this.handleSendMessage(clientId, data);
                    return;
                case 'history':
                    await this.handleGetHistory(clientId, data);
                    return;
                default:
                    this.sendError(clientId, `Unknown chat action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`Error handling chat action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        } finally {
            const duration = Date.now() - startTime;
            this.logger.info(`[chat] ${action}`, { clientId, channel: data?.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: chat/${action} took ${duration}ms`, { clientId });
            }
        }
    }

    async handleJoinChannel(
        clientId: string,
        { channel, metadata: _metadata = {} }: { channel: string; metadata?: any }
    ): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        if (typeof channel !== 'string' || channel.length === 0 || channel.length > this.maxChannelNameLength) {
            this.sendError(
                clientId,
                `Channel name must be a string between 1 and ${this.maxChannelNameLength} characters`
            );
            return;
        }

        try {
            if (!this.authz(clientId, channel, this)) {
                return;
            }

            if (this.isDistributed && this.messageRouter.subscribeToChannel) {
                await this.messageRouter.subscribeToChannel(clientId, channel);
            }

            this.clientChannels.addSubscription(clientId, channel);

            this.sendToClient(clientId, {
                type: 'chat',
                action: 'joined',
                channel,
                timestamp: new Date().toISOString(),
            });

            await this.sendChannelHistory(clientId, channel);

            this.logger.info(`Client ${clientId} joined chat channel: ${channel}`);
        } catch (error) {
            this.logger.error(`Error joining channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to join channel');
        }
    }

    async handleLeaveChannel(
        clientId: string,
        { channel }: { channel: string }
    ): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        try {
            if (this.isDistributed && this.messageRouter.unsubscribeFromChannel) {
                await this.messageRouter.unsubscribeFromChannel(clientId, channel);
            }

            this.clientChannels.removeSubscription(clientId, channel);

            this.sendToClient(clientId, {
                type: 'chat',
                action: 'left',
                channel,
                timestamp: new Date().toISOString(),
            });

            this.logger.info(`Client ${clientId} left chat channel: ${channel}`);
        } catch (error) {
            this.logger.error(`Error leaving channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to leave channel');
        }
    }

    async handleSendMessage(
        clientId: string,
        { channel, message, metadata = {} }: { channel: string; message: string; metadata?: any }
    ): Promise<void> {
        if (!channel || !message) {
            this.sendError(clientId, 'Channel and message are required');
            return;
        }

        if (typeof message !== 'string' || message.length === 0 || message.length > this.maxMessageLength) {
            this.sendError(
                clientId,
                `Message must be a string between 1 and ${this.maxMessageLength} characters`
            );
            return;
        }

        metadata = validateMetadata(metadata, this.logger, this.maxMetadataKeys, this.maxMetadataSize);

        if (!this.clientChannels.hasSubscription(clientId, channel)) {
            this.sendError(clientId, 'You must join the channel before sending messages');
            return;
        }

        try {
            const messageData: ChatMessage = {
                id: this.generateMessageId(),
                clientId,
                channel,
                message,
                metadata,
                timestamp: new Date().toISOString(),
            };

            // Store in local cache + persist (fire-and-forget)
            this.addToChannelHistory(channel, messageData);
            this._persistMessage(messageData).catch((err: any) =>
                this.logger.error('Failed to persist chat message:', err && err.message)
            );

            await this.broadcastMessage(channel, messageData);

            this.sendToClient(clientId, {
                type: 'chat',
                action: 'sent',
                messageId: messageData.id,
                channel,
                timestamp: messageData.timestamp,
            });

            this.logger.info(`Message sent by client ${clientId} to channel ${channel}`);
        } catch (error) {
            this.logger.error(`Error sending message to channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to send message');
        }
    }

    async handleGetHistory(
        clientId: string,
        { channel, limit }: { channel: string; limit?: number }
    ): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        try {
            const history = await this.getChannelHistory(channel, limit ?? this.defaultHistoryLimit);
            this.sendToClient(clientId, {
                type: 'chat',
                action: 'history',
                channel,
                messages: history,
                timestamp: new Date().toISOString(),
            });
            this.logger.debug(`Sent message history for channel ${channel} to client ${clientId}`);
        } catch (error) {
            this.logger.error(`Error getting history for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to get message history');
        }
    }

    getChannelCache(channelId: string): LRUCache<string, ChatMessage> {
        if (!this.channelCaches.has(channelId)) {
            const cache = new LRUCache<string, ChatMessage>({
                max: this.maxMessagesPerChannel,
                updateAgeOnGet: false,
                updateAgeOnHas: false,
            });
            this.channelCaches.set(channelId, cache);
        }
        return this.channelCaches.get(channelId)!;
    }

    addToChannelHistory(channel: string, messageData: ChatMessage): void {
        const cache = this.getChannelCache(channel);
        cache.set(messageData.id, messageData);
    }

    async getChannelHistory(channel: string, limit?: number): Promise<ChatMessage[]> {
        const effectiveLimit = limit ?? this.defaultHistoryLimit;
        const cache = this.getChannelCache(channel);
        const allMessages = Array.from(cache.values());
        if (allMessages.length > 0) {
            return allMessages.slice(-effectiveLimit);
        }

        // LRU cache empty — fall back to the store
        const storeMessages = await this._loadHistoryFromStore(channel, effectiveLimit);
        if (storeMessages.length > 0) {
            for (const msg of storeMessages) {
                cache.set(msg.id, msg);
            }
        }
        return storeMessages;
    }

    async sendChannelHistory(clientId: string, channel: string): Promise<void> {
        const history = await this.getChannelHistory(channel, this.joinHistoryLimit);
        if (history.length > 0) {
            this.sendToClient(clientId, {
                type: 'chat',
                action: 'history',
                channel,
                messages: history,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async _persistMessage(messageData: ChatMessage): Promise<void> {
        await this.chatStore.putMessage(messageData);
    }

    async _loadHistoryFromStore(channel: string, limit: number): Promise<ChatMessage[]> {
        try {
            return await this.chatStore.listMessages(channel, limit);
        } catch (err: any) {
            this.logger.error('ChatStore history load failed:', err && err.message);
            return [];
        }
    }

    async broadcastMessage(channel: string, messageData: ChatMessage): Promise<void> {
        const broadcastMessage = {
            type: 'chat',
            action: 'message',
            channel,
            message: messageData,
            timestamp: new Date().toISOString(),
        };

        const redisAvailable = this.messageRouter.redisAvailable !== false;
        await this.messageRouter.sendToChannel(channel, broadcastMessage);

        if (!redisAvailable) {
            this.logger.debug(`Redis unavailable, message delivered to local clients only`);
        }
    }

    generateMessageId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    sendToClient(clientId: string, message: any): void {
        if (!this.messageRouter) throw new Error('ChatService: messageRouter is required');
        this.messageRouter.sendToClient(clientId, message);
    }

    sendError(
        clientId: string,
        message: string,
        errorCode: string = ErrorCodes.SERVICE_INTERNAL_ERROR
    ): void {
        const errorResponse = createErrorResponse(errorCode, message, {
            service: 'chat',
            clientId,
        });

        this.sendToClient(clientId, {
            type: 'error',
            service: 'chat',
            ...errorResponse,
        });

        if (this.metricsCollector && typeof this.metricsCollector.recordError === 'function') {
            this.metricsCollector.recordError(errorCode);
        }
    }

    // Client lifecycle methods
    async onClientConnect(clientId: string): Promise<void> {
        this.logger.debug(`Client ${clientId} connected to chat service`);
    }

    async onClientDisconnect(clientId: string): Promise<void> {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channel of channels) {
            if (this.isDistributed && this.messageRouter.unsubscribeFromChannel) {
                try {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channel);
                } catch (error) {
                    this.logger.error(
                        `Error unsubscribing client ${clientId} from channel ${channel}:`,
                        error
                    );
                }
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from chat service`);
    }

    // Service lifecycle methods
    async shutdown(): Promise<void> {
        await this._cleanupSweep.stop();
        this.clientChannels.clear();
        this.channelCaches.clear();
        this.logger.info('Chat service shut down');
    }

    // Utility methods for debugging/monitoring
    getStats(): {
        connectedClients: number;
        activeChannels: number;
        totalMessages: number;
        isDistributed: boolean;
    } {
        let totalMessages = 0;
        for (const cache of this.channelCaches.values()) {
            totalMessages += cache.size;
        }
        return {
            connectedClients: this.clientChannels.size,
            activeChannels: this.channelCaches.size,
            totalMessages,
            isDistributed: this.isDistributed,
        };
    }
}

export default ChatService;
