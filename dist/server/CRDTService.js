"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRDTService = void 0;
const Y = __importStar(require("yjs"));
const { mergeUpdates } = Y;
const distributed_core_1 = require("distributed-core");
const DocumentMetadataService_1 = __importDefault(require("./DocumentMetadataService"));
const SnapshotManager_1 = __importDefault(require("./SnapshotManager"));
const AwarenessCoalescer_1 = __importDefault(require("./AwarenessCoalescer"));
const DocumentPresenceService_1 = __importDefault(require("./DocumentPresenceService"));
const IdleEvictionManager_1 = __importDefault(require("./IdleEvictionManager"));
const config = __importStar(require("./config"));
// ---- Inlined error-code helpers (gateway/utils replacement) ---------------
const ErrorCodes = {
    SERVICE_INTERNAL_ERROR: 'SERVICE_INTERNAL_ERROR',
    AUTH_FAILED: 'AUTH_FAILED',
};
function createErrorResponse(code, message, context = {}) {
    return { error: { code, message, ...context } };
}
class CRDTService {
    messageRouter;
    logger;
    metricsCollector;
    channelStates;
    pendingRemoteUpdates;
    PENDING_REMOTE_UPDATES_CAP;
    operationCoalescer;
    metadataService;
    snapshotManager;
    awarenessCoalescer;
    presenceService;
    evictionManager;
    _evictionCallback;
    _snapshotSweep;
    _authz;
    _onDocumentCreated;
    constructor(opts) {
        const { messageRouter, snapshotStore, metadataStore, hotCache, logger, metricsCollector, authz, onDocumentCreated, } = opts;
        this.messageRouter = messageRouter;
        this.logger = logger;
        this.metricsCollector = metricsCollector || null;
        this._authz = authz || (() => true);
        this._onDocumentCreated = onDocumentCreated ?? null;
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
        this.operationCoalescer = new distributed_core_1.UpdateCoalescer({
            windowMs: config.OPERATION_BATCH_WINDOW_MS,
            merge: (items) => {
                if (items.length === 1)
                    return items;
                const buffers = items.map((it) => new Uint8Array(Buffer.from(it.update, 'base64')));
                return [{
                        update: Buffer.from(mergeUpdates(buffers)).toString('base64'),
                        senderClientId: items[0].senderClientId,
                        count: items.length,
                    }];
            },
            onFlush: (channel, items) => this._broadcastCoalescedOps(channel, items),
        });
        // ---------------------------------------------------------------
        // Sub-services
        // ---------------------------------------------------------------
        this.metadataService = new DocumentMetadataService_1.default({
            metadataStore,
            logger: this.logger,
            messageRouter: this.messageRouter,
        });
        this.snapshotManager = new SnapshotManager_1.default({
            snapshotStore,
            hotCache: hotCache || null,
            logger: this.logger,
            getChannelState: (ch) => this.channelStates.get(ch),
        });
        this.awarenessCoalescer = new AwarenessCoalescer_1.default(this.messageRouter, this.logger);
        this.presenceService = new DocumentPresenceService_1.default(this.messageRouter, this.logger);
        this.evictionManager = new IdleEvictionManager_1.default(this.logger, config);
        // Eviction callback: when the eviction timer fires, flush snapshot + destroy Y.Doc
        this._evictionCallback = async (channel) => {
            const state = this.channelStates.get(channel);
            if (!state)
                return;
            if (state.subscriberCount > 0)
                return; // someone re-joined during grace period
            if (state.operationsSinceSnapshot > 0) {
                await this.snapshotManager.writeSnapshot(channel);
                this.logger.info(`Final snapshot written before evicting Y.Doc for channel ${channel}`);
            }
            if (state.ydoc)
                state.ydoc.destroy();
            this.channelStates.delete(channel);
            this.pendingRemoteUpdates.delete(channel);
            this.snapshotManager.cancelDebouncedSnapshot(channel);
            this.logger.info(`Y.Doc evicted for idle channel ${channel}`);
        };
        // ---------------------------------------------------------------
        // Periodic snapshot sweep
        // ---------------------------------------------------------------
        this._snapshotSweep = new distributed_core_1.PeriodicSweep({
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
            this.messageRouter.onRemoteChannelMessage('crdt-sync', (...args) => {
                let channel;
                let message;
                if (args.length >= 2) {
                    // Legacy gateway-router 3-arg shape: (channel, message, fromNode)
                    channel = args[0];
                    message = args[1];
                }
                else {
                    // MessageRouterContract single-payload shape: { channel, message }
                    const payload = args[0] || {};
                    channel = payload.channel;
                    message = payload.message;
                }
                if (message && message.type === 'crdt:update' && message.update) {
                    let updateBytes;
                    try {
                        updateBytes = new Uint8Array(Buffer.from(message.update, 'base64'));
                    }
                    catch (err) {
                        this.logger.error(`Malformed remote CRDT update for ${channel}:`, err.message);
                        return;
                    }
                    const state = this.channelStates.get(channel);
                    if (state && state.ydoc && state.hydrated) {
                        this._applyRemoteUpdate(channel, state, updateBytes);
                    }
                    else {
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
    _applyRemoteUpdate(channel, state, updateBytes) {
        try {
            Y.applyUpdate(state.ydoc, updateBytes);
            state.operationsSinceSnapshot++;
            this.snapshotManager.scheduleDebouncedSnapshot(channel);
            this.logger.debug(`Applied remote CRDT update to local Y.Doc for channel ${channel}`);
        }
        catch (err) {
            this.logger.error(`Failed to apply remote CRDT update for ${channel}:`, err.message);
        }
    }
    _bufferRemoteUpdate(channel, updateBytes) {
        let buf = this.pendingRemoteUpdates.get(channel);
        if (!buf) {
            buf = [];
            this.pendingRemoteUpdates.set(channel, buf);
        }
        if (buf.length >= this.PENDING_REMOTE_UPDATES_CAP) {
            buf.shift();
            this.logger.warn(`Pending remote-update buffer for ${channel} exceeded cap ` +
                `(${this.PENDING_REMOTE_UPDATES_CAP}); dropping oldest. ` +
                `Hydrate may be stuck.`);
        }
        buf.push(updateBytes);
    }
    _drainPendingRemoteUpdates(channel, state) {
        const buf = this.pendingRemoteUpdates.get(channel);
        if (!buf || buf.length === 0) {
            this.pendingRemoteUpdates.delete(channel);
            return 0;
        }
        this.pendingRemoteUpdates.delete(channel);
        for (const updateBytes of buf) {
            this._applyRemoteUpdate(channel, state, updateBytes);
        }
        this.logger.info(`Drained ${buf.length} buffered remote CRDT update(s) for channel ${channel}`);
        return buf.length;
    }
    // ===================================================================
    // Action dispatch
    // ===================================================================
    /**
     * Invoke the `onDocumentCreated` tap. Sync throws are caught, rejected
     * promises are .catch-ed, and neither reaches the creation path.
     */
    _announceDocument(doc) {
        if (!this._onDocumentCreated)
            return;
        const channel = typeof doc?.channel === 'string' ? doc.channel : '';
        if (!channel)
            return;
        try {
            const result = this._onDocumentCreated({
                documentId: doc.id,
                title: doc.title,
                channel,
                createdBy: doc.createdBy,
                createdByName: doc.createdByName ?? null,
                icon: doc.icon,
            });
            if (result && typeof result.catch === 'function') {
                result.catch((err) => {
                    this.logger.error(`onDocumentCreated hook rejected for ${doc?.id}:`, err);
                });
            }
        }
        catch (err) {
            this.logger.error(`onDocumentCreated hook threw for ${doc?.id}:`, err);
        }
    }
    async handleAction(clientId, action, data) {
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
                    }
                    else {
                        this.sendError(clientId, 'Snapshot not found');
                    }
                    return;
                }
                case 'restoreSnapshot': {
                    if (!this._requireAuth(clientId, 'restoreSnapshot'))
                        return;
                    try {
                        this.logger.info(`Restore requested for channel=${data.channel}, timestamp=${data.timestamp}`);
                        const restored = await this.snapshotManager.handleRestoreSnapshot(data.channel, data.timestamp);
                        if (restored) {
                            await this.messageRouter.sendToChannel(data.channel, {
                                type: 'crdt:doc-replaced', channel: data.channel, snapshot: restored.base64State
                            });
                            this.sendToClient(clientId, { type: 'crdt', action: 'snapshotRestored', channel: data.channel, timestamp: restored.restoredTimestamp });
                            this.logger.info(`Restore complete for channel=${data.channel}`);
                        }
                        else {
                            this.logger.warn(`Restore failed: snapshot not found for channel=${data.channel}, timestamp=${data.timestamp}`);
                            this.sendError(clientId, 'Snapshot not found or restore failed');
                        }
                    }
                    catch (restoreErr) {
                        this.logger.error(`Restore error for channel=${data.channel}:`, restoreErr.message);
                        this.sendError(clientId, 'Restore failed: ' + restoreErr.message);
                    }
                    return;
                }
                case 'clearDocument':
                    if (!this._requireAuth(clientId, 'clearDocument'))
                        return;
                    return await this.snapshotManager.handleClearDocument(clientId, data, this.channelStates, (cid, msg) => this.sendToClient(cid, msg), (cid, msg) => this.sendError(cid, msg));
                case 'saveVersion': {
                    const saved = await this.snapshotManager.handleSaveVersion(data.channel, data.name, clientId);
                    if (saved) {
                        this.sendToClient(clientId, { type: 'crdt', action: 'versionSaved', channel: data.channel, name: saved.name, timestamp: saved.timestamp });
                    }
                    else {
                        this.sendError(clientId, 'Failed to save version');
                    }
                    return;
                }
                case 'listDocuments': {
                    // An optional channel filter, so a conversation can ask
                    // for its own documents without pulling the workspace.
                    const docs = await this.metadataService.handleListDocuments(typeof data?.channel === 'string' && data.channel ? { channel: data.channel } : undefined);
                    this.sendToClient(clientId, { type: 'crdt', action: 'documentList', documents: docs });
                    return;
                }
                case 'createDocument': {
                    const clientData = this.messageRouter.getClientData ? this.messageRouter.getClientData(clientId) : null;
                    const userContext = clientData?.userContext || {};
                    const doc = await this.metadataService.handleCreateDocument({
                        meta: data.meta,
                        createdBy: userContext.userId || clientId,
                        createdByName: userContext.displayName || userContext.email || null,
                    });
                    await this.messageRouter.broadcastToAll({ type: 'crdt', action: 'documentCreated', document: doc });
                    // Announce it in the conversation it was created in, if
                    // any. After the broadcast: the document exists and every
                    // client already knows, so a slow or failing announcement
                    // cannot hold up the thing it is announcing.
                    this._announceDocument(doc);
                    return;
                }
                case 'deleteDocument': {
                    if (!this._requireAuth(clientId, 'deleteDocument'))
                        return;
                    const docId = data.documentId;
                    await this.metadataService.handleDeleteDocument(docId);
                    const channel = `doc:${docId}`;
                    const state = this.channelStates.get(channel);
                    if (state) {
                        if (state.ydoc)
                            state.ydoc.destroy();
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
                    const seen = new Set();
                    const toRemove = [];
                    for (let i = 0; i < ySections.length; i++) {
                        const section = ySections.get(i);
                        const title = section instanceof Y.Map ? section.get('title') : null;
                        if (!title)
                            continue;
                        if (seen.has(title)) {
                            toRemove.push(i);
                        }
                        else {
                            seen.add(title);
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
                    // Per USER, not per connection — the same shape the
                    // pushed `documents:presence` sends. Reading the raw
                    // clientId map here made a poll disagree with a push
                    // about how many people were in the document.
                    const presence = {};
                    for (const [ch, users] of this.presenceService.getPresenceByUser()) {
                        if (users.length > 0)
                            presence[ch] = users;
                    }
                    this.sendToClient(clientId, { type: 'crdt', action: 'documentPresence', presence });
                    return;
                }
                default:
                    this.sendError(clientId, `Unknown CRDT action: ${action}`);
            }
        }
        catch (error) {
            this.logger.error(`Error handling CRDT action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
        finally {
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
    async handleSubscribe(clientId, { channel }) {
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
                }
                finally {
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
            }
            catch (syncError) {
                this.logger.error(`Failed to push Y.Doc state for ${channel} to ${clientId}:`, syncError.message);
            }
            this.presenceService.addClient(clientId, channel);
            this.logger.info(`Client ${clientId} subscribed to CRDT channel: ${channel}`);
        }
        catch (error) {
            this.logger.error(`Error subscribing to channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to channel');
        }
    }
    // ===================================================================
    // handleUpdate — apply Y.js update, batch operations, broadcast
    // ===================================================================
    async handleUpdate(clientId, { channel, update }) {
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
            }
            else {
                this.snapshotManager.scheduleDebouncedSnapshot(channel);
            }
            const latestState = Y.encodeStateAsUpdate(state.ydoc);
            if (latestState.byteLength > 0) {
                this.snapshotManager.saveSnapshotToRedis(channel, Buffer.from(latestState).toString('base64'))
                    .catch((err) => this.logger.error(`Non-blocking hot-cache update failed for ${channel}:`, err.message));
            }
            this.operationCoalescer.buffer(channel, { update, senderClientId: clientId });
            this.logger.debug(`CRDT update batched for channel ${channel} from client ${clientId}`);
        }
        catch (error) {
            this.logger.error(`Error handling CRDT update for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to process CRDT update');
        }
    }
    // ===================================================================
    // handleUnsubscribe — decrement subscribers, cleanup
    // ===================================================================
    async handleUnsubscribe(clientId, { channel }) {
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
        }
        catch (error) {
            this.logger.error(`Error unsubscribing from channel ${channel} for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to unsubscribe from channel');
        }
    }
    // ===================================================================
    // handleGetSnapshot — auth check + delegate to SnapshotManager
    // ===================================================================
    async handleGetSnapshot(clientId, { channel }) {
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
        }
        catch (error) {
            this.logger.error(`Error handling getSnapshot for channel ${channel}:`, error);
            this.sendError(clientId, 'Failed to retrieve snapshot');
        }
    }
    // ===================================================================
    // handleAwareness — delegate to AwarenessCoalescer + presence backfill
    // ===================================================================
    async handleAwareness(clientId, { channel, update, idle, mode }) {
        this.logger.info(`[awareness-entry] client=${clientId} channel=${channel} hasUpdate=${!!update} idle=${idle} mode=${mode} isDoc=${channel?.startsWith?.('doc:')}`);
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
                else {
                    // An entry created before this connection's user context
                    // landed is keyed on its clientId, which reads downstream
                    // as a second, anonymous person in the document. Awareness
                    // arrives constantly while a document is open, so this is
                    // where such an entry gets its name.
                    this.presenceService.refreshIdentity(clientId, channel);
                }
                if (typeof idle === 'boolean') {
                    this.presenceService.setIdle(clientId, channel, idle);
                }
                if (typeof mode === 'string') {
                    this.presenceService.setMode(clientId, channel, mode);
                }
            }
            this.awarenessCoalescer.bufferUpdate(clientId, channel, update);
            this.logger.debug(`Awareness buffered for channel ${channel} from client ${clientId}`);
        }
        catch (error) {
            this.logger.error(`Error buffering awareness for channel ${channel}:`, error);
        }
    }
    // ===================================================================
    // onClientDisconnect
    // ===================================================================
    async handleDisconnect(clientId) {
        return this.onClientDisconnect(clientId);
    }
    async onClientDisconnect(clientId) {
        const clientData = this.messageRouter?.getClientData ? this.messageRouter.getClientData(clientId) : null;
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
                            }
                            catch (err) {
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
    async _broadcastCoalescedOps(channel, items) {
        if (!items || items.length === 0)
            return;
        const { update, count } = items[0];
        try {
            await this.messageRouter.sendToChannel(channel, {
                type: 'crdt:update', channel, update,
            });
            this.logger.debug(`Broadcasted ${count || 1} CRDT operation(s) for channel ${channel}`);
        }
        catch (error) {
            this.logger.error(`Error broadcasting CRDT operations for channel ${channel}:`, error);
        }
    }
    // ===================================================================
    // Periodic snapshot sweep
    // ===================================================================
    async _writePeriodicSnapshots() {
        for (const [channelId, state] of this.channelStates.entries()) {
            if (state.operationsSinceSnapshot > 0) {
                await this.snapshotManager.writeSnapshot(channelId);
            }
        }
    }
    // ===================================================================
    // Utility / messaging helpers
    // ===================================================================
    _validateChannel(channel) {
        return typeof channel === 'string' && channel.length > 0 && channel.length <= 50;
    }
    _requireAuth(clientId, actionName) {
        const clientData = this.messageRouter.getClientData ? this.messageRouter.getClientData(clientId) : null;
        if (!clientData || !clientData.userContext) {
            this.logger.warn(`Unauthorized ${actionName} attempt from client ${clientId} — no userContext`);
            this.sendError(clientId, `Authentication required for ${actionName}`, ErrorCodes.AUTH_FAILED);
            return false;
        }
        return true;
    }
    sendToClient(clientId, message) {
        if (this.messageRouter && this.messageRouter.sendToClient) {
            this.messageRouter.sendToClient(clientId, message);
        }
        else if (this.messageRouter) {
            this.logger.warn(`Cannot send message to client ${clientId}: messageRouter has no sendToClient`);
        }
        else {
            this.logger.warn(`Cannot send message to client ${clientId}: no message router`);
        }
    }
    sendError(clientId, message, errorCode = ErrorCodes.SERVICE_INTERNAL_ERROR) {
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
    async shutdown() {
        await this._snapshotSweep.stop();
        this.operationCoalescer.cancelAll();
        this.awarenessCoalescer.shutdown();
        this.evictionManager.shutdown();
        await this.snapshotManager.shutdown(this.channelStates);
        const pendingFlushes = [];
        for (const [channelId, state] of this.channelStates.entries()) {
            if (state && state.operationsSinceSnapshot > 0) {
                pendingFlushes.push(this.snapshotManager.writeSnapshot(channelId).catch((err) => this.logger.error(`Failed to flush snapshot for ${channelId} during shutdown:`, err.message)));
            }
        }
        if (pendingFlushes.length > 0) {
            await Promise.allSettled(pendingFlushes);
            this.logger.info(`Flushed ${pendingFlushes.length} dirty CRDT snapshots during shutdown`);
        }
        this.logger.info('CRDT service shut down');
    }
    getStats() {
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
exports.CRDTService = CRDTService;
exports.default = CRDTService;
//# sourceMappingURL=CRDTService.js.map