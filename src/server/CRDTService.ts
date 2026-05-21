// realtime-modules/src/server/CRDTService.ts
/**
 * CRDT Service — slim orchestrator that delegates to extracted sub-modules.
 *
 * Lift note (CRDT Cut 1): adapted verbatim from
 * src/realtime-fanout/crdt-service.ts (gateway origin). Logic-changes
 * vs. the gateway original are isolated to the constructor wiring:
 *
 *   - The `(messageRouter, logger, metricsCollector, redisClient,
 *     dynamoClient)` positional ctor is replaced with a single
 *     options-bag ctor that takes the three stores
 *     (`snapshotStore`, `metadataStore`, `hotCache`) and a
 *     `MessageRouterContract`. Gateway-specific AWS-SDK / Redis client
 *     wiring is gone — the adapters own that.
 *   - The `enforceChannelPermission` import (which lives in the
 *     gateway's authz middleware) becomes an optional `authz` hook on
 *     the options bag. Defaults to a permissive pass-through so the
 *     lifted module is usable in tests / zero-config consumers.
 *   - `ErrorCodes` / `createErrorResponse` from gateway/utils are
 *     inlined as minimal constants so the lifted module has no
 *     gateway-source imports.
 *
 * Everything else — handleAction dispatch, hydration flow, R2 bug #7
 * remote-update buffering, operation coalescer, periodic snapshot sweep,
 * shutdown — is preserved verbatim.
 */

import * as Y from 'yjs';
const { mergeUpdates } = Y;
import { UpdateCoalescer, PeriodicSweep } from 'distributed-core';

import DocumentMetadataService from './DocumentMetadataService';
import SnapshotManager from './SnapshotManager';
import AwarenessCoalescer from './AwarenessCoalescer';
import DocumentPresenceService from './DocumentPresenceService';
import IdleEvictionManager from './IdleEvictionManager';
import * as config from './config';

import type { HotCache, SnapshotStore } from './stores/SnapshotStore';
import type { MetadataStore } from './stores/MetadataStore';
import type { MessageRouterContract } from './stores/MessageRouterContract';

// ---- Inlined error-code helpers (gateway/utils replacement) ---------------

const ErrorCodes = {
    SERVICE_INTERNAL_ERROR: 'SERVICE_INTERNAL_ERROR',
    AUTH_FAILED: 'AUTH_FAILED',
} as const;

function createErrorResponse(code: string, message: string, context: Record<string, any> = {}): { error: Record<string, any> } {
    return { error: { code, message, ...context } };
}

// ---- Internal types --------------------------------------------------------

interface ChannelState {
    ydoc: Y.Doc;
    operationsSinceSnapshot: number;
    subscriberCount: number;
    hydrated: boolean;
}

// The orchestrator uses a slightly wider MessageRouter surface than
// MessageRouterContract — it also calls subscribeToChannel /
// unsubscribeFromChannel / sendToClient. These extras are gateway-specific
// (chat/presence/etc. share the same router) so we widen the constructor
// parameter via this orchestrator-local extension type.
export interface OrchestratorMessageRouter extends MessageRouterContract {
    subscribeToChannel?(clientId: string, channel: string): Promise<void> | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    sendToClient?(clientId: string, message: any): void;
}

export interface CRDTServiceOpts {
    messageRouter: OrchestratorMessageRouter;
    snapshotStore: SnapshotStore;
    metadataStore: MetadataStore;
    hotCache?: HotCache | null;
    logger: any;
    metricsCollector?: any;
    /**
     * Optional authz hook. Returns true if the client is permitted to access
     * the channel; false (after sending its own error message) otherwise.
     * Defaults to permissive.
     */
    authz?: (clientId: string, channel: string, service: CRDTService) => boolean;
}

class CRDTService {
    messageRouter: OrchestratorMessageRouter;
    logger: any;
    metricsCollector: any;
    channelStates: Map<string, ChannelState>;
    pendingRemoteUpdates: Map<string, Uint8Array[]>;
    PENDING_REMOTE_UPDATES_CAP: number;
    operationCoalescer: any;
    metadataService: DocumentMetadataService;
    snapshotManager: SnapshotManager;
    awarenessCoalescer: AwarenessCoalescer;
    presenceService: DocumentPresenceService;
    evictionManager: IdleEvictionManager;
    _evictionCallback: (channel: string) => Promise<void>;
    private readonly _snapshotSweep: PeriodicSweep;
    private _authz: (clientId: string, channel: string, service: CRDTService) => boolean;

    constructor(opts: CRDTServiceOpts) {
        const { messageRouter, snapshotStore, metadataStore, hotCache, logger, metricsCollector, authz } = opts;

        this.messageRouter = messageRouter;
        this.logger = logger;
        this.metricsCollector = metricsCollector || null;
        this._authz = authz || (() => true);

        // ---------------------------------------------------------------
        // Core state — stays in orchestrator (handlers need direct access)
        // ---------------------------------------------------------------
        this.channelStates = new Map();

        // R2 bug #7: Buffer for remote crdt:update frames that arrive before
        // local hydration completes.
        this.pendingRemoteUpdates = new Map();
        this.PENDING_REMOTE_UPDATES_CAP = 100;

        // Operation batching: DC's UpdateCoalescer drives the per-channel
        // window timer; `merge` hook squashes buffered Y.js updates into one
        // payload.
        this.operationCoalescer = new UpdateCoalescer({
            windowMs: config.OPERATION_BATCH_WINDOW_MS,
            merge: (items: any[]) => {
                if (items.length === 1) return items;
                const buffers = items.map((it: any) => new Uint8Array(Buffer.from(it.update, 'base64')));
                return [{
                    update: Buffer.from(mergeUpdates(buffers)).toString('base64'),
                    senderClientId: items[0].senderClientId,
                    count: items.length,
                }];
            },
            onFlush: (channel: string, items: any[]) => this._broadcastCoalescedOps(channel, items),
        });

        // ---------------------------------------------------------------
        // Sub-services
        // ---------------------------------------------------------------
        this.metadataService = new DocumentMetadataService({
            metadataStore,
            logger: this.logger,
            messageRouter: this.messageRouter,
        });

        this.snapshotManager = new SnapshotManager({
            snapshotStore,
            hotCache: hotCache || null,
            logger: this.logger,
            getChannelState: (ch: string) => this.channelStates.get(ch),
        });

        this.awarenessCoalescer = new AwarenessCoalescer(this.messageRouter, this.logger);

        this.presenceService = new DocumentPresenceService(this.messageRouter, this.logger);

        this.evictionManager = new IdleEvictionManager(this.logger, config);
        // Eviction callback: when the eviction timer fires, flush snapshot + destroy Y.Doc
        this._evictionCallback = async (channel: string) => {
            const state = this.channelStates.get(channel);
            if (!state) return;
            if (state.subscriberCount > 0) return; // someone re-joined during grace period

            if (state.operationsSinceSnapshot > 0) {
                await this.snapshotManager.writeSnapshot(channel);
                this.logger.info(`Final snapshot written before evicting Y.Doc for channel ${channel}`);
            }
            if (state.ydoc) state.ydoc.destroy();
            this.channelStates.delete(channel);
            this.pendingRemoteUpdates.delete(channel);
            this.snapshotManager.cancelDebouncedSnapshot(channel);
            this.logger.info(`Y.Doc evicted for idle channel ${channel}`);
        };

        // ---------------------------------------------------------------
        // Periodic snapshot sweep
        // ---------------------------------------------------------------
        this._snapshotSweep = new PeriodicSweep({
            intervalMs: config.SNAPSHOT_INTERVAL_MS,
            fn: () => this._writePeriodicSnapshots(),
            onError: (err) => this.logger.error('Periodic snapshot sweep error', err),
        });
        this._snapshotSweep.start();
        this.logger.info(`Periodic snapshots every ${config.SNAPSHOT_INTERVAL_MS / 1000}s`);

        // ---------------------------------------------------------------
        // Cross-node sync interceptor
        // ---------------------------------------------------------------
        if (this.messageRouter && typeof this.messageRouter.onRemoteChannelMessage === 'function') {
            // MessageRouterContract narrows the handler to a single payload
            // arg, but the legacy gateway router passes (channel, message,
            // fromNode). Support both by sniffing the call shape.
            this.messageRouter.onRemoteChannelMessage('crdt-sync', (...args: any[]) => {
                let channel: string;
                let message: any;
                if (args.length >= 2) {
                    // Legacy gateway-router 3-arg shape: (channel, message, fromNode)
                    channel = args[0];
                    message = args[1];
                } else {
                    // MessageRouterContract single-payload shape: { channel, message }
                    const payload = args[0] || {};
                    channel = payload.channel;
                    message = payload.message;
                }
                if (message && message.type === 'crdt:update' && message.update) {
                    let updateBytes: Uint8Array;
                    try {
                        updateBytes = new Uint8Array(Buffer.from(message.update, 'base64'));
                    } catch (err: any) {
                        this.logger.error(`Malformed remote CRDT update for ${channel}:`, err.message);
                        return;
                    }

                    const state = this.channelStates.get(channel);
                    if (state && state.ydoc && state.hydrated) {
                        this._applyRemoteUpdate(channel, state, updateBytes);
                    } else {
                        // R2 bug #7: state is missing or hydrate is in flight —
                        // buffer the update so it doesn't get silently dropped.
                        this._bufferRemoteUpdate(channel, updateBytes);
                    }
                }
            });
        }
    }

    // ===================================================================
    // Remote update buffering (R2 bug #7)
    // ===================================================================

    _applyRemoteUpdate(channel: string, state: ChannelState, updateBytes: Uint8Array): void {
        try {
            Y.applyUpdate(state.ydoc, updateBytes);
            state.operationsSinceSnapshot++;
            this.snapshotManager.scheduleDebouncedSnapshot(channel);
            this.logger.debug(`Applied remote CRDT update to local Y.Doc for channel ${channel}`);
        } catch (err: any) {
            this.logger.error(`Failed to apply remote CRDT update for ${channel}:`, err.message);
        }
    }

    _bufferRemoteUpdate(channel: string, updateBytes: Uint8Array): void {
        let buf = this.pendingRemoteUpdates.get(channel);
        if (!buf) {
            buf = [];
            this.pendingRemoteUpdates.set(channel, buf);
        }
        if (buf.length >= this.PENDING_REMOTE_UPDATES_CAP) {
            buf.shift();
            this.logger.warn(
                `Pending remote-update buffer for ${channel} exceeded cap ` +
                `(${this.PENDING_REMOTE_UPDATES_CAP}); dropping oldest. ` +
                `Hydrate may be stuck.`
            );
        }
        buf.push(updateBytes);
    }

    _drainPendingRemoteUpdates(channel: string, state: ChannelState): number {
        const buf = this.pendingRemoteUpdates.get(channel);
        if (!buf || buf.length === 0) {
            this.pendingRemoteUpdates.delete(channel);
            return 0;
        }
        this.pendingRemoteUpdates.delete(channel);
        for (const updateBytes of buf) {
            this._applyRemoteUpdate(channel, state, updateBytes);
        }
        this.logger.info(
            `Drained ${buf.length} buffered remote CRDT update(s) for channel ${channel}`
        );
        return buf.length;
    }

    // ===================================================================
    // Action dispatch
    // ===================================================================

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        const startTime = Date.now();
        try {
            switch (action) {
                case 'subscribe':
                    return await this.handleSubscribe(clientId, data);
                case 'update':
                    return await this.handleUpdate(clientId, data);
                case 'unsubscribe':
                    return await this.handleUnsubscribe(clientId, data);
                case 'getSnapshot':
                    return await this.handleGetSnapshot(clientId, data);
                case 'awareness':
                    return await this.handleAwareness(clientId, data);

                case 'listSnapshots': {
                    const snapshots = await this.snapshotManager.handleListSnapshots(data.channel, data.limit || 20);
                    this.sendToClient(clientId, { type: 'crdt', action: 'snapshotList', channel: data.channel, snapshots });
                    return;
                }
                case 'getSnapshotAtVersion': {
                    const result = await this.snapshotManager.handleGetSnapshotAtVersion(data.channel, data.timestamp);
                    if (result) {
                        this.sendToClient(clientId, { type: 'crdt', action: 'snapshot', channel: data.channel, version: true, update: result.base64, timestamp: result.timestamp });
                    } else {
                        this.sendError(clientId, 'Snapshot not found');
                    }
                    return;
                }
                case 'restoreSnapshot': {
                    if (!this._requireAuth(clientId, 'restoreSnapshot')) return;
                    try {
                        this.logger.info(`Restore requested for channel=${data.channel}, timestamp=${data.timestamp}`);
                        const restored = await this.snapshotManager.handleRestoreSnapshot(data.channel, data.timestamp);
                        if (restored) {
                            await this.messageRouter.sendToChannel(data.channel, {
                                type: 'crdt:doc-replaced', channel: data.channel, snapshot: restored.base64State
                            });
                            this.sendToClient(clientId, { type: 'crdt', action: 'snapshotRestored', channel: data.channel, timestamp: restored.restoredTimestamp });
                            this.logger.info(`Restore complete for channel=${data.channel}`);
                        } else {
                            this.logger.warn(`Restore failed: snapshot not found for channel=${data.channel}, timestamp=${data.timestamp}`);
                            this.sendError(clientId, 'Snapshot not found or restore failed');
                        }
                    } catch (restoreErr: any) {
                        this.logger.error(`Restore error for channel=${data.channel}:`, restoreErr.message);
                        this.sendError(clientId, 'Restore failed: ' + restoreErr.message);
                    }
                    return;
                }
                case 'clearDocument':
                    if (!this._requireAuth(clientId, 'clearDocument')) return;
                    return await this.snapshotManager.handleClearDocument(clientId, data,
                        this.channelStates,
                        (cid: string, msg: any) => this.sendToClient(cid, msg),
                        (cid: string, msg: string) => this.sendError(cid, msg));
                case 'saveVersion': {
                    const saved = await this.snapshotManager.handleSaveVersion(data.channel, data.name, clientId);
                    if (saved) {
                        this.sendToClient(clientId, { type: 'crdt', action: 'versionSaved', channel: data.channel, name: saved.name, timestamp: saved.timestamp });
                    } else {
                        this.sendError(clientId, 'Failed to save version');
                    }
                    return;
                }

                case 'listDocuments': {
                    const docs = await this.metadataService.handleListDocuments();
                    this.sendToClient(clientId, { type: 'crdt', action: 'documentList', documents: docs });
                    return;
                }
                case 'createDocument': {
                    const clientData = this.messageRouter.getClientData ? this.messageRouter.getClientData(clientId) : null;
                    const userContext = (clientData as any)?.userContext || {};
                    const doc = await this.metadataService.handleCreateDocument({
                        meta: data.meta,
                        createdBy: userContext.userId || clientId,
                        createdByName: userContext.displayName || userContext.email || null,
                    });
                    await this.messageRouter.broadcastToAll({ type: 'crdt', action: 'documentCreated', document: doc });
                    return;
                }
                case 'deleteDocument': {
                    if (!this._requireAuth(clientId, 'deleteDocument')) return;
                    const docId = data.documentId;
                    await this.metadataService.handleDeleteDocument(docId);
                    const channel = `doc:${docId}`;
                    const state = this.channelStates.get(channel);
                    if (state) {
                        if (state.ydoc) state.ydoc.destroy();
                        this.channelStates.delete(channel);
                        this.pendingRemoteUpdates.delete(channel);
                        this.snapshotManager.cancelDebouncedSnapshot(channel);
                    }
                    await this.messageRouter.broadcastToAll({ type: 'crdt', action: 'documentDeleted', documentId: docId });
                    return;
                }
                case 'updateDocumentMeta': {
                    const updated = await this.metadataService.handleUpdateDocumentMeta(data.documentId, data.meta);
                    await this.messageRouter.broadcastToAll({ type: 'crdt', action: 'documentMetaUpdated', documentId: data.documentId, meta: updated });
                    return;
                }

                case 'deduplicateSections': {
                    const channel = `doc:${data.documentId}`;
                    const state = this.channelStates.get(channel);
                    if (!state || !state.ydoc) {
                        this.sendToClient(clientId, { type: 'crdt', action: 'error', error: 'Document not loaded' });
                        return;
                    }
                    const ySections = state.ydoc.getArray('sections');
                    const seen = new Set<string>();
                    const toRemove: number[] = [];
                    for (let i = 0; i < ySections.length; i++) {
                        const section = ySections.get(i);
                        const title = section instanceof Y.Map ? section.get('title') : null;
                        if (!title) continue;
                        if (seen.has(title as string)) {
                            toRemove.push(i);
                        } else {
                            seen.add(title as string);
                        }
                    }
                    state.ydoc.transact(() => {
                        for (let i = toRemove.length - 1; i >= 0; i--) {
                            ySections.delete(toRemove[i], 1);
                        }
                    });
                    this.logger.info(`Deduplicated ${toRemove.length} sections from ${data.documentId}`);
                    this.sendToClient(clientId, {
                        type: 'crdt',
                        action: 'deduplicateResult',
                        documentId: data.documentId,
                        removed: toRemove.length
                    });
                    return;
                }

                case 'getDocumentPresence': {
                    const presence: Record<string, any[]> = {};
                    const presenceMap = this.presenceService.getPresence();
                    for (const [ch, usersMap] of presenceMap) {
                        const users = Array.from(usersMap.values());
                        if (users.length > 0) presence[ch] = users;
                    }
                    this.sendToClient(clientId, { type: 'crdt', action: 'documentPresence', presence });
                    return;
                }

                default:
                    this.sendError(clientId, `Unknown CRDT action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`Error handling CRDT action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        } finally {
            const duration = Date.now() - startTime;
            this.logger.info(`[crdt] ${action}`, { clientId, channel: data.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: crdt/${action} took ${duration}ms`, { clientId });
            }
        }
    }

    // ===================================================================
    // handleSubscribe — channel state init, Y.Doc hydration, subscriber mgmt
    // ===================================================================

    async handleSubscribe(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!this._validateChannel(channel)) {
            this.sendError(clientId, 'Channel name must be a string between 1 and 50 characters');
            return;
        }

        try {
            // Auth check via injectable authz hook
            if (!this._authz(clientId, channel, this)) {
                return;
            }

            if (this.messageRouter.subscribeToChannel) {
                await this.messageRouter.subscribeToChannel(clientId, channel);
            }

            this.evictionManager.cancelEviction(channel);

            let state = this.channelStates.get(channel);
            if (!state) {
                state = { ydoc: new Y.Doc(), operationsSinceSnapshot: 0, subscriberCount: 0, hydrated: false };
                this.channelStates.set(channel, state);

                try {
                    await this.snapshotManager.hydrateYDoc(channel, state);
                } finally {
                    state.hydrated = true;
                    this._drainPendingRemoteUpdates(channel, state);
                }
            }
            state.subscriberCount++;

            this.sendToClient(clientId, {
                type: 'crdt',
                action: 'subscribed',
                channel,
                timestamp: new Date().toISOString()
            });

            try {
                const stateUpdate = Y.encodeStateAsUpdate(state.ydoc);
                if (stateUpdate.byteLength > 0) {
                    this.sendToClient(clientId, {
                        type: 'crdt:snapshot',
                        channel,
                        snapshot: Buffer.from(stateUpdate).toString('base64'),
                        timestamp: new Date().toISOString(),
                    });
                    this.logger.info(`Y.Doc state pushed to client ${clientId} for channel ${channel}`);
                }
            } catch (syncError: any) {
                this.logger.error(`Failed to push Y.Doc state for ${channel} to ${clientId}:`, syncError.message);
            }

            this.presenceService.addClient(clientId, channel);

            this.logger.info(`Client ${clientId} subscribed to CRDT channel: ${channel}`);
        } catch (error) {
            this.logger.error(`Error subscribing to channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to channel');
        }
    }

    // ===================================================================
    // handleUpdate — apply Y.js update, batch operations, broadcast
    // ===================================================================

    async handleUpdate(clientId: string, { channel, update }: { channel: string; update: string }): Promise<void> {
        if (!this._validateChannel(channel)) {
            this.sendError(clientId, 'Channel name must be a string between 1 and 50 characters');
            return;
        }
        if (!update || typeof update !== 'string') {
            this.sendError(clientId, 'Update payload must be a base64 string');
            return;
        }

        try {
            let state = this.channelStates.get(channel);
            if (!state) {
                state = { ydoc: new Y.Doc(), operationsSinceSnapshot: 0, subscriberCount: 0, hydrated: true };
                this.channelStates.set(channel, state);
                this._drainPendingRemoteUpdates(channel, state);
            }

            const updateBytes = new Uint8Array(Buffer.from(update, 'base64'));
            Y.applyUpdate(state.ydoc, updateBytes);
            state.operationsSinceSnapshot++;

            if (state.operationsSinceSnapshot >= config.OPERATIONS_BEFORE_SNAPSHOT) {
                await this.snapshotManager.writeSnapshot(channel);
            } else {
                this.snapshotManager.scheduleDebouncedSnapshot(channel);
            }

            const latestState = Y.encodeStateAsUpdate(state.ydoc);
            if (latestState.byteLength > 0) {
                this.snapshotManager.saveSnapshotToRedis(channel, Buffer.from(latestState).toString('base64'))
                    .catch((err: any) => this.logger.error(`Non-blocking hot-cache update failed for ${channel}:`, err.message));
            }

            this.operationCoalescer.buffer(channel, { update, senderClientId: clientId });

            this.logger.debug(`CRDT update batched for channel ${channel} from client ${clientId}`);
        } catch (error) {
            this.logger.error(`Error handling CRDT update for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to process CRDT update');
        }
    }

    // ===================================================================
    // handleUnsubscribe — decrement subscribers, cleanup
    // ===================================================================

    async handleUnsubscribe(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        try {
            const state = this.channelStates.get(channel);
            if (state) {
                state.subscriberCount--;
                if (state.subscriberCount <= 0) {
                    state.subscriberCount = 0;
                    if (state.operationsSinceSnapshot > 0) {
                        await this.snapshotManager.writeSnapshot(channel);
                    }
                    this.evictionManager.startEviction(channel, this._evictionCallback);
                }
            }

            if (this.messageRouter.unsubscribeFromChannel) {
                await this.messageRouter.unsubscribeFromChannel(clientId, channel);
            }
            this.presenceService.removeClient(clientId, channel);

            this.sendToClient(clientId, {
                type: 'crdt',
                action: 'unsubscribed',
                channel,
                timestamp: new Date().toISOString()
            });

            this.logger.info(`Client ${clientId} unsubscribed from CRDT channel: ${channel}`);
        } catch (error) {
            this.logger.error(`Error unsubscribing from channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to unsubscribe from channel');
        }
    }

    // ===================================================================
    // handleGetSnapshot — auth check + delegate to SnapshotManager
    // ===================================================================

    async handleGetSnapshot(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel || typeof channel !== 'string') {
            this.sendError(clientId, 'Channel name is required');
            return;
        }

        try {
            if (!this._authz(clientId, channel, this)) {
                return;
            }

            const snapshot = await this.snapshotManager.retrieveLatestSnapshot(channel);

            this.sendToClient(clientId, {
                type: 'crdt:snapshot',
                channel,
                snapshot: snapshot.data,
                timestamp: snapshot.timestamp,
                age: snapshot.timestamp ? Date.now() - snapshot.timestamp : null
            });

            this.logger.debug(`Snapshot retrieved for channel ${channel}, timestamp: ${snapshot.timestamp}`);
        } catch (error) {
            this.logger.error(`Error handling getSnapshot for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to retrieve snapshot');
        }
    }

    // ===================================================================
    // handleAwareness — delegate to AwarenessCoalescer + presence backfill
    // ===================================================================

    async handleAwareness(clientId: string, { channel, update, idle }: { channel: string; update: string; idle?: boolean }): Promise<void> {
        this.logger.info(`[awareness-entry] client=${clientId} channel=${channel} hasUpdate=${!!update} idle=${idle} isDoc=${channel?.startsWith?.('doc:')}`);

        if (!this._validateChannel(channel)) {
            this.sendError(clientId, 'Channel name must be a string between 1 and 50 characters');
            return;
        }
        if (!update || typeof update !== 'string') {
            this.sendError(clientId, 'Awareness update must be a base64 string');
            return;
        }

        try {
            if (channel.startsWith('doc:')) {
                if (!this.presenceService.hasClient(clientId, channel)) {
                    this.logger.info(`[presence-backfill] Adding ${clientId} to presence for ${channel}`);
                    this.presenceService.addClient(clientId, channel);
                }

                if (typeof idle === 'boolean') {
                    this.presenceService.setIdle(clientId, channel, idle);
                }
            }

            this.awarenessCoalescer.bufferUpdate(clientId, channel, update);

            this.logger.debug(`Awareness buffered for channel ${channel} from client ${clientId}`);
        } catch (error) {
            this.logger.error(`Error buffering awareness for channel ${channel}:`, error);
        }
    }

    // ===================================================================
    // onClientDisconnect
    // ===================================================================

    async handleDisconnect(clientId: string): Promise<void> {
        return this.onClientDisconnect(clientId);
    }

    async onClientDisconnect(clientId: string): Promise<void> {
        const clientData: any = this.messageRouter?.getClientData ? this.messageRouter.getClientData(clientId) : null;
        if (clientData && clientData.channels) {
            for (const channel of clientData.channels) {
                const state = this.channelStates.get(channel);
                if (state) {
                    state.subscriberCount--;
                    if (state.subscriberCount <= 0) {
                        state.subscriberCount = 0;
                        if (state.operationsSinceSnapshot > 0) {
                            try {
                                await this.snapshotManager.writeSnapshot(channel);
                            } catch (err: any) {
                                this.logger.error(`Error writing snapshot on disconnect for channel ${channel}:`, err.message);
                            }
                        }
                        this.evictionManager.startEviction(channel, this._evictionCallback);
                    }
                }
            }
        }

        this.presenceService.removeAllForClient(clientId);
        this.awarenessCoalescer.removeClient(clientId);

        this.logger.debug(`Client ${clientId} disconnected from CRDT service`);
    }

    async _broadcastCoalescedOps(channel: string, items: any[]): Promise<void> {
        if (!items || items.length === 0) return;
        const { update, count } = items[0];
        try {
            await this.messageRouter.sendToChannel(channel, {
                type: 'crdt:update', channel, update,
            });
            this.logger.debug(`Broadcasted ${count || 1} CRDT operation(s) for channel ${channel}`);
        } catch (error) {
            this.logger.error(`Error broadcasting CRDT operations for channel ${channel}:`, error);
        }
    }

    // ===================================================================
    // Periodic snapshot sweep
    // ===================================================================

    async _writePeriodicSnapshots(): Promise<void> {
        for (const [channelId, state] of this.channelStates.entries()) {
            if (state.operationsSinceSnapshot > 0) {
                await this.snapshotManager.writeSnapshot(channelId);
            }
        }
    }

    // ===================================================================
    // Utility / messaging helpers
    // ===================================================================

    _validateChannel(channel: any): boolean {
        return typeof channel === 'string' && channel.length > 0 && channel.length <= 50;
    }

    _requireAuth(clientId: string, actionName: string): boolean {
        const clientData: any = this.messageRouter.getClientData ? this.messageRouter.getClientData(clientId) : null;
        if (!clientData || !clientData.userContext) {
            this.logger.warn(`Unauthorized ${actionName} attempt from client ${clientId} — no userContext`);
            this.sendError(clientId, `Authentication required for ${actionName}`, ErrorCodes.AUTH_FAILED);
            return false;
        }
        return true;
    }

    sendToClient(clientId: string, message: any): void {
        if (this.messageRouter && this.messageRouter.sendToClient) {
            this.messageRouter.sendToClient(clientId, message);
        } else if (this.messageRouter) {
            this.logger.warn(`Cannot send message to client ${clientId}: messageRouter has no sendToClient`);
        } else {
            this.logger.warn(`Cannot send message to client ${clientId}: no message router`);
        }
    }

    sendError(clientId: string, message: string, errorCode: any = ErrorCodes.SERVICE_INTERNAL_ERROR): void {
        const errorResponse = createErrorResponse(errorCode, message, {
            service: 'crdt',
            clientId,
        });
        this.sendToClient(clientId, {
            type: 'error',
            service: 'crdt',
            ...errorResponse,
        });
        if (this.metricsCollector) {
            this.metricsCollector.recordError(errorCode);
        }
    }

    // ===================================================================
    // Lifecycle
    // ===================================================================

    async shutdown(): Promise<void> {
        await this._snapshotSweep.stop();

        this.operationCoalescer.cancelAll();

        this.awarenessCoalescer.shutdown();
        this.evictionManager.shutdown();

        await this.snapshotManager.shutdown(this.channelStates);

        const pendingFlushes: Promise<void>[] = [];
        for (const [channelId, state] of this.channelStates.entries()) {
            if (state && state.operationsSinceSnapshot > 0) {
                pendingFlushes.push(
                    this.snapshotManager.writeSnapshot(channelId).catch((err: any) =>
                        this.logger.error(`Failed to flush snapshot for ${channelId} during shutdown:`, err.message)
                    )
                );
            }
        }
        if (pendingFlushes.length > 0) {
            await Promise.allSettled(pendingFlushes);
            this.logger.info(`Flushed ${pendingFlushes.length} dirty CRDT snapshots during shutdown`);
        }

        this.logger.info('CRDT service shut down');
    }

    getStats(): Record<string, number> {
        let pendingRemoteUpdatesTotal = 0;
        for (const buf of this.pendingRemoteUpdates.values()) {
            pendingRemoteUpdatesTotal += buf.length;
        }
        return {
            pendingBatches: this.operationCoalescer.pendingCount,
            pendingAwarenessBatches: this.awarenessCoalescer.pendingCount,
            idleEvictionTimers: this.evictionManager.pendingCount,
            activeChannels: this.channelStates.size,
            trackedPresenceChannels: this.presenceService.channelCount,
            pendingRemoteUpdateChannels: this.pendingRemoteUpdates.size,
            pendingRemoteUpdatesTotal,
        };
    }
}

export default CRDTService;
export { CRDTService };
