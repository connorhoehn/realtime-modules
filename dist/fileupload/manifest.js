"use strict";
// realtime-modules/src/fileupload/manifest.ts
//
// FeatureManifest for the fileupload feature. WS frames negotiate uploads
// (request/complete/cancel) scoped to a channel; the byte transfer itself
// is HTTP PUT/GET against the consumer's mounted upload routes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileUploadManifest = void 0;
exports.FileUploadManifest = {
    name: 'fileupload',
    version: '0.1.0',
    envVars: {
        FILEUPLOAD_PUBLIC_BASE: {
            required: false,
            default: '',
            description: 'Public base URL for the HTTP upload surface (default: root-relative URLs).',
        },
        FILEUPLOAD_BLOB_DIR: {
            required: false,
            default: '/var/lib/gateway-uploads',
            description: 'Local blob directory for FileBlobStore.',
        },
        FILEUPLOAD_MAX_BYTES: {
            required: false,
            default: String(25 * 1024 * 1024),
            description: 'Per-file size cap in bytes.',
        },
    },
    channels: ['*'],
};
//# sourceMappingURL=manifest.js.map