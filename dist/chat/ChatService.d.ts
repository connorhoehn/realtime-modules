import { LRUCache } from 'lru-cache';
import { SubscriptionTracker } from './SubscriptionTracker';
import { type ChatStore } from './ChatStore';
import { type ChatMember, type ChatMemberView, type ChatMembershipStore } from './ChatMembershipStore';
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
     * Who is in each channel and from when they may read it. Absent, every
     * channel is open (the pre-membership behaviour). See ChatMembershipStore.
     */
    membershipStore?: ChatMembershipStore;
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
    /**
     * Fires after every stored message on a NON-dm channel, with who should
     * hear about it: a closed channel's current members, an open channel's
     * currently subscribed users — the sender excluded either way. The host
     * turns it into unread counts / notifications; dm channels stay on
     * `onDmMessage`. Exceptions never fail the send.
     */
    onChannelMessage?: (info: {
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
    membershipStore: ChatMembershipStore | null;
    readonly enforceDmMembership: boolean;
    onDmMessage: ((info: {
        channel: string;
        members: string[];
        message: ChatMessage;
    }) => void) | null;
    onChannelMessage: ((info: {
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
    /**
     * Post a message that no connection sent.
     *
     * Something happened in the channel — a document was created in it, a call
     * started — and the thread is where people look for what happened. Every
     * other send path starts from a clientId, because every other message is
     * typed by somebody; this one has no connection behind it, so it takes the
     * store-and-broadcast path directly rather than pretending to be a client.
     *
     * It is persisted like any other message. An event that only live viewers
     * saw is not a record of anything, and the thread would disagree with
     * itself on the next reload.
     *
     * Returns the stored message, or null when the channel or text is missing.
     */
    postSystemMessage(channel: string, message: string, metadata?: Record<string, any>): Promise<ChatMessage | null>;
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
    sendChannelHistory(clientId: string, channel: string, userId?: string): Promise<void>;
    /**
     * Who should hear about a message on a non-dm channel, sender excluded:
     * a closed channel's active members; an open channel's currently
     * subscribed users (the only ones this node can name — an open channel
     * keeps no roster).
     */
    _channelMessageRecipients(channel: string, senderUserId: string | undefined): Promise<string[]>;
    /** Every row for the channel; [] when there is no store or the channel is open. */
    _membershipRows(channel: string): Promise<ChatMember[]>;
    /**
     * The channel's members as the wire reports them. A dm channel's members
     * are in its name; a channel with no rows is open (everyone may read).
     */
    describeMembers(channel: string): Promise<{
        open: boolean;
        members: ChatMemberView[];
    }>;
    /**
     * Channel membership gate. True when the channel is open (no rows), is a
     * dm channel (the dm gate owns those), or the sender is an active member.
     * FAIL-CLOSED on a closed channel: no resolvable userId ⇒ refused.
     */
    _checkMembership(clientId: string, channel: string, identity: ChatSenderIdentity | null): Promise<boolean>;
    /**
     * History for a PERSON: what the channel holds, from their `historyFrom`
     * on. A closed channel shows a non-member nothing; an open channel and a
     * dm channel show everything (the dm gate has already run).
     */
    getChannelHistoryFor(userId: string | undefined, channel: string, limit?: number): Promise<ChatMessage[]>;
    /** `{action:'members', channel}` → who is in it, to the sender. */
    handleMembers(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    /**
     * `{action:'addMembers', channel, userIds, history:{mode,days?}, names?}`.
     * The requester must be a member, or the channel open — in which case
     * they become its owner and the channel closes. Each added person gets a
     * history floor from the choice; re-adding a removed person restores
     * them with the new floor. The thread is told, and every subscriber gets
     * the new roster.
     */
    handleAddMembers(clientId: string, { channel, userIds, history, names }: {
        channel: string;
        userIds?: unknown;
        history?: unknown;
        names?: unknown;
    }): Promise<void>;
    /** `{action:'removeMember', channel, userId}` — an owner may remove anyone; anyone may remove themselves. */
    handleRemoveMember(clientId: string, { channel, userId, name }: {
        channel: string;
        userId?: unknown;
        name?: unknown;
    }): Promise<void>;
    /**
     * Unsubscribe every live connection of `userId` from `channel` and tell
     * each one `{type:'chat', action:'removed', channel, byUserId}` so the
     * client can say "You were removed from #x" and drop the thread. Runs on
     * this node's subscriptions; a multi-node deployment relies on the
     * membership row for the other nodes' next join/send (fail closed).
     */
    _evictFromChannel(channel: string, userId: string, byUserId: string): Promise<void>;
    /**
     * A membership change, as a stored message from the person who made it.
     * Not gated on a join: the owner adding people from a picker may not be
     * subscribed to the channel at that moment.
     */
    _postMembershipMessage(channel: string, clientId: string, identity: ChatSenderIdentity | null, text: string, metadata: Record<string, unknown>): Promise<ChatMessage>;
    /** The roster, to everyone in the channel and to the requester whether or not they are subscribed. */
    _broadcastMembers(channel: string, requesterClientId: string): Promise<void>;
    _persistMessage(messageData: ChatMessage): Promise<void>;
    _loadHistoryFromStore(channel: string, limit: number): Promise<ChatMessage[]>;
    /**
     * "Someone is typing" — relayed to the channel, never stored. Excluded
     * from the sender (their own composer knows), carried with the identity
     * the resolver gives the connection so the others can name them. A
     * connection that has not joined the channel is not in it, and may not
     * announce itself there.
     */
    handleTyping(clientId: string, { channel, typing }: {
        channel: string;
        typing?: unknown;
    }): Promise<void>;
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
    sendError(clientId: string, message: string, errorCode?: string, channel?: string): void;
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