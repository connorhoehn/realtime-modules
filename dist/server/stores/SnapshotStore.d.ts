/**
 * Prep interface for the CRDT-extraction Cut 1.
 *
 * `SnapshotStore` abstracts the durable snapshot-persistence surface that
 * `SnapshotManager.ts` currently implements directly against
 * `@aws-sdk/client-dynamodb` (PutItem / Query). `HotCache` abstracts the
 * Redis `setEx` / `get` / `del` calls.
 *
 * This file is *purely additive* — the existing `SnapshotManager` is
 * unchanged. Cut 1 will refactor SnapshotManager to depend on these
 * interfaces instead of the AWS-SDK clients directly, at which point the
 * MemoryStore implementation in this directory makes the module usable in
 * tests, dev mode, and zero-config consumers (e.g. app #2).
 *
 * Field-shape notes (load-bearing for the future extraction):
 *
 *   - `gzippedBytes`: snapshots are stored on disk gzipped (see
 *     `SnapshotManager.writeSnapshot`'s `gzip(Buffer.from(stateUpdate))`
 *     call). The store contract preserves that — adapters compress / hand
 *     bytes to the wire; SnapshotManager keeps doing the gzip itself so
 *     this contract stays storage-agnostic. Implementations MUST round-
 *     trip `gzippedBytes` byte-for-byte.
 *
 *   - `timestamp` is the DDB sort key (millisecond epoch) and is also
 *     used as the human-facing "version id" in restore APIs.
 *
 *   - `versionName` is optional because the existing data set has many
 *     null entries (anonymous auto-snapshots).
 *
 *   - `VersionMeta.size` is sourced from `sizeBytes` in DDB and may be
 *     `0` for legacy rows where the field was not yet recorded.
 */
export interface VersionMeta {
    channelId: string;
    timestamp: number;
    versionName?: string;
    size: number;
}
export interface SnapshotStore {
    /**
     * Write a gzipped snapshot for `channelId`. Implementations decide the
     * TTL policy (DDB adapter mirrors SnapshotManager._computeTtl;
     * MemoryStore keeps everything until the process exits).
     */
    putSnapshot(channelId: string, gzippedBytes: Buffer, meta: {
        timestamp: number;
        versionName?: string;
    }): Promise<void>;
    /**
     * Most-recent snapshot for `channelId`, or `null` if none exist.
     * Returned `bytes` are still gzipped — the caller (Cut 1 SnapshotManager)
     * decompresses.
     */
    getLatestSnapshot(channelId: string): Promise<{
        bytes: Buffer;
        timestamp: number;
        versionName?: string;
    } | null>;
    /**
     * Most-recent N versions for `channelId`, newest first. Used to power
     * the version-history UI.
     */
    listVersions(channelId: string, limit: number): Promise<VersionMeta[]>;
    /**
     * Exact-version lookup by sort-key `timestamp`. Returns `null` if the
     * version was never written or has expired via TTL.
     */
    getVersion(channelId: string, timestamp: number): Promise<Buffer | null>;
}
/**
 * Redis-style hot cache. Used by SnapshotManager today as
 * `crdt:snapshot:<channelId>` -> base64-encoded raw (uncompressed) Y.js
 * update bytes. Cut 1 keeps the existing key shape — this interface just
 * decouples it from the `node-redis` v4 client surface.
 *
 * Note: callers pass `Buffer` (not base64 strings) so adapters are free
 * to choose their on-wire encoding. The existing Redis path currently
 * stores base64 strings; the new SnapshotManager will hand the raw Buffer
 * to the cache and the Redis adapter will encode internally.
 */
export interface HotCache {
    get(key: string): Promise<Buffer | null>;
    setEx(key: string, ttlSec: number, value: Buffer): Promise<void>;
    del(key: string): Promise<void>;
}
//# sourceMappingURL=SnapshotStore.d.ts.map