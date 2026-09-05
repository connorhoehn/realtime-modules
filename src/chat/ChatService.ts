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
import { isDmChatChannel, dmChannelMembers } from './dmChannels';
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
    /** Sender is not (or cannot be proven to be) a member of a dm channel. */
    CHAT_DM_FORBIDDEN: 'CHAT_DM_FORBIDDEN',
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

export type ChatIdentityResolver = (
    clientId: string
) => ChatSenderIdentity | null | undefined;

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
    identityResolver?: (clientId: string) => { userId?: string; displayName?: string; avatarUrl?: string } | null | undefined;

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
    onDmMessage?: (info: { channel: string; members: string[]; message: ChatMessage }) => void;

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
    identityResolver: ChatIdentityResolver | null;
    readonly enforceDmMembership: boolean;
    onDmMessage: ((info: { channel: string; members: string[]; message: ChatMessage }) => void) | null;

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
        this.identityResolver = opts.identityResolver ?? null;
        // DM enforcement defaults ON exactly when an identity source exists;
        // consumers can force it either way explicitly.
        this.enforceDmMembership = opts.enforceDmMembership ?? this.identityResolver != null;
        this.onDmMessage = opts.onDmMessage ?? null;

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

            // DM membership gate (v0.23.0) — fail-closed on member-addressed
            // dm channels. Runs before the router subscribe so a forbidden
            // client never acquires a distributed subscription.
            if (!this._checkDmMembership(clientId, channel, this._resolveIdentity(clientId))) {
                return;
            }

            // M3 gap #10: respect the router's subscribe authz decision.
            // subscribeToChannel returns `false` when operator-pushed channel
            // config (RealtimeChannel/ChatRoom CRD) denies the subscribe — it
            // has ALREADY emitted AUTHZ_CHANNEL_DENIED to the client. Previously
            // we ignored that return, registered a local subscription anyway,
            // and acked `{type:'chat',action:'joined'}` — telling the client it
            // had joined a channel the gateway refused. On denial: register no
            // local subscription, send no joined ack, skip history.
            if (this.isDistributed && this.messageRouter.subscribeToChannel) {
                const subscribed = await this.messageRouter.subscribeToChannel(clientId, channel);
                if (subscribed === false) {
                    this.logger.info(`Client ${clientId} subscribe to chat channel ${channel} denied by router authz`);
                    return;
                }
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
    async postSystemMessage(
        channel: string,
        message: string,
        metadata: Record<string, any> = {},
    ): Promise<ChatMessage | null> {
        if (!channel || !message) return null;

        const messageData: ChatMessage = {
            id: this.generateMessageId(),
            // No connection to attribute it to. `system` is a reserved
            // clientId rather than an empty string so a renderer can tell
            // "the server said this" from "we lost the sender".
            clientId: 'system',
            channel,
            message,
            metadata: { ...metadata, system: true },
            timestamp: new Date().toISOString(),
        };

        this.addToChannelHistory(channel, messageData);
        this._persistMessage(messageData).catch((err: any) =>
            this.logger.error('Failed to persist system message:', err && err.message),
        );
        // No sender to exclude and none to authorize as: this is the server
        // talking to the channel.
        await this.broadcastMessage(channel, messageData);
        return messageData;
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

        // Resolve identity ONCE — feeds both the dm-membership gate and
        // the userId stamp below.
        const identity = this._resolveIdentity(clientId);

        // DM membership gate (v0.23.0) — send is checked independently of
        // join (subscriptions can predate enforcement being enabled).
        if (!this._checkDmMembership(clientId, channel, identity)) {
            return;
        }

        try {
            if (identity && identity.userId) {
                // Merge resolver-provided presentation hints into metadata
                // ONLY where the sender didn't already provide them —
                // sender-provided metadata always wins.
                if (identity.displayName !== undefined && metadata.displayName === undefined) {
                    metadata.displayName = identity.displayName;
                }
                if (identity.avatarUrl !== undefined && metadata.avatarUrl === undefined) {
                    metadata.avatarUrl = identity.avatarUrl;
                }
            }

            const messageData: ChatMessage = {
                id: this.generateMessageId(),
                clientId,
                ...(identity && identity.userId ? { userId: identity.userId } : {}),
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

            // M3 gap #9: pass the sender as the publisher identity so the
            // router can enforce ChatRoom/RealtimeChannel CRD publisher authz.
            // We intentionally do NOT set excludeClientId — the sender must
            // receive their own message (sender-echo; the swarm chat
            // verification depends on it). Decoupling authz subject from echo
            // is what makes both work at once.
            await this.broadcastMessage(channel, messageData, clientId);

            this.sendToClient(clientId, {
                type: 'chat',
                action: 'sent',
                messageId: messageData.id,
                channel,
                timestamp: messageData.timestamp,
            });

            // DM activity seam (v0.23.0) — fire-and-forget observer after a
            // successful dm send. Exceptions never fail the send path.
            if (this.onDmMessage && isDmChatChannel(channel)) {
                try {
                    this.onDmMessage({
                        channel,
                        // Hashed chat:dmg: channels are non-reversible → [].
                        members: dmChannelMembers(channel) ?? [],
                        message: messageData,
                    });
                } catch (hookErr) {
                    this.logger.error('onDmMessage hook threw (ignored):', hookErr);
                }
            }

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
        // `lru-cache` iterates MOST-RECENTLY-USED FIRST, which is the opposite
        // of reading order and cost two bugs in one line: every transcript
        // rendered newest-message-first, and `.slice(-limit)` took the OLDEST
        // messages — a 100-message channel asked for its last 20 returned its
        // first 20. The second hid until a conversation outgrew the limit, at
        // which point the missing messages looked like they were never sent.
        const allMessages = Array.from(cache.values()).reverse();
        if (allMessages.length > 0) {
            // Now that the list is chronological, the tail really is the
            // newest, and it comes back in reading order.
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

    async broadcastMessage(channel: string, messageData: ChatMessage, publisherClientId?: string): Promise<void> {
        const broadcastMessage = {
            type: 'chat',
            action: 'message',
            channel,
            message: messageData,
            timestamp: new Date().toISOString(),
        };

        const redisAvailable = this.messageRouter.redisAvailable !== false;
        // M3 gap #9: name the publisher so the router enforces CRD publisher
        // authz. excludeClientId stays null → the sender still gets the echo.
        // Older routers (sendToChannel arity < 4) ignore the extra arg
        // harmlessly; new routers run AUTHZ whenever publisherClientId is set.
        if (publisherClientId != null) {
            await this.messageRouter.sendToChannel(channel, broadcastMessage, null, { publisherClientId });
        } else {
            await this.messageRouter.sendToChannel(channel, broadcastMessage);
        }

        if (!redisAvailable) {
            this.logger.debug(`Redis unavailable, message delivered to local clients only`);
        }
    }

    /**
     * Resolve the sender identity for a connection, or null. A throwing
     * resolver is logged and treated as "no identity" — which the dm gate
     * below turns into a fail-closed rejection.
     */
    _resolveIdentity(clientId: string): ChatSenderIdentity | null {
        if (!this.identityResolver) return null;
        try {
            return this.identityResolver(clientId) ?? null;
        } catch (err) {
            this.logger.error(`identityResolver threw for client ${clientId}:`, err);
            return null;
        }
    }

    /**
     * DM membership gate. Returns true when the operation may proceed.
     * Only member-addressed dm channels (`chat:dm:` with parseable member
     * list) are enforced; hashed `chat:dmg:` and non-dm channels always
     * pass. FAIL-CLOSED: on an enforced channel, a sender with no
     * resolvable userId is rejected.
     */
    _checkDmMembership(clientId: string, channel: string, identity: ChatSenderIdentity | null): boolean {
        if (!this.enforceDmMembership) return true;
        if (!isDmChatChannel(channel)) return true;

        const members = dmChannelMembers(channel);
        if (!members) return true; // chat:dmg: / malformed — membership not derivable here

        const userId = identity?.userId;
        if (!userId || !members.includes(userId)) {
            this.sendError(
                clientId,
                'You are not a member of this direct-message channel',
                ErrorCodes.CHAT_DM_FORBIDDEN
            );
            return false;
        }
        return true;
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
