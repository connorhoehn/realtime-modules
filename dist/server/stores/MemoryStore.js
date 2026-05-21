"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryHotCache = exports.MemoryMetadataStore = exports.MemorySnapshotStore = void 0;
class MemorySnapshotStore {
    snapshots = new Map();
    async putSnapshot(channelId, gzippedBytes, meta) {
        const bucket = this.snapshots.get(channelId) ?? [];
        // Defensive copy so callers can mutate their buffer freely.
        const copy = Buffer.from(gzippedBytes);
        bucket.push({
            bytes: copy,
            timestamp: meta.timestamp,
            versionName: meta.versionName,
        });
        // Maintain newest-first ordering so listVersions/getLatest are O(1).
        bucket.sort((a, b) => b.timestamp - a.timestamp);
        this.snapshots.set(channelId, bucket);
    }
    async getLatestSnapshot(channelId) {
        const bucket = this.snapshots.get(channelId);
        if (!bucket || bucket.length === 0)
            return null;
        const latest = bucket[0];
        return {
            bytes: Buffer.from(latest.bytes),
            timestamp: latest.timestamp,
            versionName: latest.versionName,
        };
    }
    async listVersions(channelId, limit) {
        const bucket = this.snapshots.get(channelId);
        if (!bucket || bucket.length === 0)
            return [];
        return bucket.slice(0, Math.max(0, limit)).map((s) => ({
            channelId,
            timestamp: s.timestamp,
            versionName: s.versionName,
            size: s.bytes.length,
        }));
    }
    async getVersion(channelId, timestamp) {
        const bucket = this.snapshots.get(channelId);
        if (!bucket)
            return null;
        const hit = bucket.find((s) => s.timestamp === timestamp);
        return hit ? Buffer.from(hit.bytes) : null;
    }
    /** Test helper — clears every channel. Not part of SnapshotStore. */
    _reset() {
        this.snapshots.clear();
    }
}
exports.MemorySnapshotStore = MemorySnapshotStore;
class MemoryMetadataStore {
    docs = new Map();
    async putDocument(meta) {
        // Shallow clone so caller mutations don't leak into storage.
        this.docs.set(meta.documentId, { ...meta });
    }
    async getDocument(documentId) {
        const hit = this.docs.get(documentId);
        return hit ? { ...hit } : null;
    }
    async listDocuments(opts) {
        let result = [...this.docs.values()];
        if (opts?.ownerId !== undefined) {
            result = result.filter((d) => d.ownerId === opts.ownerId);
        }
        if (opts?.docType !== undefined) {
            result = result.filter((d) => d.docType === opts.docType);
        }
        // Newest-first by updatedAt, matching DocumentMetadataService.
        result.sort((a, b) => b.updatedAt - a.updatedAt);
        if (opts?.limit !== undefined && opts.limit >= 0) {
            result = result.slice(0, opts.limit);
        }
        return result.map((d) => ({ ...d }));
    }
    async deleteDocument(documentId) {
        this.docs.delete(documentId);
    }
    /** Test helper — clears every document. Not part of MetadataStore. */
    _reset() {
        this.docs.clear();
    }
}
exports.MemoryMetadataStore = MemoryMetadataStore;
class MemoryHotCache {
    entries = new Map();
    async get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return null;
        if (Date.now() >= entry.expiresAt) {
            this.entries.delete(key);
            return null;
        }
        return Buffer.from(entry.value);
    }
    async setEx(key, ttlSec, value) {
        const expiresAt = ttlSec > 0 ? Date.now() + ttlSec * 1000 : Infinity;
        this.entries.set(key, {
            value: Buffer.from(value),
            expiresAt,
        });
    }
    async del(key) {
        this.entries.delete(key);
    }
    /** Test helper — clears every key. Not part of HotCache. */
    _reset() {
        this.entries.clear();
    }
}
exports.MemoryHotCache = MemoryHotCache;
//# sourceMappingURL=MemoryStore.js.map