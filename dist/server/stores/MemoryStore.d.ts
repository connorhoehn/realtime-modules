/**
 * In-memory implementations of `SnapshotStore`, `MetadataStore`, and
 * `HotCache`. Intended for:
 *
 *   - unit tests (no DDB-local / Redis-local needed),
 *   - dev mode when shared backing services are off,
 *   - zero-config consumers (app #2 embedded use) that don't want AWS.
 *
 *  Purely additive — none of the existing CRDT files import these yet.
 *  Cut 1 wires them in.
 *
 * Implementation notes:
 *
 *   - All three classes are independent and keep state in private Maps.
 *   - Snapshots are stored byte-for-byte (Buffer copy on the way in) so
 *     callers can mutate their source buffers without corrupting state.
 *   - HotCache TTL is enforced lazily on `get()` — there is no background
 *     sweeper. This matches Redis semantics closely enough for tests and
 *     keeps the class fully synchronous-deterministic under fake timers.
 *   - MetadataStore.listDocuments filters in JS (no index), returning
 *     newest-first by `updatedAt`.
 */
import type { HotCache, SnapshotStore, VersionMeta } from './SnapshotStore';
import type { DocumentMeta, MetadataStore } from './MetadataStore';
export declare class MemorySnapshotStore implements SnapshotStore {
    private readonly snapshots;
    putSnapshot(channelId: string, gzippedBytes: Buffer, meta: {
        timestamp: number;
        versionName?: string;
    }): Promise<void>;
    getLatestSnapshot(channelId: string): Promise<{
        bytes: Buffer;
        timestamp: number;
        versionName?: string;
    } | null>;
    listVersions(channelId: string, limit: number): Promise<VersionMeta[]>;
    getVersion(channelId: string, timestamp: number): Promise<Buffer | null>;
    /** Test helper — clears every channel. Not part of SnapshotStore. */
    _reset(): void;
}
export declare class MemoryMetadataStore implements MetadataStore {
    private readonly docs;
    putDocument(meta: DocumentMeta): Promise<void>;
    getDocument(documentId: string): Promise<DocumentMeta | null>;
    listDocuments(opts?: {
        ownerId?: string;
        docType?: string;
        limit?: number;
    }): Promise<DocumentMeta[]>;
    deleteDocument(documentId: string): Promise<void>;
    /** Test helper — clears every document. Not part of MetadataStore. */
    _reset(): void;
}
export declare class MemoryHotCache implements HotCache {
    private readonly entries;
    get(key: string): Promise<Buffer | null>;
    setEx(key: string, ttlSec: number, value: Buffer): Promise<void>;
    del(key: string): Promise<void>;
    /** Test helper — clears every key. Not part of HotCache. */
    _reset(): void;
}
//# sourceMappingURL=MemoryStore.d.ts.map