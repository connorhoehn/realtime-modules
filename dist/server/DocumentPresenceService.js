"use strict";
// realtime-modules/src/server/DocumentPresenceService.ts
/**
 * Tracks which users are present in which document channels.
 * Maintains a forward index (channel -> clients) and reverse index (client -> channels)
 * for efficient disconnect cleanup. Broadcasts aggregated presence to all clients
 * whenever the map changes.
 *
 * Lift note (CRDT Cut 1): copied verbatim from
 * src/realtime-fanout/crdt/DocumentPresenceService.ts. The `messageRouter`
 * parameter narrows to `MessageRouterContract`. Only the documented
 * surface (getClientData, broadcastToAll) is used. No logic changes.
 */
const PRESENCE_PALETTE = [
    '#e53e3e', '#dd6b20', '#d69e2e', '#38a169',
    '#319795', '#3182ce', '#805ad5', '#d53f8c',
    '#e53e3e', '#c05621', '#b7791f', '#276749',
];
function deriveColor(seed) {
    // djb2 hash — same algorithm as frontend identityToColor()
    let h = 5381;
    for (let i = 0; i < seed.length; i++) {
        h = ((h << 5) + h) ^ seed.charCodeAt(i);
        h = h >>> 0; // keep uint32
    }
    return PRESENCE_PALETTE[h % PRESENCE_PALETTE.length];
}
class DocumentPresenceService {
    messageRouter;
    logger;
    // Map<channelId, Map<clientId, UserInfo>>
    documentPresenceMap;
    // Map<clientId, Set<channelId>> — reverse index for disconnect cleanup
    clientDocChannels;
    /**
     * @param messageRouter - message router for getClientData / broadcastToAll
     * @param logger
     */
    constructor(messageRouter, logger) {
        this.messageRouter = messageRouter;
        this.logger = logger;
        this.documentPresenceMap = new Map();
        this.clientDocChannels = new Map();
    }
    /**
     * Number of doc: channels currently tracking presence. Surfaced via
     * `crdtService.getStats().trackedPresenceChannels`. Was missing pre-fix:
     * the orchestrator read this without the getter existing, so the stat
     * was silently `undefined` (W4C wiring-gap finding).
     */
    get channelCount() {
        return this.documentPresenceMap.size;
    }
    /**
     * Read this connection's identity off the router.
     *
     * `identified` is the load-bearing part. When the connection carries no
     * user context we still need a key, and the clientId is the only one
     * available — but a clientId is a CONNECTION, not a person, and the
     * caller has to be able to tell the difference. Without that flag the
     * fallback is indistinguishable from a real user id, and the dedup in
     * getPresence() cannot collapse two connections belonging to the same
     * human: one arrives as `dev-hank`, the other as a UUID, and the
     * document shows a phantom second editor next to "Hank is editing now".
     */
    _resolve(clientId) {
        const clientData = this.messageRouter.getClientData
            ? this.messageRouter.getClientData(clientId)
            : null;
        const ctx = clientData?.userContext || clientData?.metadata?.userContext || {};
        const resolved = ctx.userId || ctx.sub || undefined;
        const userId = resolved ?? clientId;
        const color = ctx.color || (ctx.email ? deriveColor(ctx.email) : deriveColor(userId));
        // mode is optional editor/reviewer/reader. Sourced from userContext
        // when present (set by the auth pipeline or by a future awareness
        // wiring). If the field carries any other string, drop it — consumers
        // expect a closed enum or absent.
        const VALID_MODES = ['editor', 'reviewer', 'reader'];
        const mode = (typeof ctx.mode === 'string' && VALID_MODES.includes(ctx.mode))
            ? ctx.mode
            : undefined;
        return {
            identity: {
                userId,
                displayName: ctx.displayName || ctx.email || clientId.slice(0, 8),
                color,
            },
            identified: resolved !== undefined,
            mode,
        };
    }
    /**
     * Re-read a client's identity, for an entry that was created before the
     * connection had one.
     *
     * Identity was previously frozen at subscribe time. A client that
     * subscribes to a document during the window where its socket exists but
     * its user context has not been attached yet — a reconnect restoring a
     * clientId, most commonly — stayed anonymous for the whole session, even
     * though the very next frame it sent was fully authenticated. Awareness
     * traffic is continuous on an open document, so re-resolving there costs
     * one map read per frame and closes the window.
     *
     * Returns true when something changed, so the caller can broadcast.
     */
    refreshIdentity(clientId, channel) {
        const existing = this.documentPresenceMap.get(channel)?.get(clientId);
        // Already a person: nothing to upgrade to, and re-reading would let a
        // later empty context downgrade a good entry.
        if (!existing || existing.userId !== clientId)
            return false;
        const { identity, identified } = this._resolve(clientId);
        if (!identified)
            return false;
        Object.assign(existing, identity);
        this.broadcastPresence();
        return true;
    }
    /**
     * Add a client to the document presence map for a doc: channel.
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     * @param channel
     */
    addClient(clientId, channel) {
        if (!channel.startsWith('doc:'))
            return;
        const { identity, mode } = this._resolve(clientId);
        const userInfo = {
            ...identity,
            idle: false,
            ...(mode ? { mode } : {}),
        };
        // Add to documentPresenceMap
        if (!this.documentPresenceMap.has(channel)) {
            this.documentPresenceMap.set(channel, new Map());
        }
        this.documentPresenceMap.get(channel).set(clientId, userInfo);
        // Update reverse index
        if (!this.clientDocChannels.has(clientId)) {
            this.clientDocChannels.set(clientId, new Set());
        }
        this.clientDocChannels.get(clientId).add(channel);
        // Broadcast updated presence
        this.broadcastPresence();
    }
    /**
     * Remove a client from a specific doc: channel's presence map.
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     * @param channel
     */
    removeClient(clientId, channel) {
        if (!channel.startsWith('doc:'))
            return;
        const channelMap = this.documentPresenceMap.get(channel);
        if (channelMap) {
            channelMap.delete(clientId);
            if (channelMap.size === 0) {
                this.documentPresenceMap.delete(channel);
            }
        }
        // Update reverse index
        const channels = this.clientDocChannels.get(clientId);
        if (channels) {
            channels.delete(channel);
            if (channels.size === 0) {
                this.clientDocChannels.delete(clientId);
            }
        }
        // Broadcast updated presence
        this.broadcastPresence();
    }
    /**
     * Remove a client from ALL document presence maps (on disconnect).
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     */
    removeAllForClient(clientId) {
        const channels = this.clientDocChannels.get(clientId);
        if (!channels || channels.size === 0)
            return;
        for (const channel of channels) {
            const channelMap = this.documentPresenceMap.get(channel);
            if (channelMap) {
                channelMap.delete(clientId);
                if (channelMap.size === 0) {
                    this.documentPresenceMap.delete(channel);
                }
            }
        }
        this.clientDocChannels.delete(clientId);
        // Broadcast updated presence
        this.broadcastPresence();
    }
    /**
     * Check whether a client is tracked in a given channel.
     *
     * @param clientId
     * @param channel
     * @returns boolean
     */
    hasClient(clientId, channel) {
        const channelMap = this.documentPresenceMap.get(channel);
        return !!(channelMap && channelMap.has(clientId));
    }
    /**
     * Update a client's idle state in a channel. Returns true if changed.
     *
     * @param clientId
     * @param channel
     * @param idle
     * @returns whether the value changed
     */
    setIdle(clientId, channel, idle) {
        const channelMap = this.documentPresenceMap.get(channel);
        if (!channelMap)
            return false;
        const userInfo = channelMap.get(clientId);
        if (!userInfo || userInfo.idle === idle)
            return false;
        userInfo.idle = idle;
        // Push the change to listening clients (the /documents list page
        // would otherwise sit on a stale idle reading until the next
        // join/leave event re-broadcasts).
        this.broadcastPresence();
        return true;
    }
    /**
     * Update a client's mode (editor/reviewer/reader) in a channel.
     * Returns true if changed. Broadcasts on change so the /documents
     * list page mode badge updates live. Passing undefined or a
     * non-enum string clears the mode for this client.
     *
     * @param clientId
     * @param channel
     * @param mode  'editor' | 'reviewer' | 'reader' | undefined to clear
     * @returns whether the value changed
     */
    setMode(clientId, channel, mode) {
        const VALID_MODES = ['editor', 'reviewer', 'reader'];
        const next = (typeof mode === 'string' && VALID_MODES.includes(mode))
            ? mode
            : undefined;
        const channelMap = this.documentPresenceMap.get(channel);
        if (!channelMap)
            return false;
        const userInfo = channelMap.get(clientId);
        if (!userInfo)
            return false;
        if (userInfo.mode === next)
            return false;
        if (next === undefined)
            delete userInfo.mode;
        else
            userInfo.mode = next;
        this.broadcastPresence();
        return true;
    }
    /**
     * Return the raw presence map (for use in handleGetDocumentPresence).
     * @returns Map<string, Map<string, UserInfo>>
     */
    getPresence() {
        return this.documentPresenceMap;
    }
    /**
     * Build and broadcast a documents:presence message to all connected clients.
     * Format: { type: 'documents:presence', documents: [{ documentId, users }] }
     */
    /**
     * Presence as PEOPLE rather than connections: one row per user, per
     * document.
     *
     * Every consumer wants this shape — a document with one person in two
     * tabs has one person in it — and the raw map is keyed by clientId. This
     * used to be inlined in broadcastPresence(), so the pushed presence
     * collapsed the tabs and the polled `getDocumentPresence` reply did not:
     * the same document reported one editor or two depending on which path
     * the client happened to be on.
     */
    getPresenceByUser() {
        const out = new Map();
        for (const [channelId, usersMap] of this.documentPresenceMap) {
            const usersByUserId = new Map();
            for (const userInfo of usersMap.values()) {
                // Keep the most recent entry per userId (last write wins for idle)
                const existing = usersByUserId.get(userInfo.userId);
                if (!existing || (!userInfo.idle && existing.idle)) {
                    usersByUserId.set(userInfo.userId, userInfo);
                }
            }
            out.set(channelId, Array.from(usersByUserId.values()));
        }
        return out;
    }
    broadcastPresence() {
        const documents = [];
        for (const [channelId, users] of this.getPresenceByUser()) {
            documents.push({ documentId: channelId, users });
        }
        const message = {
            type: 'documents:presence',
            documents,
            timestamp: new Date().toISOString(),
        };
        // Broadcast to all connected clients across all nodes
        if (this.messageRouter) {
            this.messageRouter.broadcastToAll(message);
        }
    }
}
module.exports = DocumentPresenceService;
//# sourceMappingURL=DocumentPresenceService.js.map