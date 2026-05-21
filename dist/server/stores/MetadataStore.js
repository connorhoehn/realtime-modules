"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=MetadataStore.js.map