import { LRUCache } from 'lru-cache';
import { SubscriptionTracker } from './SubscriptionTracker';
import { type ChatStore } from './ChatStore';
import type { ChatMessage } from './types';
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
    maxMessagesPerChannel?: number;
    maxMessageLength?: number;
    maxChannelNameLength?: number;
    maxMetadataKeys?: number;
    maxMetadataSize?: number;
    defaultHistoryLimit?: number;
    joinHistoryLimit?: number;
    cacheCleanupIntervalMs?: number;
}
export declare class ChatService {
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
    private readonly _cleanupSweep;
    constructor(opts: ChatServiceOpts);
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleJoinChannel(clientId: string, { channel, metadata: _metadata }: {
        channel: string;
        metadata?: any;
    }): Promise<void>;
    handleLeaveChannel(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleSendMessage(clientId: string, { channel, message, metadata }: {
        channel: string;
        message: string;
        metadata?: any;
    }): Promise<void>;
    handleGetHistory(clientId: string, { channel, limit }: {
        channel: string;
        limit?: number;
    }): Promise<void>;
    getChannelCache(channelId: string): LRUCache<string, ChatMessage>;
    addToChannelHistory(channel: string, messageData: ChatMessage): void;
    getChannelHistory(channel: string, limit?: number): Promise<ChatMessage[]>;
    sendChannelHistory(clientId: string, channel: string): Promise<void>;
    _persistMessage(messageData: ChatMessage): Promise<void>;
    _loadHistoryFromStore(channel: string, limit: number): Promise<ChatMessage[]>;
    broadcastMessage(channel: string, messageData: ChatMessage): Promise<void>;
    generateMessageId(): string;
    sendToClient(clientId: string, message: any): void;
    sendError(clientId: string, message: string, errorCode?: string): void;
    onClientConnect(clientId: string): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    shutdown(): Promise<void>;
    getStats(): {
        connectedClients: number;
        activeChannels: number;
        totalMessages: number;
        isDistributed: boolean;
    };
}
export default ChatService;
//# sourceMappingURL=ChatService.d.ts.map