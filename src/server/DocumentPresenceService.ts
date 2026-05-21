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

import type { MessageRouterContract } from './stores/MessageRouterContract';

interface UserInfo {
    userId: string;
    displayName: string;
    color: string;
    idle: boolean;
}

// The real (gateway) MessageRouter returns a richer client-data shape with
// `userContext` (and possibly metadata.userContext). The contract narrows
// to optional getClientData; cast through any here so the lifted code can
// keep its existing field reads without widening the contract surface.
type AnyClientData = any;

class DocumentPresenceService {
    private messageRouter: MessageRouterContract;
    private logger: any;
    // Map<channelId, Map<clientId, UserInfo>>
    documentPresenceMap: Map<string, Map<string, UserInfo>>;
    // Map<clientId, Set<channelId>> — reverse index for disconnect cleanup
    clientDocChannels: Map<string, Set<string>>;

    /**
     * @param messageRouter - message router for getClientData / broadcastToAll
     * @param logger
     */
    constructor(messageRouter: MessageRouterContract, logger: any) {
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
    get channelCount(): number {
        return this.documentPresenceMap.size;
    }

    /**
     * Add a client to the document presence map for a doc: channel.
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     * @param channel
     */
    addClient(clientId: string, channel: string): void {
        if (!channel.startsWith('doc:')) return;

        const clientData: AnyClientData = this.messageRouter.getClientData
            ? this.messageRouter.getClientData(clientId)
            : null;
        const ctx = clientData?.userContext || clientData?.metadata?.userContext || {};

        const userInfo: UserInfo = {
            userId: ctx.userId || ctx.sub || clientId,
            displayName: ctx.displayName || ctx.email || clientId.slice(0, 8),
            color: ctx.color || '#3b82f6',
            idle: false,
        };

        // Add to documentPresenceMap
        if (!this.documentPresenceMap.has(channel)) {
            this.documentPresenceMap.set(channel, new Map());
        }
        this.documentPresenceMap.get(channel)!.set(clientId, userInfo);

        // Update reverse index
        if (!this.clientDocChannels.has(clientId)) {
            this.clientDocChannels.set(clientId, new Set());
        }
        this.clientDocChannels.get(clientId)!.add(channel);

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
    removeClient(clientId: string, channel: string): void {
        if (!channel.startsWith('doc:')) return;

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
    removeAllForClient(clientId: string): void {
        const channels = this.clientDocChannels.get(clientId);
        if (!channels || channels.size === 0) return;

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
    hasClient(clientId: string, channel: string): boolean {
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
    setIdle(clientId: string, channel: string, idle: boolean): boolean {
        const channelMap = this.documentPresenceMap.get(channel);
        if (!channelMap) return false;
        const userInfo = channelMap.get(clientId);
        if (!userInfo || userInfo.idle === idle) return false;
        userInfo.idle = idle;
        return true;
    }

    /**
     * Return the raw presence map (for use in handleGetDocumentPresence).
     * @returns Map<string, Map<string, UserInfo>>
     */
    getPresence(): Map<string, Map<string, UserInfo>> {
        return this.documentPresenceMap;
    }

    /**
     * Build and broadcast a documents:presence message to all connected clients.
     * Format: { type: 'documents:presence', documents: [{ documentId, users }] }
     */
    broadcastPresence(): void {
        const documents: Array<{ documentId: string; users: UserInfo[] }> = [];

        for (const [channelId, usersMap] of this.documentPresenceMap) {
            // Deduplicate by userId (same user could have multiple tabs)
            const usersByUserId = new Map<string, UserInfo>();
            for (const userInfo of usersMap.values()) {
                // Keep the most recent entry per userId (last write wins for idle)
                const existing = usersByUserId.get(userInfo.userId);
                if (!existing || (!userInfo.idle && existing.idle)) {
                    usersByUserId.set(userInfo.userId, userInfo);
                }
            }

            documents.push({
                documentId: channelId,
                users: Array.from(usersByUserId.values()),
            });
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

export = DocumentPresenceService;
