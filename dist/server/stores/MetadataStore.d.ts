/**
 * Prep interface for the CRDT-extraction Cut 1.
 *
 * `MetadataStore` abstracts the document-metadata persistence surface
 * that `DocumentMetadataService.ts` currently implements directly
 * against DynamoDB (PutItem / GetItem / Scan / DeleteItem) plus Redis
 * (`doc:meta:<id>` strings + `doc:list` sorted set).
 *
 * Purely additive — DocumentMetadataService is unchanged. Cut 1 will
 * refactor it to depend on this interface, after which MemoryStore
 * becomes the zero-config fallback (replacing the current ad-hoc
 * `docMetaFallback: Map` / `docListFallback: Array` pair inside
 * DocumentMetadataService).
 *
 * Field-shape notes (load-bearing for the future extraction):
 *
 *   - `documentId` is the canonical id; the existing service serialises
 *     it as `id` on the wire (and stores `documentId` as the DDB
 *     partition key). Cut 1 will normalise to `documentId` in the
 *     persistence layer and let the orchestrator map to the legacy
 *     `id`-keyed JSON envelope.
 *
 *   - `title`, `description`, `docType`, `ownerId` are all optional
 *     because the existing DDB rows have `Untitled` / empty-string
 *     defaults that the current `_dynamoItemToDocument` mapper fills in.
 *     Adapters MUST NOT invent defaults; they pass through what's stored
 *     (including `undefined`) so the orchestrator owns presentation.
 *
 *   - `status` is constrained to `'draft' | 'published'` here — the
 *     existing service only ever writes those two values via the
 *     `allowedFields` whitelist in `handleUpdateDocumentMeta`.
 *
 *   - `createdAt` / `updatedAt` are millisecond epoch numbers in this
 *     contract. The existing service uses ISO-8601 strings; the Cut 1
 *     adapter will convert at the boundary so the store interface stays
 *     simple-typed.
 *
 *   - `listDocuments` filters (`ownerId`, `docType`) are optional. The
 *     DDB adapter implementation will require an index (or a scan +
 *     filter) for non-trivial filters; MemoryStore filters in JS.
 */
export interface DocumentMeta {
    documentId: string;
    title?: string;
    status?: 'draft' | 'published';
    description?: string;
    docType?: string;
    ownerId?: string;
    /**
     * The conversation this document was created in, if any.
     *
     * A document written during a conversation belongs to it — that is where
     * it will be looked for. Persisted here rather than kept as a wire-only
     * field, because the wire sidecar is a per-process Map: a binding held
     * there is lost on restart and invisible to every other node, which is
     * exactly the wrong shape for something whose whole job is to still be
     * true tomorrow.
     *
     * Absent for documents created outside any conversation. Never inferred:
     * a document is bound only when its creator was in a channel.
     */
    channel?: string;
    createdAt: number;
    updatedAt: number;
}
export interface MetadataStore {
    /** Upsert metadata for a document. Last writer wins. */
    putDocument(meta: DocumentMeta): Promise<void>;
    /** Fetch metadata for a document, or `null` if it doesn't exist. */
    getDocument(documentId: string): Promise<DocumentMeta | null>;
    /**
     * List documents, optionally filtered by `ownerId` and/or `docType`.
     * Implementations return newest-first by `updatedAt`. `limit` is a
     * soft cap; implementations may return fewer.
     */
    listDocuments(opts?: {
        ownerId?: string;
        docType?: string;
        /** Only documents bound to this conversation. */
        channel?: string;
        limit?: number;
    }): Promise<DocumentMeta[]>;
    /** Delete metadata for a document. No-op if it doesn't exist. */
    deleteDocument(documentId: string): Promise<void>;
}
//# sourceMappingURL=MetadataStore.d.ts.map