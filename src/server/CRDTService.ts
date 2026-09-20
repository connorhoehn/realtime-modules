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
import AwarenessLedger from './AwarenessLedger';
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
    /** Explicit false rejects admission; void preserves legacy router compatibility. */
    subscribeToChannel?(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    sendToClient?(clientId: string, message: any): void;
}

export type CRDTDocumentAction = 'read' | 'update' | 'save' | 'restore' | 'metadata' | 'create' | 'delete' | 'seed' | 'awareness';

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
    authz?: (clientId: string, channel: string, service: CRDTService, action: CRDTDocumentAction) => boolean | Promise<boolean>;
    /**
     * A document was created inside a conversation.
     *
     * Fired only when the new document carries a `channel` binding, and only
     * after the document exists — the consumer's job is to announce it in that
     * conversation, and announcing something that failed to be created is
     * worse than not announcing it.
     *
     * Fire-and-forget: a failing hook is logged and never fails the creation.
     * The document is the thing that matters; the message about it is not.
     */
    onDocumentCreated?: (doc: {
        documentId: string;
        title: string;
        channel: string;
        createdBy: string;
        createdByName?: string | null;
        icon?: string;
    }) => void | Promise<void>;
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
    /** Who announced which awareness ids where — so the gateway can say goodbye for a connection that could not. */
    awarenessLedger: AwarenessLedger;
    presenceService: DocumentPresenceService;
    evictionManager: IdleEvictionManager;
    _evictionCallback: (channel: string) => Promise<void>;
    private hydration = new Map<string, Promise<ChannelState>>();
    private readonly _snapshotSweep: PeriodicSweep;
    private _authz: NonNullable<CRDTServiceOpts['authz']>;
    private seedOperations = new Map<string, Promise<unknown>>();
    private _onDocumentCreated: CRDTServiceOpts['onDocumentCreated'] | null;

    constructor(opts: CRDTServiceOpts) {
        const {
            messageRouter, snapshotStore, metadataStore, hotCache, logger,
            metricsCollector, authz, onDocumentCreated,
        } = opts;

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
        this.awarenessLedger = new AwarenessLedger();

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

    /**
     * Invoke the `onDocumentCreated` tap. Sync throws are caught, rejected
     * promises are .catch-ed, and neither reaches the creation path.
     */
    _announceDocument(doc: any): void {
        if (!this._onDocumentCreated) return;
        const channel = typeof doc?.channel === 'string' ? doc.channel : '';
        if (!channel) return;
        try {
            const result = this._onDocumentCreated({
                documentId: doc.id,
                title: doc.title,
                channel,
                createdBy: doc.createdBy,
                createdByName: doc.createdByName ?? null,
                icon: doc.icon,
            });
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch((err: any) => {
                    this.logger.error(`onDocumentCreated hook rejected for ${doc?.id}:`, err);
                });
            }
        } catch (err: any) {
            this.logger.error(`onDocumentCreated hook threw for ${doc?.id}:`, err);
        }
    }

    private async authorize(clientId: string, channel: string, action: CRDTDocumentAction, report = true): Promise<boolean> {
        const allowed = await this._authz(clientId, channel, this, action);
        if (!allowed && report) this.sendError(clientId, 'Document operation denied');
        return allowed === true;
    }

    /** Single-owner idempotent seed. Caller supplies a schema-validated binary Yjs document, never Markdown reconstruction. */
    async seedDocument(clientId: string, input: { channel: string; snapshot: string; sourceRevision: string; title?: string; type?: string }): Promise<{ sourceRevision: string; alreadySeeded: boolean }> {
        const { channel, snapshot, sourceRevision } = input;
        if (!this._validateChannel(channel) || !sourceRevision || sourceRevision.length > 512 || typeof snapshot !== 'string' || snapshot.length > 8 * 1024 * 1024) throw new Error('Invalid document seed');
        const previous = this.seedOperations.get(channel) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            if (!await this.authorize(clientId, channel, 'seed')) throw new Error('Document seed denied');
            const wasSubscribed = ((this.messageRouter.getClientData?.(clientId) as any)?.channels ?? []).includes(channel);
            const admitted = await this.messageRouter.subscribeToChannel?.(clientId, channel);
            if (admitted === false) throw new Error('Document ownership admission rejected');
            try {
            const state = await this.ensureHydratedState(channel);
            if (!await this.authorize(clientId, channel, 'seed')) throw new Error('Document seed denied');
            const meta = state.ydoc.getMap('meta');
            const current = meta.get('importSourceRevision');
            if (current !== undefined && current !== sourceRevision) throw new Error('Document already seeded from another source revision');
            const alreadySeeded = current === sourceRevision;
            if (!alreadySeeded) {
                if (Y.encodeStateVector(state.ydoc).byteLength > 1) throw new Error('Cannot seed an existing document');
                const candidate = new Y.Doc();
                try {
                    Y.applyUpdate(candidate, Buffer.from(snapshot, 'base64'));
                    if (candidate.getMap('meta').get('schemaVersion') !== 2) throw new Error('Seed requires canvas schema version 2');
                    candidate.getMap('meta').set('importSourceRevision', sourceRevision);
                    Y.applyUpdate(state.ydoc, Y.encodeStateAsUpdate(candidate));
                    state.operationsSinceSnapshot++;
                } finally { candidate.destroy(); }
            }
            // Retrying after a failed first write must persist again before reporting success.
            await this.snapshotManager.writeSnapshot(channel);
            if (channel.startsWith('doc:')) {
                const documentId = channel.slice(4);
                const store = this.metadataService.metadataStore;
                const context = (this.messageRouter.getClientData?.(clientId) as any)?.userContext;
                if (!context?.userId) throw new Error('Document seed requires a verified actor');
                // Source import is not ownership assignment to the first viewer. Only the host's verified seed identity may carry a steward.
                const ownerId = typeof context.seedOwnerSub === 'string' ? context.seedOwnerSub : undefined;
                const now = Date.now();
                const record = { documentId, title: typeof input.title === 'string' ? input.title.slice(0, 512) : 'Untitled', docType: typeof input.type === 'string' ? input.type.slice(0, 128) : 'custom', ownerId, status: 'draft' as const, createdAt: now, updatedAt: now };
                if (store.createDocumentIfAbsent) await store.createDocumentIfAbsent(record);
                else if (!await store.getDocument(documentId)) await store.putDocument(record);
            }
            return { sourceRevision, alreadySeeded };
            } finally { if (!wasSubscribed) await this.messageRouter.unsubscribeFromChannel?.(clientId, channel); }
        });
        this.seedOperations.set(channel, next);
        try { return await next; }
        finally { if (this.seedOperations.get(channel) === next) this.seedOperations.delete(channel); }
    }

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        const startTime = Date.now();
        try {
            const actionPolicy: Record<string, CRDTDocumentAction> = {
                listSnapshots: 'read', getSnapshotAtVersion: 'read', restoreSnapshot: 'restore',
                clearDocument: 'restore', saveVersion: 'save', createDocument: 'create',
                deleteDocument: 'delete', updateDocumentMeta: 'metadata', deduplicateSections: 'update', seedDocument: 'seed',
            };
            const policyAction = actionPolicy[action];
            if (policyAction && !await this.authorize(clientId, data.documentId ? `doc:${data.documentId}` : (data.channel || ''), policyAction)) return;
            switch (action) {
                case 'seedDocument': {
                    const result = await this.seedDocument(clientId, data);
                    this.sendToClient(clientId, { type: 'crdt:seeded', channel: data.channel, requestId: typeof data.requestId === 'string' ? data.requestId : undefined, ...result });
                    return;
                }
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
                    if (!await this.authorize(clientId, data.channel, 'read')) return;
                    this.sendToClient(clientId, { type: 'crdt', action: 'snapshotList', channel: data.channel, snapshots });
                    return;
                }
                case 'getSnapshotAtVersion': {
                    const result = await this.snapshotManager.handleGetSnapshotAtVersion(data.channel, data.timestamp);
                    if (result && await this.authorize(clientId, data.channel, 'read')) {
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
                    // An optional channel filter, so a conversation can ask
                    // for its own documents without pulling the workspace.
                    const docs = await this.metadataService.handleListDocuments(
                        typeof data?.channel === 'string' && data.channel ? { channel: data.channel } : undefined,
                    );
                    this.sendToClient(clientId, { type: 'crdt', action: 'documentList', documents: (await Promise.all(docs.map(async doc => await this.authorize(clientId, `doc:${doc.id}`, 'read', false) ? doc : null))).filter(Boolean) });
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
                    // Announce it in the conversation it was created in, if
                    // any. After the broadcast: the document exists and every
                    // client already knows, so a slow or failing announcement
                    // cannot hold up the thing it is announcing.
                    this._announceDocument(doc);
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
                    // Per USER, not per connection — the same shape the
                    // pushed `documents:presence` sends. Reading the raw
                    // clientId map here made a poll disagree with a push
                    // about how many people were in the document.
                    const presence: Record<string, any[]> = {};
                    for (const [ch, users] of this.presenceService.getPresenceByUser()) {
                        if (users.length > 0 && await this.authorize(clientId, ch, 'read', false)) presence[ch] = users;
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

    private async ensureHydratedState(channel: string): Promise<ChannelState> {
        const existing = this.channelStates.get(channel);
        if (existing?.hydrated) return existing;
        const pending = this.hydration.get(channel);
        if (pending) return pending;
        const state = existing ?? {
            ydoc: new Y.Doc(), operationsSinceSnapshot: 0, subscriberCount: 0, hydrated: false,
        };
        this.channelStates.set(channel, state);
        const load = (async () => {
            try {
                await this.snapshotManager.hydrateYDoc(channel, state);
                state.hydrated = true;
                this._drainPendingRemoteUpdates(channel, state);
                return state;
            } catch (error) {
                if (this.channelStates.get(channel) === state) this.channelStates.delete(channel);
                state.ydoc.destroy();
                throw error;
            }
        })();
        this.hydration.set(channel, load);
        try { return await load; }
        finally { if (this.hydration.get(channel) === load) this.hydration.delete(channel); }
    }

    async handleSubscribe(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!this._validateChannel(channel)) {
            this.sendError(clientId, 'Channel name must be a string between 1 and 50 characters');
            return;
        }

        try {
            // Auth check via injectable authz hook
            if (!await this.authorize(clientId, channel, 'read')) {
                return;
            }

            // Join before loading so remote edits arriving during hydration
            // still enter the pending-update buffer.
            if (this.messageRouter.subscribeToChannel) {
                const admitted = await this.messageRouter.subscribeToChannel(clientId, channel);
                if (admitted === false) {
                    this.sendError(clientId, 'Document subscription was rejected');
                    return;
                }
            }
            this.evictionManager.cancelEviction(channel);
            let state: ChannelState;
            try {
                state = await this.ensureHydratedState(channel);
                if (!await this.authorize(clientId, channel, 'read')) {
                    await this.messageRouter.unsubscribeFromChannel?.(clientId, channel);
                    return;
                }
            } catch (error) {
                await this.messageRouter.unsubscribeFromChannel?.(clientId, channel);
                throw error;
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

    async handleUpdate(clientId: string, { channel, update, updateId }: { channel: string; update: string; updateId?: string }): Promise<void> {
        if (!this._validateChannel(channel)) {
            this.sendError(clientId, 'Channel name must be a string between 1 and 50 characters');
            return;
        }
        if (!update || typeof update !== 'string') {
            this.sendError(clientId, 'Update payload must be a base64 string');
            return;
        }

        if (updateId !== undefined && (typeof updateId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(updateId))) { this.sendError(clientId, 'Invalid update identifier'); return; }
        try {
            // A subscription is not an authorization grant for future writes:
            // clients can send updates directly, and policy may change later.
            if (!await this.authorize(clientId, channel, 'update')) { if (updateId) this.sendToClient(clientId, { type: 'crdt:persistence-error', channel, updateId }); return; }
            const state = await this.ensureHydratedState(channel);
            if (!await this.authorize(clientId, channel, 'update')) { if (updateId) this.sendToClient(clientId, { type: 'crdt:persistence-error', channel, updateId }); return; }

            const updateBytes = new Uint8Array(Buffer.from(update, 'base64'));
            Y.applyUpdate(state.ydoc, updateBytes);
            state.operationsSinceSnapshot++;

            if (updateId || state.operationsSinceSnapshot >= config.OPERATIONS_BEFORE_SNAPSHOT) {
                await this.snapshotManager.writeSnapshot(channel);
            } else {
                this.snapshotManager.scheduleDebouncedSnapshot(channel);
            }

            if (updateId) this.sendToClient(clientId, { type: 'crdt:persisted', channel, updateId });

            const latestState = Y.encodeStateAsUpdate(state.ydoc);
            if (latestState.byteLength > 0) {
                this.snapshotManager.saveSnapshotToRedis(channel, Buffer.from(latestState).toString('base64'))
                    .catch((err: any) => this.logger.error(`Non-blocking hot-cache update failed for ${channel}:`, err.message));
            }

            this.operationCoalescer.buffer(channel, { update, senderClientId: clientId });

            this.logger.debug(`CRDT update batched for channel ${channel} from client ${clientId}`);
        } catch (error) {
            this.logger.error(`Error handling CRDT update for channel ${channel}:`, error);
            if (updateId) this.sendToClient(clientId, { type: 'crdt:persistence-error', channel, updateId });
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
                        try { await this.snapshotManager.writeSnapshot(channel); }
                        catch (error) { this.logger.error('Snapshot on unsubscribe failed; retaining dirty state', error); }
                    }
                    this.evictionManager.startEviction(channel, this._evictionCallback);
                }
            }

            if (this.messageRouter.unsubscribeFromChannel) {
                await this.messageRouter.unsubscribeFromChannel(clientId, channel);
            }
            this.presenceService.removeClient(clientId, channel);
            // The goodbye the client may not have sent (see AwarenessLedger).
            // Buffered under its own slot so the coalescer's next flush carries
            // it to whoever is still there.
            const bye = this.awarenessLedger.departure(clientId, channel);
            if (bye) this.awarenessCoalescer.bufferUpdate(clientId, channel, bye);

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
            if (!await this.authorize(clientId, channel, 'read')) {
                return;
            }

            const snapshot = await this.snapshotManager.retrieveLatestSnapshot(channel);
            if (!await this.authorize(clientId, channel, 'read')) return;

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

    async handleAwareness(clientId: string, { channel, update, idle, mode }: { channel: string; update: string; idle?: boolean; mode?: string }): Promise<void> {
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
            if (!await this.authorize(clientId, channel, 'awareness')) return;
            if (channel.startsWith('doc:')) {
                if (!this.presenceService.hasClient(clientId, channel)) {
                    this.logger.info(`[presence-backfill] Adding ${clientId} to presence for ${channel}`);
                    this.presenceService.addClient(clientId, channel);
                } else {
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
                    this.presenceService.setMode(clientId, channel, mode as any);
                }
            }

            this.awarenessLedger.remember(clientId, channel, update);
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
        // AFTER the prune above, which would otherwise delete these too: the
        // goodbye for every document this connection was still announced on.
        for (const { channel, update } of this.awarenessLedger.departures(clientId)) {
            this.awarenessCoalescer.bufferUpdate(clientId, channel, update);
        }

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
                try { await this.snapshotManager.writeSnapshot(channelId); }
                catch { /* SnapshotManager logs; other dirty channels must still be flushed. */ }
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
