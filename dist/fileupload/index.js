"use strict";
// realtime-modules/src/fileupload/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/fileupload`.
//
// v0.18.0 — extracted from websocket-gateway. FileBlobStore (local-fs blob
// dir) travels as the zero-config default; metadata persistence is the
// FileUploadMetadataStore interface (in-memory default here, the gateway
// keeps its DynamoDB repository, which satisfies it structurally); channel
// authz is an injected hook. The gateway keeps its HTTP upload-routes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_BYTES = exports.DEFAULT_BLOB_DIR = exports.sanitizeUploadId = exports.resolveBlobDir = exports.resolveMaxBytes = exports.FileBlobStore = exports.InMemoryFileUploadMetadataStore = exports.FileUploadService = void 0;
var FileUploadService_1 = require("./FileUploadService");
Object.defineProperty(exports, "FileUploadService", { enumerable: true, get: function () { return FileUploadService_1.FileUploadService; } });
var FileUploadService_2 = require("./FileUploadService");
Object.defineProperty(exports, "InMemoryFileUploadMetadataStore", { enumerable: true, get: function () { return FileUploadService_2.InMemoryFileUploadMetadataStore; } });
var FileBlobStore_1 = require("./FileBlobStore");
Object.defineProperty(exports, "FileBlobStore", { enumerable: true, get: function () { return FileBlobStore_1.FileBlobStore; } });
Object.defineProperty(exports, "resolveMaxBytes", { enumerable: true, get: function () { return FileBlobStore_1.resolveMaxBytes; } });
Object.defineProperty(exports, "resolveBlobDir", { enumerable: true, get: function () { return FileBlobStore_1.resolveBlobDir; } });
Object.defineProperty(exports, "sanitizeUploadId", { enumerable: true, get: function () { return FileBlobStore_1.sanitizeUploadId; } });
Object.defineProperty(exports, "DEFAULT_BLOB_DIR", { enumerable: true, get: function () { return FileBlobStore_1.DEFAULT_BLOB_DIR; } });
Object.defineProperty(exports, "DEFAULT_MAX_BYTES", { enumerable: true, get: function () { return FileBlobStore_1.DEFAULT_MAX_BYTES; } });
//# sourceMappingURL=index.js.map