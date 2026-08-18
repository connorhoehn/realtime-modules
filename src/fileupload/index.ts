// realtime-modules/src/fileupload/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/fileupload`.
//
// v0.18.0 — extracted from websocket-gateway. FileBlobStore (local-fs blob
// dir) travels as the zero-config default; metadata persistence is the
// FileUploadMetadataStore interface (in-memory default here, the gateway
// keeps its DynamoDB repository, which satisfies it structurally); channel
// authz is an injected hook. The gateway keeps its HTTP upload-routes.

export { FileUploadService } from './FileUploadService';
export type {
    FileUploadServiceOptions,
    FileUploadMetadataStore,
    FileUploadRow,
} from './FileUploadService';
export { InMemoryFileUploadMetadataStore } from './FileUploadService';
export { FileBlobStore, resolveMaxBytes, sanitizeUploadId } from './FileBlobStore';
