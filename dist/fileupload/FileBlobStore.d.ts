export declare const DEFAULT_BLOB_DIR = "/var/lib/gateway-uploads";
/** 25 MiB default — overridable via FILEUPLOAD_MAX_BYTES. */
export declare const DEFAULT_MAX_BYTES: number;
export declare function resolveBlobDir(env?: NodeJS.ProcessEnv): string;
export declare function resolveMaxBytes(env?: NodeJS.ProcessEnv): number;
/**
 * Reduce a client-supplied uploadId to a filesystem-safe token. Strips
 * anything outside [A-Za-z0-9_-], which neutralises path-traversal (`/`,
 * `\`, `.`) and null bytes. An id that sanitizes to empty is rejected by
 * the caller (returns '').
 */
export declare function sanitizeUploadId(uploadId: string): string;
export interface BlobStat {
    size: number;
}
export declare class FileBlobStore {
    readonly baseDir: string;
    constructor(opts?: {
        baseDir?: string;
    });
    /** Absolute path for a (sanitized) uploadId, or null if id is invalid. */
    pathFor(uploadId: string): string | null;
    /**
     * Stream `source` into the blob for `uploadId`, enforcing `maxBytes`.
     * Resolves with the number of bytes written. Rejects with a
     * `code: 'TOO_LARGE'` error if the stream exceeds the cap (the partial
     * file is unlinked). Any other write error rejects and the partial is
     * best-effort unlinked too, so a half-written blob never lingers.
     */
    putStream(uploadId: string, source: NodeJS.ReadableStream, maxBytes: number): Promise<number>;
    /** fs.stat the blob; null if it doesn't exist. */
    stat(uploadId: string): Promise<BlobStat | null>;
    /** Open a read stream for the blob, or null if it doesn't exist. */
    createReadStream(uploadId: string): NodeJS.ReadableStream | null;
    /** Best-effort delete (used by cancel). Never throws. */
    delete(uploadId: string): Promise<void>;
}
//# sourceMappingURL=FileBlobStore.d.ts.map