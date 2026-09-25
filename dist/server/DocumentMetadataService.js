"use strict";
// realtime-modules/src/server/DocumentMetadataService.ts
/**
 * Document metadata CRUD — creating, listing, updating, and deleting
 * document metadata.
 *
 * Lift note (CRDT Cut 1): adapted from
 * src/realtime-fanout/crdt/DocumentMetadataService.ts. The only logic
 * change vs. the gateway original is the persistence layer:
 *
 *   - The DDB-direct `@aws-sdk/client-dynamodb` calls (PutItem / GetItem
 *     / Scan / DeleteItem) are replaced with calls through the
 *     `MetadataStore` interface.
 *   - The Redis-direct `redisClient.set / zAdd / get / zRange / zRem / del`
 *     pair (with the in-memory fallback maps `docMetaFallback` /
 *     `docListFallback`) is also replaced with the same `MetadataStore`.
 *     Hot-cache vs. durable is now an adapter concern; this module just
 *     calls put/get/list/delete.
 *   - `messageRouter` is narrowed to `MessageRouterContract`. Behaviour
 *     (publishing `doc.created` to `activity:broadcast` via sendToChannel)
 *     is unchanged.
 *
 * The wire/JSON shape the orchestrator returns is preserved verbatim:
 * `id`, ISO-8601 `createdAt`/`updatedAt`, default `icon` from TYPE_ICONS,
 * etc. Conversion to/from the `MetadataStore.DocumentMeta` (ms-epoch,
 * `documentId`) shape happens at the boundary.
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
const crypto = __importStar(require("crypto"));
const config_1 = require("./config");
class DocumentMetadataService {
    metadataStore;
    logger;
    messageRouter;
    // Extra wire-only fields the orchestrator persists outside the
    // MetadataStore contract (icon, createdBy, createdByName, type). The
    // store contract only covers documentId/title/status/description/
    // docType/ownerId/timestamps; this side-map is per-process and gets
    // re-populated on read fallback to ISO conversion. Keeping it on the
    // service preserves the gateway's observable surface without
    // widening the store contract.
    _wireSidecar = new Map();
    constructor({ metadataStore, logger, messageRouter }) {
        this.metadataStore = metadataStore;
        this.logger = logger;
        this.messageRouter = messageRouter || null;
    }
    // ------------------------------------------------------------------
    // Public API — called by the orchestrator
    // ------------------------------------------------------------------
    /**
     * No-op in the lifted module. Table provisioning is the
     * MetadataStore adapter's responsibility (the DDB adapter can run
     * CreateTable; the MemoryStore adapter doesn't need to). Kept on the
     * surface so the orchestrator wiring stays unchanged.
     */
    async ensureTable() {
        // Adapter-owned; nothing to do at the service level.
    }
    /**
     * Create a new document with metadata persisted via the MetadataStore.
     * Returns the created document object (wire shape).
     */
    async handleCreateDocument({ meta, createdBy, createdByName }) {
        const documentId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const nowEpoch = Date.now();
        const docType = (meta && meta.type) || 'custom';
        const document = {
            id: documentId,
            title: meta.title.trim(),
            type: docType,
            status: 'draft',
            createdBy: createdBy || 'unknown',
            createdByName: createdByName || null,
            createdAt: nowIso,
            updatedAt: nowIso,
            icon: (meta && meta.icon) || config_1.TYPE_ICONS[docType] || config_1.TYPE_ICONS.custom,
            description: (meta && meta.description) || '',
        };
        // A document written during a conversation belongs to it. Carried
        // only when the creator supplied one — never inferred.
        const channel = typeof meta?.channel === 'string' && meta.channel ? meta.channel : undefined;
        if (channel)
            document.channel = channel;
        // Persist canonical fields via the store.
        await this.metadataStore.putDocument({
            documentId,
            title: document.title,
            status: document.status,
            description: document.description,
            docType: document.type,
            ownerId: document.createdBy,
            ...(document.createdByName ? { ownerName: document.createdByName } : {}),
            channel,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
        });
        // Keep wire-only fields (icon, createdByName) in the per-process
        // sidecar so reads round-trip them.
        this._wireSidecar.set(documentId, {
            icon: document.icon,
            createdByName: document.createdByName,
            createdBy: document.createdBy,
            createdAt: nowIso,
        });
        // wave20-e — publish via the canonical MessageRouter path.
        if (this.messageRouter) {
            try {
                await this.messageRouter.sendToChannel('activity:broadcast', {
                    type: 'activity:event',
                    payload: {
                        eventType: 'doc.created',
                        detail: { documentId, title: document.title },
                        timestamp: nowIso,
                        userId: document.createdBy,
                        displayName: document.createdByName || document.createdBy,
                    },
                });
            }
            catch (pubErr) {
                this.logger.error('Failed to broadcast doc.created activity:', pubErr.message);
            }
        }
        this.logger.info(`Document created: ${documentId} (${document.title})`);
        return document;
    }
    /**
     * List all documents, returning metadata for each (wire shape).
     */
    async handleListDocuments(opts) {
        const stored = await this.metadataStore.listDocuments(opts?.channel ? { channel: opts.channel } : undefined);
        return stored.map((d) => this._toWire(d));
    }
    /**
     * Backfill-on-read for rows written before `ownerName` was persisted.
     *
     * Only the owner's own verified context may name them: a row missing a
     * name gets it when its owner lists documents, via the store's
     * conditional single-attribute update (no other row, no other
     * attribute is rewritten). The wire docs are patched in place so this
     * answer already carries the name. A failed backfill is logged and the
     * answer still goes out — it is retried on the owner's next read.
     * Returns how many rows were backfilled.
     */
    async backfillOwnerNames(docs, actor) {
        const name = typeof actor?.displayName === 'string' ? actor.displayName.trim() : '';
        const userId = actor?.userId;
        if (!name || !userId || !this.metadataStore.setOwnerNameIfAbsent)
            return 0;
        let written = 0;
        for (const doc of docs) {
            if (doc.createdBy !== userId || doc.createdByName)
                continue;
            doc.createdByName = name;
            try {
                if (await this.metadataStore.setOwnerNameIfAbsent(doc.id, userId, name))
                    written++;
            }
            catch (err) {
                this.logger.warn?.(`ownerName backfill failed for ${doc.id}: ${err?.message ?? err}`);
            }
        }
        if (written)
            this.logger.info(`ownerName backfilled on ${written} document(s) for ${userId}`);
        return written;
    }
    /** One document's metadata in wire shape, or null when there is no such row. */
    async handleGetDocument(documentId) {
        const stored = await this.metadataStore.getDocument(documentId);
        return stored ? this._toWire(stored) : null;
    }
    /**
     * Delete a document's metadata.
     */
    async handleDeleteDocument(documentId) {
        await this.metadataStore.deleteDocument(documentId);
        this._wireSidecar.delete(documentId);
        this.logger.info(`Document deleted: ${documentId}`);
    }
    /**
     * Update metadata fields on an existing document.
     */
    async handleUpdateDocumentMeta(documentId, meta) {
        const existing = await this.metadataStore.getDocument(documentId);
        if (!existing)
            return null;
        const wire = this._toWire(existing);
        // The persisted owner name is set by the server at creation (or by a
        // backfill from the owner's own verified context) — never from a
        // client's updateDocumentMeta payload, which can say anything.
        const ownerName = existing.ownerName ?? (wire.createdByName || undefined);
        // Merge only allowed fields onto the wire object (preserves
        // gateway's allowlist verbatim).
        const allowedFields = ['title', 'status', 'description', 'icon', 'type', 'activeCallSessionId', 'createdByName'];
        for (const field of allowedFields) {
            if (meta[field] !== undefined) {
                wire[field] = meta[field];
            }
        }
        // The tree position. Validated rather than merged blind: a parent that
        // is the document itself, or not a string, would corrupt every reader
        // of the tree; a non-finite position would sort as NaN forever.
        if (meta.parentId !== undefined) {
            if (meta.parentId !== null && (typeof meta.parentId !== 'string' || meta.parentId === documentId)) {
                throw new Error('parentId must be null or the id of another document');
            }
            wire.parentId = meta.parentId;
        }
        if (meta.position !== undefined) {
            if (typeof meta.position !== 'number' || !Number.isFinite(meta.position)) {
                throw new Error('position must be a finite number');
            }
            wire.position = meta.position;
        }
        const nowIso = new Date().toISOString();
        const nowEpoch = Date.now();
        wire.updatedAt = nowIso;
        // Persist canonical fields back to the store.
        await this.metadataStore.putDocument({
            documentId,
            title: wire.title,
            status: wire.status,
            description: wire.description,
            docType: wire.type,
            ownerId: wire.createdBy,
            ...(ownerName ? { ownerName } : {}),
            // Carried through explicitly. putDocument is an upsert of the
            // WHOLE row, so leaving this out would quietly unbind a document
            // from its conversation the first time anyone renamed it.
            channel: existing.channel,
            // Carried through for the same reason as `channel`: an upsert of
            // the whole row would otherwise flatten the tree on the first
            // rename. `parentId: null` is a real value (a root) and is kept.
            ...(wire.parentId !== undefined ? { parentId: wire.parentId } : {}),
            ...(wire.position !== undefined ? { position: wire.position } : {}),
            // The sharing list, from the stored row only (never the payload):
            // dropping it here un-shared the document on every rename.
            ...(Array.isArray(existing.editors) ? { editors: existing.editors } : {}),
            createdAt: existing.createdAt,
            updatedAt: nowEpoch,
        });
        // Refresh sidecar for wire-only fields.
        this._wireSidecar.set(documentId, {
            icon: wire.icon,
            createdByName: wire.createdByName,
            createdBy: wire.createdBy,
            createdAt: wire.createdAt,
            ...(meta.activeCallSessionId !== undefined ? { activeCallSessionId: meta.activeCallSessionId } : {}),
        });
        this.logger.info(`Document metadata updated: ${documentId}`);
        return wire;
    }
    // ------------------------------------------------------------------
    // Internal: store-shape <-> wire-shape conversion
    // ------------------------------------------------------------------
    _toWire(stored) {
        const sidecar = this._wireSidecar.get(stored.documentId) || {};
        const docType = stored.docType || 'custom';
        return {
            ...(stored.parentId !== undefined ? { parentId: stored.parentId } : {}),
            ...(stored.position !== undefined ? { position: stored.position } : {}),
            id: stored.documentId,
            title: stored.title || 'Untitled',
            type: docType,
            status: stored.status || 'draft',
            createdBy: sidecar.createdBy || stored.ownerId || 'unknown',
            // The persisted name first: it is the same on every replica and
            // after a restart. The sidecar only covers this process's own
            // creates/renames of rows that predate `ownerName`.
            createdByName: stored.ownerName ?? sidecar.createdByName ?? null,
            createdAt: sidecar.createdAt || new Date(stored.createdAt).toISOString(),
            updatedAt: new Date(stored.updatedAt).toISOString(),
            icon: sidecar.icon || config_1.TYPE_ICONS[docType] || '',
            description: stored.description || '',
            ...(stored.channel ? { channel: stored.channel } : {}),
            ...(Array.isArray(stored.editors) && stored.editors.length ? { editors: [...stored.editors] } : {}),
            ...(sidecar.activeCallSessionId !== undefined ? { activeCallSessionId: sidecar.activeCallSessionId } : {}),
        };
    }
}
module.exports = DocumentMetadataService;
//# sourceMappingURL=DocumentMetadataService.js.map