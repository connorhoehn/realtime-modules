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
    /**
     * Publish to a channel. `opts.publisherClientId` (M3 gap #9) names the
     * AUTHZ subject independently of `excludeClientId` (echo control), so the
     * router enforces CRD publisher restrictions even when the sender is NOT
     * excluded (sender-echo). Optional for back-compat with older routers.
     */
    sendToChannel(channel: string, message: any, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
    }): Promise<void> | void;
    /**
     * Subscribe a client to a channel. Returns `false` when operator-pushed
     * channel config denies the subscribe (the router has already emitted
     * AUTHZ_CHANNEL_DENIED). `void`/`true` ⇒ subscribed. handleJoinChannel
     * (M3 gap #10) honours a `false` return: no joined ack, no local sub.
     */
    subscribeToChannel?(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    getClientData?(clientId: string): any;
    /** Optional flag — when explicitly `false`, broadcast warns about Redis. */
    redisAvailable?: boolean;
}
/**
 * Sender identity as resolved from a connection id. `userId` is the
 * authenticated subject (stable across reconnects); displayName/avatarUrl
 * are presentation hints merged into message metadata where the sender
 * didn't already provide them.
 */
export interface ChatSenderIdentity {
    userId?: string;
    displayName?: string;
    avatarUrl?: string;
}
export type ChatIdentityResolver = (clientId: string) => ChatSenderIdentity | null | undefined;
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
    /**
     * Maps a CONNECTION id to the authenticated sender identity. When it
     * yields a `userId`, every sent message is stamped with
     * `message.userId`, and `displayName` / `avatarUrl` are merged into
     * `message.metadata` ONLY for keys the sender didn't already provide
     * (sender-provided metadata wins). Absent resolver ⇒ send behavior is
     * identical to pre-v0.23.0 (no userId stamped).
     *
     * Also the identity source for dm-membership enforcement — see
     * `enforceDmMembership`.
     */
    identityResolver?: (clientId: string) => {
        userId?: string;
        displayName?: string;
        avatarUrl?: string;
    } | null | undefined;
    /**
     * Enforce membership on member-addressed dm channels
     * (`chat:dm:<sorted userIds>` — see src/chat/dmChannels.ts). On `join`
     * and `send` to a dm channel whose members are parseable from the
     * name, the sender's resolved userId must be in the member list;
     * otherwise the request is rejected with a CHAT_DM_FORBIDDEN error
     * frame. FAIL-CLOSED: no resolvable identity (no resolver, resolver
     * returned null/no userId, resolver threw) ⇒ reject. Hashed group
     * channels (`chat:dmg:`) are not parseable and are NOT enforced here
     * (gate those via `authz`). Non-dm channels are never affected.
     *
     * Default: true when `identityResolver` is provided, else false.
     */
    enforceDmMembership?: boolean;
    /**
     * Fire-and-forget observer invoked AFTER a successful send on a dm
     * chat channel (both `chat:dm:` and `chat:dmg:` forms). Exceptions
     * are swallowed (logged) — it can never fail or block the send path.
     * `members` is parsed from the channel name; for hashed `chat:dmg:`
     * channels it is `[]` (membership is non-reversible — consumers keep
     * their own index). The gateway uses this seam to maintain a
     * conversations index and fire notifications.
     */
    onDmMessage?: (info: {
        channel: string;
        members: string[];
        message: ChatMessage;
    }) => void;
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
    identityResolver: ChatIdentityResolver | null;
    readonly enforceDmMembership: boolean;
    onDmMessage: ((info: {
        channel: string;
        members: string[];
        message: ChatMessage;
    }) => void) | null;
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
    broadcastMessage(channel: string, messageData: ChatMessage, publisherClientId?: string): Promise<void>;
    /**
     * Resolve the sender identity for a connection, or null. A throwing
     * resolver is logged and treated as "no identity" — which the dm gate
     * below turns into a fail-closed rejection.
     */
    _resolveIdentity(clientId: string): ChatSenderIdentity | null;
    /**
     * DM membership gate. Returns true when the operation may proceed.
     * Only member-addressed dm channels (`chat:dm:` with parseable member
     * list) are enforced; hashed `chat:dmg:` and non-dm channels always
     * pass. FAIL-CLOSED: on an enforced channel, a sender with no
     * resolvable userId is rejected.
     */
    _checkDmMembership(clientId: string, channel: string, identity: ChatSenderIdentity | null): boolean;
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