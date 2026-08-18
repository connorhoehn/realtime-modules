"use strict";
// realtime-modules/src/fileupload/FileBlobStore.ts
//
// Filesystem-backed blob store for the gateway-native file-upload service.
//
// HARD RULE (operator, 2026-06-04): NO CLOUD SDKs. Blob bytes live on a
// plain filesystem directory (env FILEUPLOAD_BLOB_DIR, default
// /var/lib/gateway-uploads) — mirroring platform-api's IMAGE_BLOB_STORE=fs
// precedent (VolumeImageBlobStore → hostPath). No S3, no presigned AWS URLs.
//
// Blob layout on disk:
//
//   <FILEUPLOAD_BLOB_DIR>/<shard>/<uploadId>
//
// where <shard> is the first 2 chars of the uploadId (lower-cased, sanitized)
// — a cheap fan-out so a single directory never accumulates millions of
// entries. uploadIds are client-generated (crypto.randomUUID() in
// useFileUpload), so they're already high-entropy; the shard is purely an
// inode-density hedge, not a security boundary.
//
// The uploadId is sanitized to a filesystem-safe token before it ever
// touches a path — a hostile client could otherwise smuggle `../` segments
// in the id and escape the blob root. See sanitizeUploadId().
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileBlobStore = exports.DEFAULT_MAX_BYTES = exports.DEFAULT_BLOB_DIR = void 0;
exports.resolveBlobDir = resolveBlobDir;
exports.resolveMaxBytes = resolveMaxBytes;
exports.sanitizeUploadId = sanitizeUploadId;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.DEFAULT_BLOB_DIR = '/var/lib/gateway-uploads';
/** 25 MiB default — overridable via FILEUPLOAD_MAX_BYTES. */
exports.DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
function resolveBlobDir(env = process.env) {
    const raw = (env.FILEUPLOAD_BLOB_DIR || '').trim();
    return raw || exports.DEFAULT_BLOB_DIR;
}
function resolveMaxBytes(env = process.env) {
    const raw = (env.FILEUPLOAD_MAX_BYTES || '').trim();
    if (!raw)
        return exports.DEFAULT_MAX_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : exports.DEFAULT_MAX_BYTES;
}
/**
 * Reduce a client-supplied uploadId to a filesystem-safe token. Strips
 * anything outside [A-Za-z0-9_-], which neutralises path-traversal (`/`,
 * `\`, `.`) and null bytes. An id that sanitizes to empty is rejected by
 * the caller (returns '').
 */
function sanitizeUploadId(uploadId) {
    if (typeof uploadId !== 'string')
        return '';
    return uploadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
}
class FileBlobStore {
    baseDir;
    constructor(opts = {}) {
        this.baseDir = opts.baseDir || resolveBlobDir();
    }
    /** Absolute path for a (sanitized) uploadId, or null if id is invalid. */
    pathFor(uploadId) {
        const safe = sanitizeUploadId(uploadId);
        if (!safe)
            return null;
        const shard = safe.slice(0, 2).toLowerCase();
        const full = path.join(this.baseDir, shard, safe);
        // Defence-in-depth: ensure the resolved path is still under baseDir.
        const resolvedBase = path.resolve(this.baseDir);
        const resolvedFull = path.resolve(full);
        if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + path.sep)) {
            return null;
        }
        return full;
    }
    /**
     * Stream `source` into the blob for `uploadId`, enforcing `maxBytes`.
     * Resolves with the number of bytes written. Rejects with a
     * `code: 'TOO_LARGE'` error if the stream exceeds the cap (the partial
     * file is unlinked). Any other write error rejects and the partial is
     * best-effort unlinked too, so a half-written blob never lingers.
     */
    putStream(uploadId, source, maxBytes) {
        return new Promise((resolve, reject) => {
            const target = this.pathFor(uploadId);
            if (!target) {
                reject(Object.assign(new Error('invalid upload id'), { code: 'BAD_ID' }));
                return;
            }
            fs.mkdir(path.dirname(target), { recursive: true }, (mkErr) => {
                if (mkErr) {
                    reject(mkErr);
                    return;
                }
                let received = 0;
                let aborted = false;
                const out = fs.createWriteStream(target);
                const cleanup = (cb) => {
                    fs.unlink(target, () => cb());
                };
                const fail = (err) => {
                    if (aborted)
                        return;
                    aborted = true;
                    try {
                        source.unpipe?.(out);
                    }
                    catch { /* */ }
                    out.destroy();
                    cleanup(() => reject(err));
                };
                source.on('data', (chunk) => {
                    if (aborted)
                        return;
                    received += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
                    if (received > maxBytes) {
                        fail(Object.assign(new Error(`upload exceeds ${maxBytes} byte cap`), { code: 'TOO_LARGE' }));
                    }
                });
                source.on('error', (err) => fail(err));
                out.on('error', (err) => fail(err));
                out.on('finish', () => {
                    if (aborted)
                        return;
                    resolve(received);
                });
                source.pipe(out);
            });
        });
    }
    /** fs.stat the blob; null if it doesn't exist. */
    stat(uploadId) {
        return new Promise((resolve) => {
            const target = this.pathFor(uploadId);
            if (!target) {
                resolve(null);
                return;
            }
            fs.stat(target, (err, stats) => {
                if (err || !stats.isFile()) {
                    resolve(null);
                    return;
                }
                resolve({ size: stats.size });
            });
        });
    }
    /** Open a read stream for the blob, or null if it doesn't exist. */
    createReadStream(uploadId) {
        const target = this.pathFor(uploadId);
        if (!target)
            return null;
        try {
            if (!fs.existsSync(target))
                return null;
            return fs.createReadStream(target);
        }
        catch {
            return null;
        }
    }
    /** Best-effort delete (used by cancel). Never throws. */
    delete(uploadId) {
        return new Promise((resolve) => {
            const target = this.pathFor(uploadId);
            if (!target) {
                resolve();
                return;
            }
            fs.unlink(target, () => resolve());
        });
    }
}
exports.FileBlobStore = FileBlobStore;
//# sourceMappingURL=FileBlobStore.js.map