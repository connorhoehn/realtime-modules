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

import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_BLOB_DIR = '/var/lib/gateway-uploads';

/** 25 MiB default — overridable via FILEUPLOAD_MAX_BYTES. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export function resolveBlobDir(env: NodeJS.ProcessEnv = process.env): string {
    const raw = (env.FILEUPLOAD_BLOB_DIR || '').trim();
    return raw || DEFAULT_BLOB_DIR;
}

export function resolveMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
    const raw = (env.FILEUPLOAD_MAX_BYTES || '').trim();
    if (!raw) return DEFAULT_MAX_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

/**
 * Reduce a client-supplied uploadId to a filesystem-safe token. Strips
 * anything outside [A-Za-z0-9_-], which neutralises path-traversal (`/`,
 * `\`, `.`) and null bytes. An id that sanitizes to empty is rejected by
 * the caller (returns '').
 */
export function sanitizeUploadId(uploadId: string): string {
    if (typeof uploadId !== 'string') return '';
    return uploadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
}

export interface BlobStat {
    size: number;
}

export class FileBlobStore {
    readonly baseDir: string;

    constructor(opts: { baseDir?: string } = {}) {
        this.baseDir = opts.baseDir || resolveBlobDir();
    }

    /** Absolute path for a (sanitized) uploadId, or null if id is invalid. */
    pathFor(uploadId: string): string | null {
        const safe = sanitizeUploadId(uploadId);
        if (!safe) return null;
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
    putStream(
        uploadId: string,
        source: NodeJS.ReadableStream,
        maxBytes: number,
    ): Promise<number> {
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

                const cleanup = (cb: () => void) => {
                    fs.unlink(target, () => cb());
                };

                const fail = (err: NodeJS.ErrnoException) => {
                    if (aborted) return;
                    aborted = true;
                    try { source.unpipe?.(out); } catch { /* */ }
                    out.destroy();
                    cleanup(() => reject(err));
                };

                source.on('data', (chunk: Buffer | string) => {
                    if (aborted) return;
                    received += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
                    if (received > maxBytes) {
                        fail(Object.assign(new Error(`upload exceeds ${maxBytes} byte cap`), { code: 'TOO_LARGE' }));
                    }
                });
                source.on('error', (err: NodeJS.ErrnoException) => fail(err));
                out.on('error', (err: NodeJS.ErrnoException) => fail(err));
                out.on('finish', () => {
                    if (aborted) return;
                    resolve(received);
                });

                source.pipe(out);
            });
        });
    }

    /** fs.stat the blob; null if it doesn't exist. */
    stat(uploadId: string): Promise<BlobStat | null> {
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
    createReadStream(uploadId: string): NodeJS.ReadableStream | null {
        const target = this.pathFor(uploadId);
        if (!target) return null;
        try {
            if (!fs.existsSync(target)) return null;
            return fs.createReadStream(target);
        } catch {
            return null;
        }
    }

    /** Best-effort delete (used by cancel). Never throws. */
    delete(uploadId: string): Promise<void> {
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
