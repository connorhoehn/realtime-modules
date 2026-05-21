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
import type { MetadataStore } from './stores/MetadataStore';
import type { MessageRouterContract } from './stores/MessageRouterContract';
interface DocumentMetadataServiceOpts {
    metadataStore: MetadataStore;
    logger: any;
    /**
     * wave20-e — when supplied, the doc.created activity is published via
     * the canonical MessageRouter path (matching the catalog-declared
     * `ws.activity.event` envelope). When not wired (unit tests), the
     * publish is a no-op.
     */
    messageRouter?: MessageRouterContract | null;
}
interface DocumentWire {
    id: string;
    title: string;
    type: string;
    status: 'draft' | 'published';
    createdBy: string;
    createdByName: string | null;
    createdAt: string;
    updatedAt: string;
    icon: string;
    description: string;
    [extra: string]: any;
}
declare class DocumentMetadataService {
    metadataStore: MetadataStore;
    logger: any;
    messageRouter: MessageRouterContract | null;
    private _wireSidecar;
    constructor({ metadataStore, logger, messageRouter }: DocumentMetadataServiceOpts);
    /**
     * No-op in the lifted module. Table provisioning is the
     * MetadataStore adapter's responsibility (the DDB adapter can run
     * CreateTable; the MemoryStore adapter doesn't need to). Kept on the
     * surface so the orchestrator wiring stays unchanged.
     */
    ensureTable(): Promise<void>;
    /**
     * Create a new document with metadata persisted via the MetadataStore.
     * Returns the created document object (wire shape).
     */
    handleCreateDocument({ meta, createdBy, createdByName }: {
        meta: any;
        createdBy: string;
        createdByName?: string | null;
    }): Promise<DocumentWire>;
    /**
     * List all documents, returning metadata for each (wire shape).
     */
    handleListDocuments(): Promise<DocumentWire[]>;
    /**
     * Delete a document's metadata.
     */
    handleDeleteDocument(documentId: string): Promise<void>;
    /**
     * Update metadata fields on an existing document.
     */
    handleUpdateDocumentMeta(documentId: string, meta: any): Promise<DocumentWire | null>;
    private _toWire;
}
export = DocumentMetadataService;
//# sourceMappingURL=DocumentMetadataService.d.ts.map