"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatService = void 0;
const lru_cache_1 = require("lru-cache");
const distributed_core_1 = require("distributed-core");
const SubscriptionTracker_1 = require("./SubscriptionTracker");
const ChatStore_1 = require("./ChatStore");
const dmChannels_1 = require("./dmChannels");
const ChatMembershipStore_1 = require("./ChatMembershipStore");
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
    /** The channel has members and the sender is not one of them (or was removed). */
    CHAT_NOT_A_MEMBER: 'not-a-member',
    /** A member may not do this — removing someone else without being an owner, say. */
    CHAT_FORBIDDEN: 'forbidden',
    /** The membership request itself was malformed. */
    CHAT_BAD_REQUEST: 'bad-request',
};
function createErrorResponse(code, message, context = {}) {
    return { error: { code, message, ...context } };
}
// ---- Helpers --------------------------------------------------------------
function validateMetadata(metadata, logger, maxKeys, maxSize) {
    if (!metadata || typeof metadata !== 'object')
        return {};
    // Limit number of keys
    const keys = Object.keys(metadata);
    if (keys.length > maxKeys) {
        logger.warn(`Metadata exceeds key limit: ${keys.length}/${maxKeys}`);
        const truncated = {};
        for (let i = 0; i < maxKeys; i++) {
            truncated[keys[i]] = metadata[keys[i]];
        }
        metadata = truncated;
    }
    // Limit total serialized size.
    const serialized = JSON.stringify(metadata);
    if (serialized.length <= maxSize)
        return metadata;
    // Over budget. Shed the LARGEST keys until what remains fits, rather than
    // discarding the envelope.
    //
    // This used to return `{ _truncated: true, displayName }` — everything
    // else went in the bin. Attachments ride in `metadata.attachments`, and
    // each image attachment carries a base64 `preview` measured at
    // 1124-1376 characters, so three screenshots clear the 4096 default on
    // their own. The sender's text posted, their files ceased to exist, and
    // the @mentions and the reply they were answering went with them. The
    // send reported success, so nothing anywhere said a word.
    //
    // Size order is what makes this worth doing: the keys that blow the
    // budget are big, and the ones that carry the envelope — mentions,
    // replyTo, displayName — are tiny. Dropping the biggest first almost
    // always costs exactly the attachment payload and keeps the rest.
    //
    // `_droppedKeys` is the other half. A client that knows attachments were
    // dropped can say so; a client handed a bare `_truncated` can only
    // pretend the message was always plain text.
    const bySize = Object.keys(metadata)
        .map((key) => ({ key, size: JSON.stringify(metadata[key] ?? null).length }))
        .sort((a, b) => b.size - a.size);
    const kept = { ...metadata };
    const droppedKeys = [];
    for (const { key } of bySize) {
        // Identity survives: it is what names the sender in the transcript,
        // and it is never the reason the budget blew.
        if (key === 'displayName')
            continue;
        delete kept[key];
        droppedKeys.push(key);
        const candidate = { ...kept, _truncated: true, _droppedKeys: droppedKeys };
        if (JSON.stringify(candidate).length <= maxSize) {
            logger.warn(`Metadata exceeds size limit: ${serialized.length}/${maxSize} — dropped ${droppedKeys.join(', ')}`);
            return candidate;
        }
    }
    // Irreducible: a single oversized displayName. Cap it rather than return
    // something that still does not fit.
    logger.warn(`Metadata exceeds size limit: ${serialized.length}/${maxSize} — irreducible`);
    return {
        _truncated: true,
        _droppedKeys: droppedKeys,
        displayName: String(metadata.displayName || 'unknown').slice(0, 128),
    };
}
// ---- ChatService ----------------------------------------------------------
class ChatService {
    messageRouter;
    logger;
    metricsCollector;
    chatStore;
    authz;
    identityResolver;
    membershipStore;
    enforceDmMembership;
    onDmMessage;
    clientChannels;
    channelCaches;
    maxMessagesPerChannel;
    maxMessageLength;
    maxChannelNameLength;
    maxMetadataKeys;
    maxMetadataSize;
    defaultHistoryLimit;
    joinHistoryLimit;
    cacheCleanupIntervalMs;
    isDistributed;
    _cleanupSweep;
    constructor(opts) {
        if (!opts || !opts.messageRouter) {
            throw new Error('ChatService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('ChatService: logger is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;
        this.chatStore = opts.chatStore ?? new ChatStore_1.InMemoryChatStore();
        this.membershipStore = opts.membershipStore ?? null;
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
        this.clientChannels = new SubscriptionTracker_1.SubscriptionTracker();
        this.channelCaches = new Map();
        // Configuration — distributed iff the router exposes the
        // subscribe/unsubscribe helpers (gateway always does).
        this.isDistributed = typeof this.messageRouter.subscribeToChannel === 'function';
        this._cleanupSweep = new distributed_core_1.PeriodicSweep({
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
    async handleAction(clientId, action, data) {
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
                case 'typing':
                    await this.handleTyping(clientId, data);
                    return;
                case 'members':
                    await this.handleMembers(clientId, data);
                    return;
                case 'addMembers':
                    await this.handleAddMembers(clientId, data);
                    return;
                case 'removeMember':
                    await this.handleRemoveMember(clientId, data);
                    return;
                default:
                    this.sendError(clientId, `Unknown chat action: ${action}`);
            }
        }
        catch (error) {
            this.logger.error(`Error handling chat action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
        finally {
            const duration = Date.now() - startTime;
            this.logger.info(`[chat] ${action}`, { clientId, channel: data?.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: chat/${action} took ${duration}ms`, { clientId });
            }
        }
    }
    async handleJoinChannel(clientId, { channel, metadata: _metadata = {} }) {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }
        if (typeof channel !== 'string' || channel.length === 0 || channel.length > this.maxChannelNameLength) {
            this.sendError(clientId, `Channel name must be a string between 1 and ${this.maxChannelNameLength} characters`);
            return;
        }
        try {
            if (!this.authz(clientId, channel, this)) {
                return;
            }
            // DM membership gate (v0.23.0) — fail-closed on member-addressed
            // dm channels. Runs before the router subscribe so a forbidden
            // client never acquires a distributed subscription.
            const joinIdentity = this._resolveIdentity(clientId);
            if (!this._checkDmMembership(clientId, channel, joinIdentity)) {
                return;
            }
            // Channel membership gate: a closed channel admits only its
            // active members. Runs before the router subscribe, like the dm
            // gate, so a refused client never holds a subscription.
            if (!(await this._checkMembership(clientId, channel, joinIdentity))) {
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
            await this.sendChannelHistory(clientId, channel, joinIdentity?.userId);
            this.logger.info(`Client ${clientId} joined chat channel: ${channel}`);
        }
        catch (error) {
            this.logger.error(`Error joining channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to join channel');
        }
    }
    async handleLeaveChannel(clientId, { channel }) {
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
        }
        catch (error) {
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
    async postSystemMessage(channel, message, metadata = {}) {
        if (!channel || !message)
            return null;
        const messageData = {
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
        this._persistMessage(messageData).catch((err) => this.logger.error('Failed to persist system message:', err && err.message));
        // No sender to exclude and none to authorize as: this is the server
        // talking to the channel.
        await this.broadcastMessage(channel, messageData);
        return messageData;
    }
    async handleSendMessage(clientId, { channel, message, metadata = {} }) {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }
        // A message with no text but an attachment is a message.
        //
        // Sending a photo with no caption is the ordinary case in every chat
        // product, and the old length check rejected it: the file uploaded,
        // the composer cleared, an error the sender's UI does not render was
        // returned, and nothing appeared in the channel. The file was stored
        // and unreachable, which is worse than a refusal the user can see.
        const hasAttachments = !!metadata &&
            Array.isArray(metadata.attachments) &&
            metadata.attachments.length > 0;
        if (typeof message !== 'string') {
            this.sendError(clientId, 'Message must be a string');
            return;
        }
        if (message.length === 0 && !hasAttachments) {
            this.sendError(clientId, 'A message needs text or an attachment');
            return;
        }
        if (message.length > this.maxMessageLength) {
            this.sendError(clientId, `Message must be a string between 1 and ${this.maxMessageLength} characters`);
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
        if (!(await this._checkMembership(clientId, channel, identity))) {
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
            const messageData = {
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
            this._persistMessage(messageData).catch((err) => this.logger.error('Failed to persist chat message:', err && err.message));
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
            if (this.onDmMessage && (0, dmChannels_1.isDmChatChannel)(channel)) {
                try {
                    this.onDmMessage({
                        channel,
                        // Hashed chat:dmg: channels are non-reversible → [].
                        members: (0, dmChannels_1.dmChannelMembers)(channel) ?? [],
                        message: messageData,
                    });
                }
                catch (hookErr) {
                    this.logger.error('onDmMessage hook threw (ignored):', hookErr);
                }
            }
            this.logger.info(`Message sent by client ${clientId} to channel ${channel}`);
        }
        catch (error) {
            this.logger.error(`Error sending message to channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to send message');
        }
    }
    async handleGetHistory(clientId, { channel, limit }) {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }
        const identity = this._resolveIdentity(clientId);
        if (!this._checkDmMembership(clientId, channel, identity)) {
            return;
        }
        if (!(await this._checkMembership(clientId, channel, identity))) {
            return;
        }
        try {
            const history = await this.getChannelHistoryFor(identity?.userId, channel, limit ?? this.defaultHistoryLimit);
            this.sendToClient(clientId, {
                type: 'chat',
                action: 'history',
                channel,
                messages: history,
                timestamp: new Date().toISOString(),
            });
            this.logger.debug(`Sent message history for channel ${channel} to client ${clientId}`);
        }
        catch (error) {
            this.logger.error(`Error getting history for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to get message history');
        }
    }
    getChannelCache(channelId) {
        if (!this.channelCaches.has(channelId)) {
            const cache = new lru_cache_1.LRUCache({
                max: this.maxMessagesPerChannel,
                updateAgeOnGet: false,
                updateAgeOnHas: false,
            });
            this.channelCaches.set(channelId, cache);
        }
        return this.channelCaches.get(channelId);
    }
    addToChannelHistory(channel, messageData) {
        const cache = this.getChannelCache(channel);
        cache.set(messageData.id, messageData);
    }
    async getChannelHistory(channel, limit) {
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
    async sendChannelHistory(clientId, channel, userId) {
        const history = await this.getChannelHistoryFor(userId, channel, this.joinHistoryLimit);
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
    // ---- Membership ------------------------------------------------------
    /** Every row for the channel; [] when there is no store or the channel is open. */
    async _membershipRows(channel) {
        if (!this.membershipStore)
            return [];
        try {
            return await this.membershipStore.listMembers(channel);
        }
        catch (err) {
            this.logger.error('ChatMembershipStore list failed:', err && err.message);
            // Fail closed on a closed channel we cannot read? We cannot tell
            // whether it is closed. Treat as open so an outage does not lock
            // every conversation, and log it loudly.
            return [];
        }
    }
    /**
     * The channel's members as the wire reports them. A dm channel's members
     * are in its name; a channel with no rows is open (everyone may read).
     */
    async describeMembers(channel) {
        if ((0, dmChannels_1.isDmChatChannel)(channel)) {
            const ids = (0, dmChannels_1.dmChannelMembers)(channel);
            if (ids) {
                return {
                    open: false,
                    members: ids.map((userId) => ({ userId, role: 'member', addedBy: userId, addedAt: '', historyFrom: null })),
                };
            }
            // Hashed group dm: members are not derivable from the name.
            return { open: true, members: [] };
        }
        const rows = await this._membershipRows(channel);
        if (rows.length === 0)
            return { open: true, members: [] };
        return { open: false, members: rows.filter((r) => r.removedAt == null).map(ChatMembershipStore_1.memberView) };
    }
    /**
     * Channel membership gate. True when the channel is open (no rows), is a
     * dm channel (the dm gate owns those), or the sender is an active member.
     * FAIL-CLOSED on a closed channel: no resolvable userId ⇒ refused.
     */
    async _checkMembership(clientId, channel, identity) {
        if (!this.membershipStore || (0, dmChannels_1.isDmChatChannel)(channel))
            return true;
        const rows = await this._membershipRows(channel);
        if (rows.length === 0)
            return true;
        const userId = identity?.userId;
        const row = userId ? rows.find((r) => r.userId === userId) : undefined;
        if (!row || row.removedAt != null) {
            this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
            return false;
        }
        return true;
    }
    /**
     * History for a PERSON: what the channel holds, from their `historyFrom`
     * on. A closed channel shows a non-member nothing; an open channel and a
     * dm channel show everything (the dm gate has already run).
     */
    async getChannelHistoryFor(userId, channel, limit) {
        const history = await this.getChannelHistory(channel, limit);
        if (!this.membershipStore || (0, dmChannels_1.isDmChatChannel)(channel))
            return history;
        const rows = await this._membershipRows(channel);
        if (rows.length === 0)
            return history;
        const row = userId ? rows.find((r) => r.userId === userId) : undefined;
        if (!row || row.removedAt != null)
            return [];
        if (!row.historyFrom)
            return history;
        const floor = Date.parse(row.historyFrom);
        if (!Number.isFinite(floor))
            return history;
        return history.filter((m) => {
            const t = Date.parse(m.timestamp);
            return Number.isFinite(t) && t >= floor;
        });
    }
    /** `{action:'members', channel}` → who is in it, to the sender. */
    async handleMembers(clientId, { channel }) {
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const { open, members } = await this.describeMembers(channel);
        this.sendToClient(clientId, {
            type: 'chat',
            action: 'members',
            channel,
            open,
            members,
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * `{action:'addMembers', channel, userIds, history:{mode,days?}, names?}`.
     * The requester must be a member, or the channel open — in which case
     * they become its owner and the channel closes. Each added person gets a
     * history floor from the choice; re-adding a removed person restores
     * them with the new floor. The thread is told, and every subscriber gets
     * the new roster.
     */
    async handleAddMembers(clientId, { channel, userIds, history, names }) {
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (!this.membershipStore) {
            this.sendError(clientId, 'Membership is not enabled on this gateway', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if ((0, dmChannels_1.isDmChatChannel)(channel)) {
            this.sendError(clientId, 'A direct message has fixed members; start a group chat instead', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const ids = Array.isArray(userIds)
            ? Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0 && u.length <= 200)))
            : [];
        if (ids.length === 0 || ids.length > 50) {
            this.sendError(clientId, 'userIds must name between 1 and 50 people', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const choice = (0, ChatMembershipStore_1.parseHistoryChoice)(history);
        if (!choice) {
            this.sendError(clientId, 'history must be {mode:"none"|"days"|"all", days?}', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId);
        const actorId = identity?.userId;
        if (!actorId) {
            this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
            return;
        }
        const rows = await this._membershipRows(channel);
        const now = new Date().toISOString();
        const nameOf = (id) => {
            const given = names && typeof names === 'object' ? names[id] : undefined;
            return typeof given === 'string' && given ? given.slice(0, 120) : id;
        };
        try {
            if (rows.length === 0) {
                // First rows close the channel; the requester owns it.
                await this.membershipStore.putMember({ channel, userId: actorId, role: 'owner', addedBy: actorId, addedAt: now, historyFrom: null, removedAt: null });
            }
            else {
                const me = rows.find((r) => r.userId === actorId);
                if (!me || me.removedAt != null) {
                    this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
                    return;
                }
            }
            const floor = (0, ChatMembershipStore_1.historyFloorFor)(choice);
            const added = [];
            for (const userId of ids) {
                if (userId === actorId)
                    continue;
                const existing = rows.find((r) => r.userId === userId);
                if (existing && existing.removedAt == null)
                    continue; // already in
                await this.membershipStore.putMember({
                    channel,
                    userId,
                    role: existing?.role === 'owner' ? 'owner' : 'member',
                    addedBy: actorId,
                    addedAt: now,
                    historyFrom: floor,
                    removedAt: null,
                });
                added.push(userId);
            }
            if (added.length > 0) {
                const actorName = identity?.displayName ?? actorId;
                const list = added.map(nameOf);
                const text = `${actorName} added ${list.length <= 3 ? list.join(', ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} others`}`;
                await this._postMembershipMessage(channel, clientId, identity, text, {
                    kind: 'membership',
                    event: 'added',
                    actorId,
                    actorName,
                    userIds: added,
                    names: Object.fromEntries(added.map((id) => [id, nameOf(id)])),
                    history: choice,
                });
            }
            await this._broadcastMembers(channel, clientId);
        }
        catch (err) {
            this.logger.error(`addMembers failed on ${channel}:`, err && err.message);
            this.sendError(clientId, 'Failed to add members', ErrorCodes.SERVICE_INTERNAL_ERROR, channel);
        }
    }
    /** `{action:'removeMember', channel, userId}` — an owner may remove anyone; anyone may remove themselves. */
    async handleRemoveMember(clientId, { channel, userId, name }) {
        if (!channel || typeof channel !== 'string' || typeof userId !== 'string' || !userId) {
            this.sendError(clientId, 'channel and userId are required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (!this.membershipStore || (0, dmChannels_1.isDmChatChannel)(channel)) {
            this.sendError(clientId, 'This channel has fixed members', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId);
        const actorId = identity?.userId;
        if (!actorId) {
            this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
            return;
        }
        const rows = await this._membershipRows(channel);
        const me = rows.find((r) => r.userId === actorId);
        if (rows.length === 0 || !me || me.removedAt != null) {
            this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
            return;
        }
        if (userId !== actorId && me.role !== 'owner') {
            this.sendError(clientId, 'Only an owner can remove someone else', ErrorCodes.CHAT_FORBIDDEN, channel);
            return;
        }
        const target = rows.find((r) => r.userId === userId);
        if (!target || target.removedAt != null) {
            this.sendError(clientId, 'That person is not in this channel', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        try {
            await this.membershipStore.putMember({ ...target, removedAt: new Date().toISOString() });
            const actorName = identity?.displayName ?? actorId;
            const targetName = typeof name === 'string' && name ? name.slice(0, 120) : userId;
            const text = userId === actorId ? `${actorName} left` : `${actorName} removed ${targetName}`;
            await this._postMembershipMessage(channel, clientId, identity, text, {
                kind: 'membership',
                event: 'removed',
                actorId,
                actorName,
                userIds: [userId],
                names: { [userId]: targetName },
            });
            await this._broadcastMembers(channel, clientId);
        }
        catch (err) {
            this.logger.error(`removeMember failed on ${channel}:`, err && err.message);
            this.sendError(clientId, 'Failed to remove member', ErrorCodes.SERVICE_INTERNAL_ERROR, channel);
        }
    }
    /**
     * A membership change, as a stored message from the person who made it.
     * Not gated on a join: the owner adding people from a picker may not be
     * subscribed to the channel at that moment.
     */
    async _postMembershipMessage(channel, clientId, identity, text, metadata) {
        const messageData = {
            id: this.generateMessageId(),
            clientId,
            ...(identity?.userId ? { userId: identity.userId } : {}),
            channel,
            message: text,
            metadata: {
                ...metadata,
                ...(identity?.displayName !== undefined ? { displayName: identity.displayName } : {}),
                ...(identity?.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
            },
            timestamp: new Date().toISOString(),
        };
        this.addToChannelHistory(channel, messageData);
        this._persistMessage(messageData).catch((err) => this.logger.error('Failed to persist membership message:', err && err.message));
        await this.broadcastMessage(channel, messageData);
        return messageData;
    }
    /** The roster, to everyone in the channel and to the requester whether or not they are subscribed. */
    async _broadcastMembers(channel, requesterClientId) {
        const { open, members } = await this.describeMembers(channel);
        const frame = { type: 'chat', action: 'membersUpdated', channel, open, members, timestamp: new Date().toISOString() };
        this.sendToClient(requesterClientId, frame);
        await this.messageRouter.sendToChannel(channel, frame, requesterClientId);
    }
    async _persistMessage(messageData) {
        await this.chatStore.putMessage(messageData);
    }
    async _loadHistoryFromStore(channel, limit) {
        try {
            return await this.chatStore.listMessages(channel, limit);
        }
        catch (err) {
            this.logger.error('ChatStore history load failed:', err && err.message);
            return [];
        }
    }
    /**
     * "Someone is typing" — relayed to the channel, never stored. Excluded
     * from the sender (their own composer knows), carried with the identity
     * the resolver gives the connection so the others can name them. A
     * connection that has not joined the channel is not in it, and may not
     * announce itself there.
     */
    async handleTyping(clientId, { channel, typing }) {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }
        if (!this.clientChannels.hasSubscription(clientId, channel)) {
            this.sendError(clientId, 'You must join the channel before typing in it');
            return;
        }
        const identity = this._resolveIdentity(clientId);
        const frame = {
            type: 'chat',
            action: 'typing',
            channel,
            clientId,
            userId: identity?.userId,
            displayName: identity?.displayName,
            typing: typing === true,
            timestamp: new Date().toISOString(),
        };
        await this.messageRouter.sendToChannel(channel, frame, clientId);
    }
    async broadcastMessage(channel, messageData, publisherClientId) {
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
        }
        else {
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
    _resolveIdentity(clientId) {
        if (!this.identityResolver)
            return null;
        try {
            return this.identityResolver(clientId) ?? null;
        }
        catch (err) {
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
    _checkDmMembership(clientId, channel, identity) {
        if (!this.enforceDmMembership)
            return true;
        if (!(0, dmChannels_1.isDmChatChannel)(channel))
            return true;
        const members = (0, dmChannels_1.dmChannelMembers)(channel);
        if (!members)
            return true; // chat:dmg: / malformed — membership not derivable here
        const userId = identity?.userId;
        if (!userId || !members.includes(userId)) {
            this.sendError(clientId, 'You are not a member of this direct-message channel', ErrorCodes.CHAT_DM_FORBIDDEN);
            return false;
        }
        return true;
    }
    generateMessageId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
    sendToClient(clientId, message) {
        if (!this.messageRouter)
            throw new Error('ChatService: messageRouter is required');
        this.messageRouter.sendToClient(clientId, message);
    }
    sendError(clientId, message, errorCode = ErrorCodes.SERVICE_INTERNAL_ERROR, channel) {
        const errorResponse = createErrorResponse(errorCode, message, {
            service: 'chat',
            clientId,
            ...(channel ? { channel } : {}),
        });
        this.sendToClient(clientId, {
            type: 'error',
            service: 'chat',
            ...(channel ? { channel } : {}),
            ...errorResponse,
        });
        if (this.metricsCollector && typeof this.metricsCollector.recordError === 'function') {
            this.metricsCollector.recordError(errorCode);
        }
    }
    // Client lifecycle methods
    async onClientConnect(clientId) {
        this.logger.debug(`Client ${clientId} connected to chat service`);
    }
    async onClientDisconnect(clientId) {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channel of channels) {
            if (this.isDistributed && this.messageRouter.unsubscribeFromChannel) {
                try {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channel);
                }
                catch (error) {
                    this.logger.error(`Error unsubscribing client ${clientId} from channel ${channel}:`, error);
                }
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from chat service`);
    }
    // Service lifecycle methods
    async shutdown() {
        await this._cleanupSweep.stop();
        this.clientChannels.clear();
        this.channelCaches.clear();
        this.logger.info('Chat service shut down');
    }
    // Utility methods for debugging/monitoring
    getStats() {
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
exports.ChatService = ChatService;
exports.default = ChatService;
//# sourceMappingURL=ChatService.js.map