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
//
// WIRE SURFACE (inbound action → outbound frames):
//   join | leave | send | history | typing | members | addMembers |
//   removeMember | edit | delete | read | receipts
// Read receipts are the last two; see the "Read receipts" section below for
// the model (a per-member cursor, not a row per message) and the rules on
// which channels keep them.

import { LRUCache } from 'lru-cache';
import { PeriodicSweep } from 'distributed-core';

import { SubscriptionTracker } from './SubscriptionTracker';
import { InMemoryChatStore, type ChatStore } from './ChatStore';
import {
    MemoryChatReadReceiptStore,
    type ChatReadReceipt,
    type ChatReadReceiptStore,
} from './ChatReadReceiptStore';
import { isDmChatChannel, dmChannelMembers } from './dmChannels';
import {
    historyFloorFor,
    memberView,
    parseHistoryChoice,
    type ChatHistoryChoice,
    type ChatMember,
    type ChatMemberView,
    type ChatMembershipStore,
} from './ChatMembershipStore';
import type { ChatMessage } from './types';
import { resolveAuthSender, stampSender, type ResolveSender } from '../server-ws/senderIdentity';
import { routerPermits, type ChannelAccessKind, type ChannelAccessRouter } from '../server-ws/channelAccess';
import { createAuthorityScope, type AuthorityScope } from '../server-ws/authorityScope';

// ---- Inlined config (gateway/config/constants.ts replacements) ------------

const DEFAULT_MAX_METADATA_KEYS = 20;
const DEFAULT_MAX_METADATA_SIZE = 4096;
const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 100;
const DEFAULT_CACHE_CLEANUP_INTERVAL_MS = 300_000;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_JOIN_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 50;
/**
 * Above this many people in a channel, read receipts are off.
 *
 * Teams draws the same line: receipts in chats, nothing in a channel with a
 * department in it. Two reasons, and the second is the one that matters.
 * The cheap one is volume — every person reading is a write and a broadcast,
 * so a 500-person channel turns one message into 500 fan-outs of no interest
 * to anyone. The real one is that a receipt tells people when you looked. In
 * a chat with three colleagues that is a courtesy; in a channel of two
 * hundred it is a log of your attention published to two hundred people who
 * did not ask for it and whom you cannot see. 20 is Teams' number and a
 * defensible one: it is about where a chat stops being a conversation.
 */
const DEFAULT_RECEIPTS_MAX_MEMBERS = 20;

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
    /** Edit/delete: no such message on that channel. */
    CHAT_NOT_FOUND: 'not-found',
    /** Edit: the message was already deleted. */
    CHAT_GONE: 'gone',
    /**
     * Send: the message was validated and authorized but the store write
     * failed, so it was never acked `sent` and never broadcast. The client
     * should treat it like any other failed send (offer retry), not like a
     * delivered message that silently vanished.
     */
    CHAT_STORE_FAILED: 'store-failed',
} as const;

function createErrorResponse(
    code: string,
    message: string,
    context: Record<string, any> = {}
): { error: Record<string, any> } {
    return { error: { code, message, ...context } };
}

/**
 * What each chat action asks of the router's channel authz. Reads that hand
 * channel state back are `subscribe`; anything that stores or fans out is
 * `publish`. `join` (asked through subscribeToChannel) and `leave` are absent.
 */
const CHAT_ACTION_ACCESS: Record<string, ChannelAccessKind> = {
    history: 'subscribe',
    members: 'subscribe',
    receipts: 'subscribe',
    send: 'publish',
    edit: 'publish',
    delete: 'publish',
    typing: 'publish',
    read: 'publish',
    addMembers: 'publish',
    removeMember: 'publish',
};

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
        /** The send's authority scope, shared with the fan-out's checks. */
        scope?: AuthorityScope;
    }): Promise<void> | void;
    /**
     * Subscribe a client to a channel. Returns `false` when operator-pushed
     * channel config denies the subscribe (the router has already emitted
     * AUTHZ_CHANNEL_DENIED). `void`/`true` ⇒ subscribed. handleJoinChannel
     * (M3 gap #10) honours a `false` return: no joined ack, no local sub.
     */
    subscribeToChannel?(
        clientId: string,
        channel: string,
        opts?: import('../server-ws/channelAccess').ChannelAccessOpts,
    ): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    /** The router's channel authz, asked before every channel read or write. Optional. */
    checkChannel?: ChannelAccessRouter['checkChannel'];
    getClientData?(clientId: string): any;
    /** Optional flag — when explicitly `false`, broadcast warns about Redis. */
    redisAvailable?: boolean;
}

/**
 * What `onDmMessage` / `onChannelMessage` receive. `scope` is the send's
 * authority scope: pass it to `router.isClientSubscribed(…, { scope })` (an
 * unread probe) so those checks share the send's per-channel proof. It stays
 * open until a returned promise settles, then closes; after that it is a
 * pass-through (fresh checks). Absent when the send had no scope.
 */
export interface ChatMessageHookInfo {
    channel: string;
    members: string[];
    message: ChatMessage;
    scope?: AuthorityScope;
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
     * Who is in each channel and from when they may read it. Absent, every
     * channel is open (the pre-membership behaviour). See ChatMembershipStore.
     */
    membershipStore?: ChatMembershipStore;
    /**
     * Where read cursors live. Three states on purpose:
     *
     *   - absent  → `MemoryChatReadReceiptStore`, same zero-config default
     *     `chatStore` takes. Receipts work out of the box and die with the
     *     process. On a multi-node gateway that means the LIVE receipt still
     *     fans out (it goes through the router like any broadcast) but the
     *     replay a client gets when it asks is only this node's — wire a
     *     shared adapter in production.
     *   - a store → durable receipts.
     *   - `null`  → the feature is off: `read` is ignored and `receipts`
     *     answers `{enabled:false, reason:'disabled'}`.
     *
     * Note that a store alone does not switch receipts on for a channel —
     * see `receiptsMaxMembers` and `_receiptsAudience`. Receipts are only
     * kept where the audience is nameable and small.
     */
    readReceiptStore?: ChatReadReceiptStore | null;
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
     * `message.userId`, and `displayName` / `avatarUrl` are written into
     * `message.metadata` in place of the frame's copies (see
     * `trustFrameSender`). The router's auth context
     * (`getClientData(clientId).userContext`) fills whatever this leaves
     * out. Neither ⇒ no userId stamped and the frame's metadata kept.
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
     * Map the connection's auth context (the gateway `auth` result, read
     * through `messageRouter.getClientData(clientId).userContext`) to the
     * sender. Default: `{ userId, displayName ?? name, avatarUrl ?? picture }`
     * straight off the context. Runs only for a connection whose context has
     * a `userId`; return null to treat it as unidentified.
     */
    resolveSender?: ResolveSender;

    /**
     * Let the frame name the sender. Default false: once a connection is
     * identified (auth context with a userId, or an `identityResolver`
     * userId), the frame's `metadata.userId` / `displayName` / `avatarUrl`
     * are dropped and the server's identity stamped instead, on send and on
     * edit. True restores the pre-0.98.5 rule (frame metadata wins, the
     * server fills gaps). `message.userId` is always the server's.
     */
    trustFrameSender?: boolean;

    /**
     * Fire-and-forget observer invoked AFTER a successful send on a dm
     * chat channel (both `chat:dm:` and `chat:dmg:` forms). Exceptions
     * are swallowed (logged) — it can never fail or block the send path.
     * `members` is parsed from the channel name; for hashed `chat:dmg:`
     * channels it is `[]` (membership is non-reversible — consumers keep
     * their own index). The gateway uses this seam to maintain a
     * conversations index and fire notifications.
     */
    onDmMessage?: (info: ChatMessageHookInfo) => void | Promise<void>;
    /**
     * Fires after every stored message on a NON-dm channel, with who should
     * hear about it: a closed channel's current members, an open channel's
     * currently subscribed users — the sender excluded either way. The host
     * turns it into unread counts / notifications; dm channels stay on
     * `onDmMessage`. Exceptions never fail the send.
     */
    onChannelMessage?: (info: ChatMessageHookInfo) => void | Promise<void>;
    /**
     * A stored message changed after the fact — edited or deleted by its
     * author. The host keeps its previews (the conversations index) honest
     * with it; nothing here notifies, an edit is not new traffic.
     */
    onMessageChanged?: (info: { channel: string; kind: 'edited' | 'deleted'; message: ChatMessage }) => void;
    /**
     * Somebody's read cursor moved forward. Fires after the store write and
     * the broadcast, fire-and-forget like the others — an exception is logged
     * and never fails the read. This is the seam a host uses to keep its own
     * unread state honest (a conversations index, a badge count); the service
     * itself keeps no unread counts.
     */
    onReadReceipt?: (info: { channel: string; receipt: ChatReadReceipt }) => void;
    /**
     * Fires when an identified user joins a NON-dm channel. The host records
     * it (a "who has ever been here" index) so an OPEN channel — one with no
     * membership rows — still has an audience for `onChannelMessage` when
     * those people are not subscribed at the moment a message lands.
     */
    onChannelJoin?: (info: { channel: string; userId: string }) => void;
    /**
     * The audience of an OPEN channel beyond whoever is subscribed right
     * now: the host's answer from its join index. Union-ed with the current
     * subscribers, sender excluded. Closed channels never ask — their
     * members are the audience. Errors and a missing hook mean "no extra".
     */
    channelAudience?: (channel: string) => Promise<string[]> | string[];

    // ---- Tunables (all default to gateway/config/constants.ts values) ----
    maxMessagesPerChannel?: number;
    maxMessageLength?: number;
    maxChannelNameLength?: number;
    maxMetadataKeys?: number;
    maxMetadataSize?: number;
    defaultHistoryLimit?: number;
    joinHistoryLimit?: number;
    cacheCleanupIntervalMs?: number;
    /** Largest channel that keeps read receipts. See DEFAULT_RECEIPTS_MAX_MEMBERS. */
    receiptsMaxMembers?: number;
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

    // Limit total serialized size.
    const serialized = JSON.stringify(metadata);
    if (serialized.length <= maxSize) return metadata;

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

    const kept: Record<string, unknown> = { ...metadata };
    const droppedKeys: string[] = [];
    for (const { key } of bySize) {
        // Identity survives: it is what names the sender in the transcript,
        // and it is never the reason the budget blew.
        if (key === 'displayName') continue;
        delete kept[key];
        droppedKeys.push(key);
        const candidate = { ...kept, _truncated: true, _droppedKeys: droppedKeys };
        if (JSON.stringify(candidate).length <= maxSize) {
            logger.warn(
                `Metadata exceeds size limit: ${serialized.length}/${maxSize} — dropped ${droppedKeys.join(', ')}`
            );
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

export class ChatService {
    messageRouter: ChatMessageRouter;
    logger: ChatLogger;
    metricsCollector: any;
    chatStore: ChatStore;
    authz: (clientId: string, channel: string, service: ChatService) => boolean;
    identityResolver: ChatIdentityResolver | null;
    resolveSender: ResolveSender | null;
    readonly trustFrameSender: boolean;
    membershipStore: ChatMembershipStore | null;
    readReceiptStore: ChatReadReceiptStore | null;
    readonly enforceDmMembership: boolean;
    onDmMessage: ((info: ChatMessageHookInfo) => void | Promise<void>) | null;
    onChannelMessage: ((info: ChatMessageHookInfo) => void | Promise<void>) | null;
    onMessageChanged: ((info: { channel: string; kind: 'edited' | 'deleted'; message: ChatMessage }) => void) | null;
    onReadReceipt: ((info: { channel: string; receipt: ChatReadReceipt }) => void) | null;
    onChannelJoin: ((info: { channel: string; userId: string }) => void) | null;
    channelAudience: ((channel: string) => Promise<string[]> | string[]) | null;

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
    readonly receiptsMaxMembers: number;

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
        this.membershipStore = opts.membershipStore ?? null;
        // `undefined` ⇒ zero-config in-memory (as chatStore does); an
        // explicit `null` ⇒ receipts off.
        this.readReceiptStore = opts.readReceiptStore === undefined
            ? new MemoryChatReadReceiptStore()
            : opts.readReceiptStore;
        this.authz = opts.authz ?? (() => true);
        this.identityResolver = opts.identityResolver ?? null;
        this.resolveSender = opts.resolveSender ?? null;
        this.trustFrameSender = opts.trustFrameSender === true;
        // DM enforcement defaults ON exactly when an identity source exists;
        // consumers can force it either way explicitly.
        this.enforceDmMembership = opts.enforceDmMembership ?? this.identityResolver != null;
        this.onDmMessage = opts.onDmMessage ?? null;
        this.onChannelMessage = opts.onChannelMessage ?? null;
        this.onMessageChanged = opts.onMessageChanged ?? null;
        this.onReadReceipt = opts.onReadReceipt ?? null;
        this.onChannelJoin = opts.onChannelJoin ?? null;
        this.channelAudience = opts.channelAudience ?? null;

        this.maxMessagesPerChannel = opts.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;
        this.maxMessageLength = opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
        this.maxChannelNameLength = opts.maxChannelNameLength ?? DEFAULT_MAX_CHANNEL_NAME_LENGTH;
        this.maxMetadataKeys = opts.maxMetadataKeys ?? DEFAULT_MAX_METADATA_KEYS;
        this.maxMetadataSize = opts.maxMetadataSize ?? DEFAULT_MAX_METADATA_SIZE;
        this.defaultHistoryLimit = opts.defaultHistoryLimit ?? DEFAULT_HISTORY_LIMIT;
        this.joinHistoryLimit = opts.joinHistoryLimit ?? DEFAULT_JOIN_HISTORY_LIMIT;
        this.cacheCleanupIntervalMs = opts.cacheCleanupIntervalMs ?? DEFAULT_CACHE_CLEANUP_INTERVAL_MS;
        this.receiptsMaxMembers = opts.receiptsMaxMembers ?? DEFAULT_RECEIPTS_MAX_MEMBERS;

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
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
        // One authority scope per inbound action: the router pre-check, the
        // membership gate, the post-persist publish rechecks, the fan-out and
        // the unread probes of one send all name the same operation.
        const scope = createAuthorityScope(`chat.${action}`);
        try {
            // The router's channel authz, for every action that reads or
            // writes a named channel. `join` asks through subscribeToChannel;
            // `leave` needs no permission. A refusal has told the client.
            const kind = Object.prototype.hasOwnProperty.call(CHAT_ACTION_ACCESS, action) ? CHAT_ACTION_ACCESS[action] : undefined;
            const channel = data?.channel;
            if (kind && typeof channel === 'string' && channel.length > 0
                && !(await routerPermits(this.messageRouter, kind, clientId, channel, { service: 'chat', clientChannel: channel, scope }))) {
                return;
            }
            if (this.messageRouter.getClientData && this.messageRouter.getClientData(clientId)?.userContext !== context) return;
            switch (action) {
                case 'join':
                    await this.handleJoinChannel(clientId, data, scope);
                    return;
                case 'leave':
                    await this.handleLeaveChannel(clientId, data);
                    return;
                case 'send':
                    await this.handleSendMessage(clientId, data, scope);
                    return;
                case 'history':
                    await this.handleGetHistory(clientId, data);
                    return;
                case 'typing':
                    await this.handleTyping(clientId, data, scope);
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
                case 'edit':
                    await this.handleEditMessage(clientId, data);
                    return;
                case 'delete':
                    await this.handleDeleteMessage(clientId, data);
                    return;
                case 'read':
                    await this.handleReadReceipt(clientId, data);
                    return;
                case 'receipts':
                    await this.handleReceipts(clientId, data);
                    return;
                default:
                    this.sendError(clientId, `Unknown chat action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`Error handling chat action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        } finally {
            scope.close();
            const duration = Date.now() - startTime;
            this.logger.info(`[chat] ${action}`, { clientId, channel: data?.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: chat/${action} took ${duration}ms`, { clientId });
            }
        }
    }

    async handleJoinChannel(
        clientId: string,
        { channel, metadata: _metadata = {} }: { channel: string; metadata?: any },
        scope?: AuthorityScope,
    ): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
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
            const joinIdentity = this._resolveIdentity(clientId);
            if (!this._checkDmMembership(clientId, channel, joinIdentity)) {
                return;
            }
            // Channel membership gate: a closed channel admits only its
            // active members. Runs before the router subscribe, like the dm
            // gate, so a refused client never holds a subscription.
            if (!(await this._checkMembership(clientId, channel, joinIdentity, scope))) {
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
                const subscribed = await this.messageRouter.subscribeToChannel(clientId, channel, { service: 'chat', clientChannel: channel, ...(scope ? { scope } : {}) });
                if (subscribed === false) {
                    this.logger.info(`Client ${clientId} subscribe to chat channel ${channel} denied by router authz`);
                    return;
                }
            }

            this.clientChannels.addSubscription(clientId, channel);

            // The join index: an open channel's audience is everyone who has
            // ever joined it, not just whoever is here now. dm channels have
            // their audience in their name. The hook never fails the join.
            if (this.onChannelJoin && joinIdentity?.userId && !isDmChatChannel(channel)) {
                try {
                    this.onChannelJoin({ channel, userId: joinIdentity.userId });
                } catch (hookErr: any) {
                    this.logger.error('onChannelJoin hook threw (ignored):', hookErr);
                }
            }

            if (!(await this.mayDeliverRead(clientId, channel, context, scope))) return;
            this.sendToClient(clientId, {
                type: 'chat',
                action: 'joined',
                channel,
                timestamp: new Date().toISOString(),
            });

            await this.sendChannelHistory(clientId, channel, joinIdentity?.userId, scope);

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

        try { await this._persistMessage(messageData); }
        catch (err: any) {
            this.logger.error('Failed to persist system message:', err && err.message);
            return null;
        }
        this.addToChannelHistory(channel, messageData);
        // No sender to exclude and none to authorize as: this is the server
        // talking to the channel.
        await this.broadcastMessage(channel, messageData);
        return messageData;
    }

    /**
     * Change a message the server posted — a call card going from live to
     * ended, a run card getting its result. The text may change and the
     * metadata is MERGED (a key set to `undefined` is dropped), because the
     * caller usually knows the two fields that changed, not the whole record.
     *
     * Persisted first, then everyone on the channel gets `messageUpdated`
     * with the whole record, the same frame an author's edit produces — so a
     * client that already renders edits renders this without knowing the
     * difference, and a reload reads the same state back from the store.
     *
     * No `editedAt`: nobody edited anything, the thing the message describes
     * moved on. Returns the updated record, or null when the message is not
     * on this channel (or the store refused the write).
     */
    async updateSystemMessage(
        channel: string,
        messageId: string,
        patch: { message?: string; metadata?: Record<string, unknown> },
    ): Promise<ChatMessage | null> {
        if (!channel || !messageId) return null;
        const existing = await this._findMessage(channel, messageId);
        if (!existing || existing.deletedAt) return null;
        const merged: Record<string, unknown> = { ...(existing.metadata ?? {}) };
        for (const [k, v] of Object.entries(patch.metadata ?? {})) {
            if (v === undefined) delete merged[k];
            else merged[k] = v;
        }
        const fields: { message?: string; metadata?: Record<string, unknown> } = { metadata: merged };
        if (typeof patch.message === 'string' && patch.message.length > 0) fields.message = patch.message;
        let updated: ChatMessage;
        try {
            updated = await this._applyMessagePatch(channel, existing, fields);
        } catch (err: any) {
            this.logger.error('Failed to persist a system message update:', err && err.message);
            return null;
        }
        await this._broadcastFrame(channel, {
            type: 'chat',
            action: 'messageUpdated',
            channel,
            message: updated,
            timestamp: new Date().toISOString(),
        });
        this._noteMessageChanged(channel, 'edited', updated);
        return updated;
    }

    async handleSendMessage(
        clientId: string,
        frame: { channel: string; message: string; metadata?: any },
        scope?: AuthorityScope,
    ): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
        const sameContext = () => !this.messageRouter.getClientData || this.messageRouter.getClientData(clientId)?.userContext === context;
        const { channel, message } = frame;
        let { metadata = {} } = frame;
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
        const hasAttachments =
            !!metadata &&
            Array.isArray((metadata as { attachments?: unknown }).attachments) &&
            (metadata as { attachments: unknown[] }).attachments.length > 0;

        if (typeof message !== 'string') {
            this.sendError(clientId, 'Message must be a string');
            return;
        }
        if (message.length === 0 && !hasAttachments) {
            this.sendError(clientId, 'A message needs text or an attachment');
            return;
        }
        if (message.length > this.maxMessageLength) {
            this.sendError(
                clientId,
                `Message must be a string between 1 and ${this.maxMessageLength} characters`
            );
            return;
        }

        metadata = validateMetadata(metadata, this.logger, this.maxMetadataKeys, this.maxMetadataSize);

        // Resolve identity ONCE — feeds both the dm-membership gate and
        // the userId stamp below.
        const identity = this._resolveIdentity(clientId, frame);

        // Membership before subscription: a person the owner just removed
        // was also unsubscribed, and "you must join first" would send them
        // off to join — which is refused — when the true answer is that they
        // are no longer a member.
        // DM membership gate (v0.23.0) — send is checked independently of
        // join (subscriptions can predate enforcement being enabled).
        if (!this._checkDmMembership(clientId, channel, identity)) {
            return;
        }
        if (!(await this._checkMembership(clientId, channel, identity, scope))) {
            return;
        }

        if (!sameContext()) return;
        if (!this.clientChannels.hasSubscription(clientId, channel)) {
            this.sendError(clientId, 'You must join the channel before sending messages');
            return;
        }

        try {
            if (identity && identity.userId && !this.trustFrameSender) {
                // An identified sender is named by the server. The frame's
                // copies of the sender fields are advisory and dropped —
                // otherwise any socket could post under anybody's name.
                metadata = stampSender(metadata, identity);
            } else if (identity && identity.userId) {
                // trustFrameSender: the pre-0.98.5 rule — merge the server's
                // presentation hints ONLY where the frame left them out.
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

            // Persist BEFORE acking or broadcasting. This used to be
            // fire-and-forget: the cache was updated and the message handed
            // to every subscriber before the store write even started, so a
            // store outage looked exactly like a successful send — the ack
            // said `sent`, everyone's screen showed the message, and it was
            // never actually written anywhere durable. A message that never
            // reached the store has not been sent, no matter what the local
            // cache and the other participants' screens say, so nothing else
            // happens until this resolves.
            // The stored record gates every visible success: a failed write
            // must not enter the cache, fan out, or tell observers it was sent.
            if (!sameContext() || !(await routerPermits(this.messageRouter, 'publish', clientId, channel, { service: 'chat', clientChannel: channel, scope })) || !sameContext()) return;
            try {
                await this._persistMessage(messageData);
            } catch (err: any) {
                this.logger.error('Failed to persist chat message:', err && err.message);
                if (!sameContext()) return;
                this.sendError(clientId, 'Message could not be stored. Your message was not sent.',
                    ErrorCodes.CHAT_STORE_FAILED, channel, { messageId: messageData.id });
                return;
            }
            // Authority may have changed while storage was pending. The
            // committed record remains durable; publication and its receipt
            // still require the author's current write authority.
            if (!sameContext() || !(await routerPermits(this.messageRouter, 'publish', clientId, channel, { service: 'chat', clientChannel: channel, scope })) || !sameContext()) return;
            this.addToChannelHistory(channel, messageData);
            await this.broadcastMessage(channel, messageData, clientId, scope);
            if (!sameContext() || !(await routerPermits(this.messageRouter, 'publish', clientId, channel, { service: 'chat', clientChannel: channel, scope })) || !sameContext()) return;
            this.sendToClient(clientId, {
                type: 'chat', action: 'sent', messageId: messageData.id,
                channel, timestamp: messageData.timestamp,
            });

            // DM activity seam (v0.23.0) — fire-and-forget observer after a
            // successful dm send. Exceptions never fail the send path.
            if (this.onDmMessage && isDmChatChannel(channel)) {
                const hook = this.onDmMessage;
                this._runMessageHook('onDmMessage', scope, (hookScope) => hook({
                    channel,
                    // Hashed chat:dmg: channels are non-reversible → [].
                    members: dmChannelMembers(channel) ?? [],
                    message: messageData,
                    ...(hookScope ? { scope: hookScope } : {}),
                }));
            }

            // Channel activity seam — the same idea for rooms and named
            // channels, so a member who is not looking gets an unread count.
            if (this.onChannelMessage && !isDmChatChannel(channel)) {
                const hook = this.onChannelMessage;
                try {
                    const members = await this._channelMessageRecipients(channel, messageData.userId, scope);
                    this._runMessageHook('onChannelMessage', scope, (hookScope) => hook({
                        channel, members, message: messageData,
                        ...(hookScope ? { scope: hookScope } : {}),
                    }));
                } catch (hookErr) {
                    this.logger.error('onChannelMessage hook threw (ignored):', hookErr);
                }
            }

            this.logger.info(`Message sent by client ${clientId} to channel ${channel}`);
        } catch (error) {
            this.logger.error(`Error sending message to channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to send message');
        }
    }

    /**
     * Fire-and-forget hook call that keeps the send's authority scope open
     * until a returned promise settles (its unread probes are the tail of the
     * same operation). Exceptions and rejections are logged, never thrown.
     */
    private _runMessageHook(name: string, scope: AuthorityScope | undefined, call: (scope: AuthorityScope | undefined) => void | Promise<void>): void {
        const release = scope?.active ? scope.retain() : null;
        const hookScope = release ? scope : undefined;
        try {
            const result = call(hookScope);
            if (result && typeof (result as Promise<void>).then === 'function') {
                (result as Promise<void>).then(
                    () => release?.(),
                    (err) => { release?.(); this.logger.error(`${name} hook rejected (ignored):`, err); },
                );
                return;
            }
        } catch (hookErr) {
            this.logger.error(`${name} hook threw (ignored):`, hookErr);
        }
        release?.();
    }

    /**
     * The stored message behind an edit or a delete: the channel cache
     * first, the store when the cache has turned over. Null when unknown.
     */
    async _findMessage(channel: string, messageId: string): Promise<ChatMessage | null> {
        const cached = this.getChannelCache(channel).get(messageId);
        if (cached) return cached;
        try {
            const stored = await this._loadHistoryFromStore(channel, this.maxMessagesPerChannel);
            return stored.find((m) => m.id === messageId) ?? null;
        } catch (err: any) {
            this.logger.error('Failed to read a message for edit/delete:', err && err.message);
            return null;
        }
    }

    /**
     * The author may change or take back what they said; nobody else may.
     * Resolves the record when the caller is its author, having answered
     * the caller with the right refusal otherwise.
     */
    async _ownMessage(clientId: string, channel: string, messageId: unknown, identity: ChatSenderIdentity | null): Promise<ChatMessage | null> {
        if (typeof messageId !== 'string' || !messageId) {
            this.sendError(clientId, 'messageId is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return null;
        }
        const existing = await this._findMessage(channel, messageId);
        if (!existing) {
            this.sendError(clientId, 'No such message', ErrorCodes.CHAT_NOT_FOUND, channel);
            return null;
        }
        if (!identity?.userId || existing.userId !== identity.userId) {
            this.sendError(clientId, 'Only the author may change this message', ErrorCodes.CHAT_FORBIDDEN, channel);
            return null;
        }
        return existing;
    }

    /**
     * Persists the patch before touching the cache, and throws on failure
     * instead of logging and continuing. Same discipline as
     * `handleSendMessage`'s persist-before-anything-else: an edit or delete
     * that never reached the store must not be believed by the local cache
     * either, or a client that asks for history right after would see a
     * change nobody else's store agrees happened.
     */
    async _applyMessagePatch(channel: string, existing: ChatMessage, patch: { message?: string; metadata?: Record<string, unknown>; editedAt?: string; deletedAt?: string }): Promise<ChatMessage> {
        const updated: ChatMessage = { ...existing, ...patch };
        await this.chatStore.updateMessage(channel, updated.id, patch);
        this.getChannelCache(channel).set(updated.id, updated);
        return updated;
    }

    /**
     * `{action:'edit', channel, messageId, message, metadata?}` — the author
     * changes the text (and may merge metadata: mentions, html); everyone on
     * the channel gets `messageUpdated` with the whole updated record.
     */
    async handleEditMessage(
        clientId: string,
        frame: { channel: string; messageId?: unknown; message?: unknown; metadata?: unknown }
    ): Promise<void> {
        const { channel, messageId, message, metadata } = frame;
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (typeof message !== 'string' || message.length === 0) {
            this.sendError(clientId, 'An edit needs text', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (message.length > this.maxMessageLength) {
            this.sendError(clientId, `Message must be between 1 and ${this.maxMessageLength} characters`, ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId, frame);
        if (!this._checkDmMembership(clientId, channel, identity)) return;
        if (!(await this._checkMembership(clientId, channel, identity))) return;
        const existing = await this._ownMessage(clientId, channel, messageId, identity);
        if (!existing) return;
        if (existing.deletedAt) {
            this.sendError(clientId, 'That message was deleted', ErrorCodes.CHAT_GONE, channel);
            return;
        }
        let patchMeta = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : null;
        if (patchMeta && !this.trustFrameSender) {
            // An edit may change what was said, never who said it: the
            // stored sender fields stay, the frame's copies are dropped.
            delete patchMeta.userId;
            delete patchMeta.displayName;
            delete patchMeta.avatarUrl;
        }
        const merged = patchMeta
            ? validateMetadata({ ...(existing.metadata ?? {}), ...patchMeta }, this.logger, this.maxMetadataKeys, this.maxMetadataSize)
            : existing.metadata;
        const editedAt = new Date().toISOString();
        let updated: ChatMessage;
        try {
            updated = await this._applyMessagePatch(channel, existing, { message, ...(merged !== undefined ? { metadata: merged } : {}), editedAt });
        } catch (err: any) {
            this.logger.error('Failed to persist a message edit:', err && err.message);
            this.sendError(
                clientId,
                'Message could not be stored',
                ErrorCodes.CHAT_STORE_FAILED,
                channel,
                { messageId: existing.id }
            );
            return;
        }
        await this._broadcastFrame(channel, { type: 'chat', action: 'messageUpdated', channel, message: updated, timestamp: editedAt }, clientId);
        this._noteMessageChanged(channel, 'edited', updated);
        this.logger.info(`Message ${updated.id} edited by client ${clientId} on channel ${channel}`);
    }

    /**
     * `{action:'delete', channel, messageId}` — a soft delete: the record
     * keeps its id, author and time; the text goes, the metadata becomes
     * {deleted:true}. Everyone on the channel gets `messageDeleted`.
     */
    async handleDeleteMessage(
        clientId: string,
        frame: { channel: string; messageId?: unknown }
    ): Promise<void> {
        const { channel, messageId } = frame;
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId, frame);
        if (!this._checkDmMembership(clientId, channel, identity)) return;
        if (!(await this._checkMembership(clientId, channel, identity))) return;
        const existing = await this._ownMessage(clientId, channel, messageId, identity);
        if (!existing) return;
        const deletedAt = existing.deletedAt ?? new Date().toISOString();
        let updated: ChatMessage;
        if (existing.deletedAt) {
            updated = existing;
        } else {
            try {
                updated = await this._applyMessagePatch(channel, existing, { message: '', metadata: { deleted: true }, deletedAt });
            } catch (err: any) {
                this.logger.error('Failed to persist a message delete:', err && err.message);
                this.sendError(
                    clientId,
                    'Message could not be stored',
                    ErrorCodes.CHAT_STORE_FAILED,
                    channel,
                    { messageId: existing.id }
                );
                return;
            }
        }
        await this._broadcastFrame(channel, { type: 'chat', action: 'messageDeleted', channel, messageId: updated.id, deletedAt, timestamp: new Date().toISOString() }, clientId);
        this._noteMessageChanged(channel, 'deleted', updated);
        this.logger.info(`Message ${updated.id} deleted by client ${clientId} on channel ${channel}`);
    }

    _noteMessageChanged(channel: string, kind: 'edited' | 'deleted', message: ChatMessage): void {
        if (!this.onMessageChanged) return;
        try {
            this.onMessageChanged({ channel, kind, message });
        } catch (hookErr) {
            this.logger.error('onMessageChanged hook threw (ignored):', hookErr);
        }
    }

    /** A chat frame to every subscriber of `channel`, the sender included, the way `broadcastMessage` sends. */
    async _broadcastFrame(channel: string, frame: Record<string, unknown>, publisherClientId?: string): Promise<void> {
        if (publisherClientId != null) {
            await this.messageRouter.sendToChannel(channel, frame, null, { publisherClientId });
        } else {
            await this.messageRouter.sendToChannel(channel, frame);
        }
    }

    async handleGetHistory(
        clientId: string,
        { channel, limit }: { channel: string; limit?: number }
    ): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
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
            const fetched = await this.getChannelHistoryFor(identity?.userId, channel, limit ?? this.defaultHistoryLimit);
            const history = await this.historyForDelivery(clientId, channel, fetched, context, identity?.userId);
            if (history === null) return;
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
        const cached = Array.from(cache.values());
        // The cache is what this process has seen — after a restart, only the
        // messages that arrived since. It used to answer from the cache alone
        // the moment it held anything, so one new message on a channel with
        // days of stored history made history two messages long for everyone
        // (measured on room:table-test: 13 stored, 2 served). When the cache
        // cannot fill the request, the store's tail is merged in by id.
        let merged: ChatMessage[] = cached;
        if (cached.length < effectiveLimit) {
            const storeMessages = await this._loadHistoryFromStore(channel, effectiveLimit);
            if (storeMessages.length > 0) {
                const byId = new Map<string, ChatMessage>();
                for (const msg of storeMessages) byId.set(msg.id, msg);
                // The cache is the more recent view of a message this process
                // changed (an edit whose store write is still in flight).
                for (const msg of cached) byId.set(msg.id, msg);
                merged = Array.from(byId.values());
                for (const msg of storeMessages) if (!cache.has(msg.id)) cache.set(msg.id, msg);
            }
        }
        merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
        return merged.slice(-effectiveLimit);
    }

    async sendChannelHistory(clientId: string, channel: string, userId?: string, scope?: AuthorityScope): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
        const originalUserId = userId ?? this._resolveIdentity(clientId)?.userId;
        const fetched = await this.getChannelHistoryFor(originalUserId, channel, this.joinHistoryLimit, scope);
        const history = await this.historyForDelivery(clientId, channel, fetched, context, originalUserId, scope);
        if (history === null) return;
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

    /** Refilter an already fetched tail when a leave/rejoin tightened its floor. */
    private async historyForDelivery(clientId: string, channel: string, history: ChatMessage[], context: unknown, userId?: string, scope?: AuthorityScope): Promise<ChatMessage[] | null> {
        if (!(await this.mayDeliverRead(clientId, channel, context, scope))) return null;
        const sameIdentity = () => (!this.messageRouter.getClientData || this.messageRouter.getClientData(clientId)?.userContext === context)
            && this._resolveIdentity(clientId)?.userId === userId;
        if (!sameIdentity()) return null;
        if (!this.membershipStore || isDmChatChannel(channel)) return history;
        let rows: ChatMember[];
        try {
            // This last authority read is intentionally fail-closed. A store
            // outage cannot turn a closed channel into an unrestricted tail.
            // It is also deliberately OUTSIDE any authority scope: the final
            // history filter always reads fresh rows.
            rows = await this.membershipStore.listMembers(channel);
        } catch (err: any) {
            this.logger.error('ChatMembershipStore final history check failed:', err && err.message);
            return null;
        }
        if (!sameIdentity()) return null;
        return this.filterMemberHistory(userId, rows, history);
    }

    /** Sensitive direct replies must not use a decision from before a store read. */
    private async mayDeliverRead(clientId: string, channel: string, context: unknown, scope?: AuthorityScope): Promise<boolean> {
        const sameContext = () => !this.messageRouter.getClientData || this.messageRouter.getClientData(clientId)?.userContext === context;
        if (!sameContext()) return false;
        const identity = this._resolveIdentity(clientId);
        const allowed = this.authz(clientId, channel, this)
            && this._checkDmMembership(clientId, channel, identity)
            && await this._checkMembership(clientId, channel, identity, scope)
            && await routerPermits(this.messageRouter, 'subscribe', clientId, channel, { service: 'chat', clientChannel: channel, ...(scope ? { scope } : {}) });
        if (!sameContext()) return false;
        if (!allowed) {
            this.clientChannels.removeSubscription(clientId, channel);
            await this.messageRouter.unsubscribeFromChannel?.(clientId, channel);
        }
        return allowed;
    }

    // ---- Membership ------------------------------------------------------

    /**
     * Who should hear about a message on a non-dm channel, sender excluded:
     * a closed channel's active members; an open channel's currently
     * subscribed users (the only ones this node can name — an open channel
     * keeps no roster).
     */
    async _channelMessageRecipients(channel: string, senderUserId: string | undefined, scope?: AuthorityScope): Promise<string[]> {
        const rows = await this._membershipRows(channel, scope);
        const out = new Set<string>();
        if (rows.length > 0) {
            for (const r of rows) if (!r.removedAt) out.add(r.userId);
        } else {
            for (const clientId of this.clientChannels.getClientsFor(channel)) {
                const id = this._resolveIdentity(clientId);
                if (id?.userId) out.add(id.userId);
            }
            // Plus everyone the host has seen join this open channel: the
            // person on another page still gets the unread, as in Teams.
            if (this.channelAudience) {
                try {
                    for (const userId of await this.channelAudience(channel)) if (userId) out.add(userId);
                } catch (err: any) {
                    this.logger.error('channelAudience hook failed (ignored):', err && err.message);
                }
            }
        }
        if (senderUserId) out.delete(senderUserId);
        return Array.from(out);
    }

    /** Every row for the channel; [] when there is no store or the channel is open. */
    async _membershipRows(channel: string, scope?: AuthorityScope): Promise<ChatMember[]> {
        if (!this.membershipStore) return [];
        try {
            return await (scope?.active
                ? this.membershipStore.listMembers(channel, { scope })
                : this.membershipStore.listMembers(channel));
        } catch (err: any) {
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
    async describeMembers(channel: string): Promise<{ open: boolean; members: ChatMemberView[] }> {
        if (isDmChatChannel(channel)) {
            const ids = dmChannelMembers(channel);
            if (ids) {
                return {
                    open: false,
                    members: ids.map((userId) => ({ userId, role: 'member' as const, addedBy: userId, addedAt: '', historyFrom: null })),
                };
            }
            // Hashed group dm: members are not derivable from the name.
            return { open: true, members: [] };
        }
        const rows = await this._membershipRows(channel);
        if (rows.length === 0) return { open: true, members: [] };
        return { open: false, members: rows.filter((r) => r.removedAt == null).map(memberView) };
    }

    /**
     * Channel membership gate. True when the channel is open (no rows), is a
     * dm channel (the dm gate owns those), or the sender is an active member.
     * FAIL-CLOSED on a closed channel: no resolvable userId ⇒ refused.
     */
    async _checkMembership(clientId: string, channel: string, identity: ChatSenderIdentity | null, scope?: AuthorityScope): Promise<boolean> {
        if (!this.membershipStore || isDmChatChannel(channel)) return true;
        const rows = await this._membershipRows(channel, scope);
        if (rows.length === 0) return true;
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
    async getChannelHistoryFor(userId: string | undefined, channel: string, limit?: number, scope?: AuthorityScope): Promise<ChatMessage[]> {
        const history = await this.getChannelHistory(channel, limit);
        if (!this.membershipStore || isDmChatChannel(channel)) return history;
        const rows = await this._membershipRows(channel, scope);
        return this.filterMemberHistory(userId, rows, history);
    }

    private filterMemberHistory(userId: string | undefined, rows: ChatMember[], history: ChatMessage[]): ChatMessage[] {
        if (rows.length === 0) return history;
        const row = userId ? rows.find((r) => r.userId === userId) : undefined;
        if (!row || row.removedAt != null) return [];
        if (!row.historyFrom) return history;
        const floor = Date.parse(row.historyFrom);
        if (!Number.isFinite(floor)) return history;
        // Strictly after the floor, not at it. `mode: 'none'` sets the floor to
        // the instant of the add, so a message stamped that same millisecond
        // already existed when they were added — which is the one thing that
        // mode is for hiding. An inclusive compare handed it to them whenever
        // the channel was busy enough for the two to land in the same
        // millisecond, and the cost of the other edge is symmetrical and
        // smaller: a message sent in that same millisecond is not shown, where
        // showing history nobody granted is a permission leak.
        return history.filter((m) => {
            const t = Date.parse(m.timestamp);
            return Number.isFinite(t) && t > floor;
        });
    }

    /** `{action:'members', channel}` → who is in it, to the sender. */
    async handleMembers(clientId: string, { channel }: { channel: string }): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const { open, members } = await this.describeMembers(channel);
        if (!(await this.mayDeliverRead(clientId, channel, context))) return;
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
    async handleAddMembers(
        clientId: string,
        { channel, userIds, history, names }: { channel: string; userIds?: unknown; history?: unknown; names?: unknown },
    ): Promise<void> {
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (!this.membershipStore) {
            this.sendError(clientId, 'Membership is not enabled on this gateway', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (isDmChatChannel(channel)) {
            this.sendError(clientId, 'A direct message has fixed members; start a group chat instead', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const ids = Array.isArray(userIds)
            ? Array.from(new Set(userIds.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 200)))
            : [];
        if (ids.length === 0 || ids.length > 50) {
            this.sendError(clientId, 'userIds must name between 1 and 50 people', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const choice: ChatHistoryChoice | null = parseHistoryChoice(history);
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
        const nameOf = (id: string): string => {
            const given = names && typeof names === 'object' ? (names as Record<string, unknown>)[id] : undefined;
            return typeof given === 'string' && given ? given.slice(0, 120) : id;
        };
        try {
            if (rows.length === 0) {
                // First rows close the channel; the requester owns it.
                await this.membershipStore.putMember({ channel, userId: actorId, role: 'owner', addedBy: actorId, addedAt: now, historyFrom: null, removedAt: null });
            } else {
                const me = rows.find((r) => r.userId === actorId);
                if (!me || me.removedAt != null) {
                    this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
                    return;
                }
            }
            const floor = historyFloorFor(choice);
            const added: string[] = [];
            for (const userId of ids) {
                if (userId === actorId) continue;
                const existing = rows.find((r) => r.userId === userId);
                if (existing && existing.removedAt == null) continue; // already in
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
            // Adding people moves the receipts line: the first add closes an
            // open channel and turns them ON, and a big enough add takes the
            // channel over the cap and turns them off again.
            await this._broadcastReceipts(channel, clientId);
        } catch (err: any) {
            this.logger.error(`addMembers failed on ${channel}:`, err && err.message);
            this.sendError(clientId, 'Failed to add members', ErrorCodes.SERVICE_INTERNAL_ERROR, channel);
        }
    }

    /** `{action:'removeMember', channel, userId}` — an owner may remove anyone; anyone may remove themselves. */
    async handleRemoveMember(clientId: string, { channel, userId, name }: { channel: string; userId?: unknown; name?: unknown }): Promise<void> {
        if (!channel || typeof channel !== 'string' || typeof userId !== 'string' || !userId) {
            this.sendError(clientId, 'channel and userId are required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        if (!this.membershipStore || isDmChatChannel(channel)) {
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
            // Their live connections go first: a removed person must not see
            // the "removed" line or anything after it. The row alone only
            // stopped their NEXT join; a connection already subscribed kept
            // receiving every broadcast until it reconnected.
            await this._evictFromChannel(channel, userId, actorId);
            // Their cursor goes with them: a receipt is a statement about a
            // member of the channel, and someone who has left should not go
            // on telling the room when they last looked at it. (A socket
            // `leave` is NOT this — that is a closed tab, and the cursor
            // survives it.)
            await this._forgetReceipt(channel, userId);
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
            await this._broadcastReceipts(channel, clientId);
        } catch (err: any) {
            this.logger.error(`removeMember failed on ${channel}:`, err && err.message);
            this.sendError(clientId, 'Failed to remove member', ErrorCodes.SERVICE_INTERNAL_ERROR, channel);
        }
    }

    /**
     * Unsubscribe every live connection of `userId` from `channel` and tell
     * each one `{type:'chat', action:'removed', channel, byUserId}` so the
     * client can say "You were removed from #x" and drop the thread. Runs on
     * this node's subscriptions; a multi-node deployment relies on the
     * membership row for the other nodes' next join/send (fail closed).
     */
    async _evictFromChannel(channel: string, userId: string, byUserId: string): Promise<void> {
        const timestamp = new Date().toISOString();
        for (const victim of this.clientChannels.getClientsFor(channel)) {
            if (this._resolveIdentity(victim)?.userId !== userId) continue;
            try {
                if (this.messageRouter.unsubscribeFromChannel) await this.messageRouter.unsubscribeFromChannel(victim, channel);
            } catch (err: any) {
                this.logger.error(`unsubscribe on removal failed for ${victim} on ${channel}:`, err && err.message);
            }
            this.clientChannels.removeSubscription(victim, channel);
            this.sendToClient(victim, { type: 'chat', action: 'removed', channel, byUserId, timestamp });
        }
    }

    /**
     * A membership change, as a stored message from the person who made it.
     * Not gated on a join: the owner adding people from a picker may not be
     * subscribed to the channel at that moment.
     */
    async _postMembershipMessage(
        channel: string,
        clientId: string,
        identity: ChatSenderIdentity | null,
        text: string,
        metadata: Record<string, unknown>,
    ): Promise<ChatMessage> {
        const messageData: ChatMessage = {
            id: this.generateMessageId(),
            clientId,
            ...(identity?.userId ? { userId: identity.userId } : {}),
            channel,
            message: text,
            metadata: {
                ...metadata,
                // A membership line is a RECORD of what happened, not words
                // somebody wrote, so it carries the same `system` mark every
                // other server-posted notice does. It was the one exception,
                // and it stamps the actor's `userId` as well — so the only
                // thing keeping "Eve added Carol" from rendering as Eve's own
                // editable message was a renderer that happens to check
                // `metadata.kind === 'membership'` first. That is a
                // coincidence to rely on, not a contract.
                system: true,
                ...(identity?.displayName !== undefined ? { displayName: identity.displayName } : {}),
                ...(identity?.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
            },
            timestamp: new Date().toISOString(),
        };
        this.addToChannelHistory(channel, messageData);
        this._persistMessage(messageData).catch((err: any) =>
            this.logger.error('Failed to persist membership message:', err && err.message),
        );
        await this.broadcastMessage(channel, messageData);
        return messageData;
    }

    /** The roster, to everyone in the channel and to the requester whether or not they are subscribed. */
    async _broadcastMembers(channel: string, requesterClientId: string): Promise<void> {
        const context = this.messageRouter.getClientData?.(requesterClientId)?.userContext;
        const { open, members } = await this.describeMembers(channel);
        const frame = { type: 'chat', action: 'membersUpdated', channel, open, members, timestamp: new Date().toISOString() };
        if (await this.mayDeliverRead(requesterClientId, channel, context)) this.sendToClient(requesterClientId, frame);
        await this.messageRouter.sendToChannel(channel, frame, requesterClientId);
    }

    // ---- Read receipts ---------------------------------------------------
    //
    // A receipt is a CURSOR: "this person has seen everything up to time T".
    // See ChatReadReceiptStore for why that rather than a row per
    // (message, reader).
    //
    // Two things follow from the cursor being a TIME and not a message id,
    // and both are the answer to "what happens when the message a receipt
    // points at changes":
    //
    //   - An EDIT changes nothing. The cursor does not name the message, so
    //     there is no dangling pointer to repair, and nobody is marked
    //     unread by it: an edit is a change to what was said, not new
    //     traffic (the same judgement `onMessageChanged` already records for
    //     the conversations index). Teams behaves the same way — an edited
    //     message does not come back unread.
    //   - A DELETE changes nothing either, for the same reason. The soft
    //     delete keeps the record's timestamp anyway, and even a hard delete
    //     would leave "read through 09:06" true. Compare a per-message
    //     receipt table, where every delete orphans N rows that must be
    //     swept or filtered forever.
    //
    // Leaving is the one event that DOES clear a receipt — see
    // `_forgetReceipt`, called from `handleRemoveMember`. Note the
    // distinction from `handleLeaveChannel`, which is a socket unsubscribe
    // (a closed tab, a navigation) and must NOT clear anything: that person
    // is still a member and still read what they read.

    /**
     * May this channel keep read receipts, and who is the audience if so?
     *
     * Receipts are kept only where the roster is NAMEABLE and SMALL:
     *
     *   - a member-addressed dm (`chat:dm:a:b`) — two people, both in the
     *     channel id;
     *   - a closed channel with at most `receiptsMaxMembers` active members.
     *
     * Everything else is off, and each `off` says why so a client can
     * explain itself rather than silently rendering nothing:
     *
     *   - `disabled` — no store wired.
     *   - `open-channel` — a channel with no membership rows has no roster
     *     at all. "Seen by 3" against an unknown denominator means nothing,
     *     the audience is unbounded, and this is exactly the Teams line:
     *     receipts in chats, none in a channel anyone can walk into. The
     *     way to turn them on is to add members, which closes the channel.
     *   - `unknown-roster` — a hashed group dm (`chat:dmg:`). It IS a small
     *     private chat, but its members are not recoverable from the name,
     *     so the size cap cannot be enforced here. Erring towards not
     *     telling people who looked.
     *   - `too-many-members` — over the cap. Existing rows are left alone
     *     rather than deleted (nothing is served while the channel is over
     *     the line, and removing someone puts it honestly back).
     */
    async _receiptsAudience(channel: string): Promise<
        { enabled: true; members: string[] }
        | { enabled: false; members: null; reason: 'disabled' | 'open-channel' | 'unknown-roster' | 'too-many-members' }
    > {
        if (!this.readReceiptStore) return { enabled: false, members: null, reason: 'disabled' };
        if (isDmChatChannel(channel)) {
            const ids = dmChannelMembers(channel);
            if (!ids) return { enabled: false, members: null, reason: 'unknown-roster' };
            if (ids.length > this.receiptsMaxMembers) return { enabled: false, members: null, reason: 'too-many-members' };
            return { enabled: true, members: ids };
        }
        const rows = await this._membershipRows(channel);
        const active = rows.filter((r) => r.removedAt == null).map((r) => r.userId);
        if (active.length === 0) return { enabled: false, members: null, reason: 'open-channel' };
        if (active.length > this.receiptsMaxMembers) return { enabled: false, members: null, reason: 'too-many-members' };
        return { enabled: true, members: active };
    }

    /**
     * The channel's cursors, newest reader first, filtered to people who are
     * still in the channel. The filter is belt-and-braces over
     * `_forgetReceipt` — a row written before a crash, or by another node
     * mid-removal, never outlives the membership it describes on the wire.
     */
    async listReadReceipts(channel: string): Promise<ChatReadReceipt[]> {
        const audience = await this._receiptsAudience(channel);
        if (!audience.enabled || !this.readReceiptStore) return [];
        let rows: ChatReadReceipt[];
        try {
            rows = await this.readReceiptStore.listReceipts(channel);
        } catch (err: any) {
            this.logger.error('ChatReadReceiptStore list failed:', err && err.message);
            return [];
        }
        const allowed = new Set(audience.members);
        return rows
            .filter((r) => allowed.has(r.userId))
            .sort((a, b) => (a.readAt === b.readAt ? (a.userId < b.userId ? -1 : 1) : a.readAt < b.readAt ? 1 : -1));
    }

    /**
     * `{action:'read', channel, messageId?, at?}` — "I have read up to here."
     *
     * The cursor the server stores is resolved in this order: the timestamp
     * of `messageId` when it names a message we can still find, else `at`
     * when it is a valid ISO time, else now. It is clamped to now (a client
     * cannot claim to have read the future) and the store refuses to move it
     * backwards, so a scroll upwards, a slow duplicate frame or a second tab
     * on an older view cannot un-read the channel. A cursor that does not
     * move broadcasts nothing — which is what keeps a chatty client from
     * turning a quiet channel into a fan-out storm.
     *
     * The membership gates run first and answer for themselves, so a
     * non-member gets `not-a-member` rather than a silent no-op. Unlike
     * `typing`, this does NOT require a prior `join` on the connection: the
     * gate that matters is membership, and a receipts hook mounted beside
     * the transcript may send its first `read` before the transcript's join
     * ack has come back.
     */
    async handleReadReceipt(
        clientId: string,
        { channel, messageId, at }: { channel: string; messageId?: unknown; at?: unknown },
    ): Promise<void> {
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId);
        if (!this._checkDmMembership(clientId, channel, identity)) return;
        if (!(await this._checkMembership(clientId, channel, identity))) return;

        const audience = await this._receiptsAudience(channel);
        if (!audience.enabled || !this.readReceiptStore) {
            // Not an error frame: a client scrolling a big channel would get
            // one on every frame, and the `receipts` reply already tells it
            // (with a reason) that receipts are off here.
            this.logger.debug(`[chat] read ignored on ${channel}: ${audience.enabled ? 'no store' : audience.reason}`);
            return;
        }
        const userId = identity?.userId;
        if (!userId || !audience.members.includes(userId)) {
            this.sendError(clientId, 'You are not a member of this channel', ErrorCodes.CHAT_NOT_A_MEMBER, channel);
            return;
        }

        const now = new Date();
        const namedMessage = typeof messageId === 'string' && messageId.length > 0;
        const fallback = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
        let readAt: string | null = null;
        if (namedMessage) {
            const target = await this._findMessage(channel, messageId as string);
            if (target) readAt = target.timestamp;
        }
        if (readAt === null) readAt = fallback;
        if (readAt === null) {
            if (namedMessage) {
                // They named a message nobody can find and offered no usable
                // fallback time. Stamping `now` would silently mark the
                // channel read to this instant, which is the one wrong
                // answer here.
                this.sendError(clientId, 'No such message', ErrorCodes.CHAT_NOT_FOUND, channel);
                return;
            }
            readAt = now.toISOString();
        }
        // No cursors in the future, however the clock on the client is set.
        if (Date.parse(readAt) > now.getTime()) readAt = now.toISOString();

        const receipt: ChatReadReceipt = {
            channel,
            userId,
            readAt,
            updatedAt: now.toISOString(),
            ...(identity?.displayName ? { displayName: identity.displayName } : {}),
        };
        let stored: ChatReadReceipt | null;
        try {
            stored = await this.readReceiptStore.advance(receipt);
        } catch (err: any) {
            this.logger.error('ChatReadReceiptStore advance failed:', err && err.message);
            return;
        }
        if (!stored) return; // already at or past this point — nothing happened

        // To the whole channel INCLUDING the reader, the way an edit goes
        // out: their other tabs need the accepted (clamped, monotonic) value
        // rather than whatever each of them believed it sent.
        await this._broadcastFrame(channel, {
            type: 'chat',
            action: 'readReceipt',
            channel,
            userId: stored.userId,
            ...(stored.displayName ? { displayName: stored.displayName } : {}),
            readAt: stored.readAt,
            updatedAt: stored.updatedAt,
            timestamp: stored.updatedAt,
        }, clientId);

        if (this.onReadReceipt) {
            try {
                this.onReadReceipt({ channel, receipt: stored });
            } catch (hookErr) {
                this.logger.error('onReadReceipt hook threw (ignored):', hookErr);
            }
        }
    }

    /**
     * `{action:'receipts', channel}` → the channel's cursors, to the sender.
     * Always answers, including when receipts are off here — `enabled:false`
     * with a reason is what lets a client stop sending `read` and say why
     * instead of showing an empty list that looks like "nobody has read it".
     */
    async handleReceipts(clientId: string, { channel }: { channel: string }): Promise<void> {
        const context = this.messageRouter.getClientData?.(clientId)?.userContext;
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel is required', ErrorCodes.CHAT_BAD_REQUEST, channel);
            return;
        }
        const identity = this._resolveIdentity(clientId);
        if (!this._checkDmMembership(clientId, channel, identity)) return;
        if (!(await this._checkMembership(clientId, channel, identity))) return;
        const frame = await this._receiptsFrame(channel);
        if (await this.mayDeliverRead(clientId, channel, context)) this.sendToClient(clientId, frame);
    }

    /** The full-state receipts frame — the reply to `receipts` and the broadcast after a roster change. */
    async _receiptsFrame(channel: string): Promise<Record<string, unknown>> {
        const audience = await this._receiptsAudience(channel);
        return {
            type: 'chat',
            action: 'receipts',
            channel,
            enabled: audience.enabled,
            ...(audience.enabled ? {} : { reason: audience.reason }),
            limit: this.receiptsMaxMembers,
            receipts: audience.enabled
                ? (await this.listReadReceipts(channel)).map((r) => ({
                    userId: r.userId,
                    ...(r.displayName ? { displayName: r.displayName } : {}),
                    readAt: r.readAt,
                    updatedAt: r.updatedAt,
                }))
                : [],
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * The roster changed, so the receipts a client holds may be wrong in two
     * ways at once — a person is gone, and the channel may have crossed the
     * size line in either direction. Full state to everyone, like
     * `_broadcastMembers` beside it, rather than an incremental frame per
     * difference.
     */
    async _broadcastReceipts(channel: string, requesterClientId: string): Promise<void> {
        const context = this.messageRouter.getClientData?.(requesterClientId)?.userContext;
        if (!this.readReceiptStore) return;
        const frame = await this._receiptsFrame(channel);
        if (await this.mayDeliverRead(requesterClientId, channel, context)) this.sendToClient(requesterClientId, frame);
        await this.messageRouter.sendToChannel(channel, frame, requesterClientId);
    }

    /** Someone left or was removed: their cursor goes with them. Never fails the removal. */
    async _forgetReceipt(channel: string, userId: string): Promise<void> {
        if (!this.readReceiptStore) return;
        try {
            await this.readReceiptStore.deleteReceipt(channel, userId);
        } catch (err: any) {
            this.logger.error('ChatReadReceiptStore delete failed:', err && err.message);
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

    /**
     * "Someone is typing" — relayed to the channel, never stored. Excluded
     * from the sender (their own composer knows), carried with the identity
     * the resolver gives the connection so the others can name them. A
     * connection that has not joined the channel is not in it, and may not
     * announce itself there.
     *
     * 0.108: typing is held to the same authority as a send. The dm and
     * channel membership gates run (a member removed while still subscribed
     * cannot announce themselves), and the fan-out names the typist as
     * publisher so the router rechecks `publish` at delivery — all within
     * the action's one authority scope, so it costs no extra proof.
     */
    async handleTyping(clientId: string, frame: { channel: string; typing?: unknown }, scope?: AuthorityScope): Promise<void> {
        const { channel, typing } = frame;
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }
        if (!this.clientChannels.hasSubscription(clientId, channel)) {
            this.sendError(clientId, 'You must join the channel before typing in it');
            return;
        }
        const identity = this._resolveIdentity(clientId, frame);
        if (!this._checkDmMembership(clientId, channel, identity)) return;
        if (!(await this._checkMembership(clientId, channel, identity, scope))) return;
        const out = {
            type: 'chat',
            action: 'typing',
            channel,
            clientId,
            userId: identity?.userId,
            displayName: identity?.displayName,
            typing: typing === true,
            timestamp: new Date().toISOString(),
        };
        await this.messageRouter.sendToChannel(channel, out, clientId,
            scope?.active ? { publisherClientId: clientId, scope } : { publisherClientId: clientId });
    }

    async broadcastMessage(channel: string, messageData: ChatMessage, publisherClientId?: string, scope?: AuthorityScope): Promise<void> {
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
            await this.messageRouter.sendToChannel(channel, broadcastMessage, null, scope?.active ? { publisherClientId, scope } : { publisherClientId });
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
    _resolveIdentity(clientId: string, frame?: unknown): ChatSenderIdentity | null {
        let base: ChatSenderIdentity | null = null;
        if (this.identityResolver) {
            try {
                base = this.identityResolver(clientId) ?? null;
            } catch (err) {
                this.logger.error(`identityResolver threw for client ${clientId}:`, err);
                base = null;
            }
        }
        // The connection's auth context (attachRealtime's `auth` result):
        // an explicit `resolveSender` decides outright; otherwise it fills
        // whatever the identityResolver left out (attach's default resolver
        // yields only a userId, so this is where the name comes from).
        const auth = resolveAuthSender(this.messageRouter, clientId, frame, this.resolveSender, (err) =>
            this.logger.error(`resolveSender threw for client ${clientId}:`, err));
        if (!auth) return base;
        if (this.resolveSender) {
            return { userId: auth.userId, displayName: auth.displayName, avatarUrl: auth.avatarUrl };
        }
        const out: ChatSenderIdentity = { userId: base?.userId ?? auth.userId };
        const displayName = base?.displayName ?? auth.displayName;
        const avatarUrl = base?.avatarUrl ?? auth.avatarUrl;
        if (displayName !== undefined) out.displayName = displayName;
        if (avatarUrl !== undefined) out.avatarUrl = avatarUrl;
        return out;
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
        errorCode: string = ErrorCodes.SERVICE_INTERNAL_ERROR,
        channel?: string,
        extra: Record<string, any> = {}
    ): void {
        const errorResponse = createErrorResponse(errorCode, message, {
            service: 'chat',
            clientId,
            ...(channel ? { channel } : {}),
            ...extra,
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
