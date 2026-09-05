"use strict";
// realtime-modules/src/reactions/ReactionService.ts
//
// Lifted from gateway's src/realtime-fanout/reaction-service.ts (337 LOC,
// Wave 2 extraction). In-memory emoji-reaction fan-out with a small LRU
// history per channel, plus an OPTIONAL durable path for reactions that name
// a target (`config.store`, a `ReactionStore` the consumer supplies — the
// service itself still knows nothing about DDB or Redis).
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional `(router, logger, metrics)` to
//     a single `ReactionServiceOptions` bag so callers can wire optional
//     config (custom catalog, authz hook, history size, …) without an
//     ever-growing signature.
//   - `enforceChannelPermission` interceptor coupling replaced with a
//     pluggable `authorizeChannel` hook (defaults to allow-all).
//   - `ErrorCodes` / `createErrorResponse` import removed; the equivalent
//     error envelope is inlined locally (DEFAULT_ERROR_CODE in types).
//   - `ownership-cleanup-coordinator` registration removed entirely —
//     gateway-specific (room/Raft eviction) and lives on at the gateway
//     wiring layer. `_cleanupRoom` is kept as a public method so the
//     gateway adapter can drive it.
//   - `SubscriptionTracker` lifted inline (~30 LOC) so the module stays
//     dependency-free.
//
// Everything else (action dispatch, validation, history ring buffer,
// reaction-id generation, broadcast semantics, getStats) is byte-faithful
// to the original.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReactionService = void 0;
const types_1 = require("./types");
const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 50;
const DEFAULT_MAX_HISTORY_REPLAY = 500;
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2). Only
 * the surface ReactionService actually uses is implemented:
 *   addSubscription, removeSubscription, removeClient, clientsSubscribedTo,
 *   plus Map-compatible has/get/set/delete/size.
 */
class SubscriptionTracker extends Map {
    addSubscription(clientId, channel) {
        let set = this.get(clientId);
        if (!set) {
            set = new Set();
            this.set(clientId, set);
        }
        set.add(channel);
    }
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
    removeClient(clientId) {
        const set = this.get(clientId);
        if (!set)
            return [];
        const channels = Array.from(set);
        this.delete(clientId);
        return channels;
    }
    *clientsSubscribedTo(channel) {
        for (const [clientId, channels] of this.entries()) {
            if (channels.has(channel)) {
                yield clientId;
            }
        }
    }
}
class ReactionService {
    messageRouter;
    logger;
    metricsCollector;
    clientChannels;
    reactionHistory;
    maxHistorySize;
    maxChannelNameLength;
    isDistributed;
    availableReactions;
    authorizeChannel;
    identityResolver;
    onReaction;
    store;
    maxHistoryReplay;
    constructor(opts) {
        if (!opts || !opts.logger) {
            throw new Error('ReactionService: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;
        const config = opts.config ?? {};
        this.maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY;
        this.maxChannelNameLength = config.maxChannelNameLength ?? DEFAULT_MAX_CHANNEL_NAME_LENGTH;
        this.availableReactions = config.availableReactions
            ? { ...config.availableReactions }
            : { ...types_1.DEFAULT_AVAILABLE_REACTIONS };
        this.authorizeChannel = config.authorizeChannel ?? (() => true);
        this.identityResolver = config.identityResolver ?? null;
        this.onReaction = config.onReaction ?? null;
        this.store = config.store ?? null;
        this.maxHistoryReplay = config.maxHistoryReplay ?? DEFAULT_MAX_HISTORY_REPLAY;
        this.clientChannels = new SubscriptionTracker();
        this.reactionHistory = new Map();
        this.isDistributed = !!this.messageRouter;
    }
    /**
     * Discard transient in-memory reaction-aggregator state for a room.
     * Drops the recent-reaction ring for the channel only: stored (targeted)
     * reactions are channel state and outlive whichever node owns the room,
     * so losing ownership must not delete them.
     *
     * Gateway's ownership-cleanup-coordinator (room/Raft eviction) wires
     * this method as the `onLost` handler; here we expose it as a
     * public method so the adapter layer owns the coordinator coupling.
     */
    async cleanupRoom(roomId) {
        if (!roomId)
            return;
        const had = this.reactionHistory.delete(roomId);
        this.logger.info(`reaction-service flushed transient reaction state for roomId ${roomId}` +
            (had ? '' : ' (no state present)'));
    }
    async handleAction(clientId, action, data) {
        try {
            switch (action) {
                case 'subscribe':
                    await this.handleSubscribeToReactions(clientId, data);
                    return;
                case 'unsubscribe':
                    await this.handleUnsubscribeFromReactions(clientId, data);
                    return;
                case 'send':
                    await this.handleSendReaction(clientId, data);
                    return;
                case 'remove':
                    await this.handleRemoveReaction(clientId, data);
                    return;
                case 'getAvailable':
                    await this.handleGetAvailableReactions(clientId);
                    return;
                default:
                    this.sendError(clientId, `Unknown reaction action: ${action}`);
            }
        }
        catch (error) {
            this.logger.error(`Error handling reaction action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
    }
    async handleSubscribeToReactions(clientId, { channel }) {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }
        if (typeof channel !== 'string' || channel.length === 0 || channel.length > this.maxChannelNameLength) {
            this.sendError(clientId, `Channel name must be a string between 1 and ${this.maxChannelNameLength} characters`);
            return;
        }
        try {
            if (!this.authorizeChannel(clientId, channel)) {
                this.sendError(clientId, `Not authorized for channel: ${channel}`);
                return;
            }
            this.clientChannels.addSubscription(clientId, channel);
            if (this.isDistributed && this.messageRouter) {
                await this.messageRouter.subscribeToChannel(clientId, `reactions:${channel}`);
            }
            this.sendSuccess(clientId, 'reaction_subscribed', {
                channel,
                message: `Subscribed to reactions in channel: ${channel}`,
                availableReactions: Object.keys(this.availableReactions),
            });
            // Replay AFTER the ack: the ack says the channel is live, the
            // history says what was already there. A failed read degrades to
            // "no history" rather than failing the subscription — losing the
            // live feed because a table blinked is the worse outcome.
            await this._replayStoredReactions(clientId, channel);
            this.logger.info(`Client ${clientId} subscribed to reactions in channel: ${channel}`);
        }
        catch (error) {
            this.logger.error(`Error subscribing to reactions for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to reactions');
        }
    }
    async handleUnsubscribeFromReactions(clientId, { channel }) {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }
        this.clientChannels.removeSubscription(clientId, channel);
        if (this.isDistributed && this.messageRouter) {
            await this.messageRouter.unsubscribeFromChannel(clientId, `reactions:${channel}`);
        }
        this.sendSuccess(clientId, 'reaction_unsubscribed', {
            channel,
            message: `Unsubscribed from reactions in channel: ${channel}`,
        });
        this.logger.info(`Client ${clientId} unsubscribed from reactions in channel: ${channel}`);
    }
    async handleSendReaction(clientId, { channel, emoji, position = null, metadata = {}, targetId, }) {
        if (!channel || !emoji) {
            this.sendError(clientId, 'Channel and emoji are required');
            return;
        }
        if (!this.availableReactions[emoji]) {
            this.sendError(clientId, 'Invalid emoji reaction');
            return;
        }
        // Sender identity is resolved at send time (never trusted from the
        // frame). A throwing resolver is logged and treated as "no identity".
        const identity = this._resolveIdentity(clientId);
        const reaction = {
            id: this.generateReactionId(),
            clientId,
            channel,
            emoji,
            effect: this.availableReactions[emoji].effect,
            position,
            metadata,
            timestamp: new Date().toISOString(),
        };
        // `targetId` rides the inbound frame top-level (see useReactions) and
        // is carried onto the broadcast verbatim — opaque passthrough.
        if (targetId !== undefined) {
            reaction.targetId = targetId;
        }
        if (identity) {
            if (identity.userId !== undefined)
                reaction.userId = identity.userId;
            if (identity.displayName !== undefined)
                reaction.displayName = identity.displayName;
        }
        // Store-first for TARGETED reactions: a reaction that is fanned out
        // and then fails to persist reads as "it worked" until the reload
        // that loses it. Untargeted (call) reactions never touch the store.
        if (this.store && this._isTargeted(reaction)) {
            if (!reaction.userId) {
                this.sendError(clientId, 'A reaction on a message needs an identified sender; this connection has none');
                return;
            }
            try {
                await this.store.add(this._toStored(reaction));
            }
            catch (err) {
                this.logger.error(`Failed to persist reaction ${reaction.id}:`, err);
                this.sendError(clientId, 'Failed to save reaction');
                return;
            }
        }
        if (!this.reactionHistory.has(channel)) {
            this.reactionHistory.set(channel, []);
        }
        const history = this.reactionHistory.get(channel);
        history.push(reaction);
        if (history.length > this.maxHistorySize) {
            history.shift();
        }
        const reactionMessage = {
            type: 'reaction',
            action: 'reaction_received',
            data: reaction,
        };
        if (this.isDistributed && this.messageRouter) {
            await this.messageRouter.sendToChannel(`reactions:${channel}`, reactionMessage);
        }
        else {
            this.broadcastToLocalChannel(channel, reactionMessage);
        }
        this.sendSuccess(clientId, 'reaction_sent', {
            reactionId: reaction.id,
            emoji,
            channel,
            timestamp: reaction.timestamp,
        });
        // Post-broadcast tap — fire-and-forget; a failing hook never blocks
        // or fails the send path (ack is already on the wire above).
        this._emitReaction(reaction);
        this.logger.info(`Client ${clientId} sent reaction ${emoji} in channel: ${channel}`);
    }
    /**
     * Take back a reaction. Only meaningful for targeted reactions with a
     * store behind them — the floating emoji thrown at a call is an event
     * that already happened and cannot be un-thrown.
     *
     * Removing a reaction that is not there succeeds: two clicks racing on
     * the same chip should settle on "not reacted", not on an error.
     */
    async handleRemoveReaction(clientId, { channel, emoji, targetId }) {
        if (!channel || !emoji) {
            this.sendError(clientId, 'Channel and emoji are required');
            return;
        }
        if (typeof targetId !== 'string' || !targetId) {
            this.sendError(clientId, 'targetId is required to remove a reaction');
            return;
        }
        if (!this.store) {
            this.sendError(clientId, 'Reactions are not removable on this server');
            return;
        }
        const identity = this._resolveIdentity(clientId);
        if (!identity?.userId) {
            this.sendError(clientId, 'A reaction can only be removed by an identified sender');
            return;
        }
        try {
            await this.store.remove({ channel, targetId, emoji, userId: identity.userId });
        }
        catch (err) {
            this.logger.error(`Failed to remove reaction ${emoji} on ${targetId}:`, err);
            this.sendError(clientId, 'Failed to remove reaction');
            return;
        }
        // Drop it from the transient ring too, so getStats and any local
        // replay agree with the store.
        const history = this.reactionHistory.get(channel);
        if (history) {
            const kept = history.filter((r) => !(r.targetId === targetId && r.emoji === emoji && r.userId === identity.userId));
            this.reactionHistory.set(channel, kept);
        }
        const removal = {
            type: 'reaction',
            action: 'reaction_removed',
            data: {
                channel,
                targetId,
                emoji,
                userId: identity.userId,
                timestamp: new Date().toISOString(),
            },
        };
        if (this.isDistributed && this.messageRouter) {
            await this.messageRouter.sendToChannel(`reactions:${channel}`, removal);
        }
        else {
            this.broadcastToLocalChannel(channel, removal);
        }
        // Distinct ack verb: the broadcast already reaches the sender (they
        // are subscribed), and an ack sharing the broadcast's action name
        // would apply the removal twice on the client.
        this.sendSuccess(clientId, 'reaction_unsent', { channel, targetId, emoji });
        this.logger.info(`Client ${clientId} removed reaction ${emoji} on ${targetId} in channel: ${channel}`);
    }
    /** A reaction is durable when it names what it is attached to. */
    _isTargeted(reaction) {
        return typeof reaction.targetId === 'string' && reaction.targetId.length > 0;
    }
    _toStored(reaction) {
        const stored = {
            channel: reaction.channel,
            targetId: reaction.targetId,
            emoji: reaction.emoji,
            userId: reaction.userId,
            timestamp: reaction.timestamp,
        };
        if (reaction.displayName !== undefined)
            stored.displayName = reaction.displayName;
        return stored;
    }
    /**
     * Stored rows are re-broadcast as ordinary Reactions so clients need one
     * inbound shape, not two. The id is derived from the key rather than
     * generated, so replaying twice cannot look like two reactions.
     */
    _fromStored(stored) {
        const catalogEntry = this.availableReactions[stored.emoji];
        const reaction = {
            id: `reaction_${stored.targetId}_${stored.emoji}_${stored.userId}`,
            clientId: stored.userId,
            channel: stored.channel,
            emoji: stored.emoji,
            effect: catalogEntry ? catalogEntry.effect : '',
            position: null,
            metadata: {},
            timestamp: stored.timestamp,
            targetId: stored.targetId,
            userId: stored.userId,
        };
        if (stored.displayName !== undefined)
            reaction.displayName = stored.displayName;
        return reaction;
    }
    async _replayStoredReactions(clientId, channel) {
        if (!this.store)
            return;
        try {
            const stored = await this.store.list(channel, this.maxHistoryReplay);
            this.sendSuccess(clientId, 'reaction_history', {
                channel,
                reactions: stored.map((s) => this._fromStored(s)),
            });
        }
        catch (err) {
            this.logger.error(`Failed to replay reactions for channel ${channel}:`, err);
        }
    }
    /**
     * Resolve the sender identity for a connection, or null. A throwing
     * resolver is logged and treated as "no identity" (mirrors
     * ChatService._resolveIdentity semantics).
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
     * Invoke the configured `onReaction` tap. Sync throws are caught and
     * logged; rejected promises are .catch-ed and logged. Never awaited.
     */
    _emitReaction(reaction) {
        if (!this.onReaction)
            return;
        try {
            const result = this.onReaction(reaction);
            if (result && typeof result.catch === 'function') {
                result.catch((err) => {
                    this.logger.error(`onReaction hook rejected for reaction ${reaction.id}:`, err);
                });
            }
        }
        catch (err) {
            this.logger.error(`onReaction hook threw for reaction ${reaction.id}:`, err);
        }
    }
    async handleGetAvailableReactions(clientId) {
        this.sendSuccess(clientId, 'available_reactions', {
            reactions: this.availableReactions,
        });
    }
    generateReactionId() {
        return `reaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    broadcastToLocalChannel(channel, message) {
        for (const clientId of this.clientChannels.clientsSubscribedTo(channel)) {
            this.sendToClient(clientId, message);
        }
    }
    sendToClient(clientId, message) {
        if (this.messageRouter && this.messageRouter.sendToLocalClient) {
            this.messageRouter.sendToLocalClient(clientId, message);
        }
    }
    sendSuccess(clientId, action, data) {
        this.sendToClient(clientId, {
            type: 'reaction',
            action,
            success: true,
            data,
        });
    }
    sendError(clientId, message, errorCode = types_1.DEFAULT_ERROR_CODE) {
        const errorFrame = {
            type: 'error',
            service: 'reaction',
            error: {
                code: errorCode,
                message,
                timestamp: new Date().toISOString(),
                service: 'reaction',
                clientId,
            },
        };
        this.sendToClient(clientId, errorFrame);
        if (this.metricsCollector) {
            this.metricsCollector.recordError(errorCode);
        }
    }
    /** Cleanup when a client disconnects: drop tracking + downstream unsubs. */
    async handleDisconnect(clientId) {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channel of channels) {
            if (this.isDistributed && this.messageRouter) {
                await this.messageRouter.unsubscribeFromChannel(clientId, `reactions:${channel}`);
            }
        }
        this.logger.debug(`Cleaned up reactions for disconnected client: ${clientId}`);
    }
    getStats() {
        let totalReactions = 0;
        for (const history of this.reactionHistory.values()) {
            totalReactions += history.length;
        }
        return {
            connectedClients: this.clientChannels.size,
            activeChannels: this.reactionHistory.size,
            totalReactions,
            availableReactionsCount: Object.keys(this.availableReactions).length,
        };
    }
}
exports.ReactionService = ReactionService;
exports.default = ReactionService;
//# sourceMappingURL=ReactionService.js.map