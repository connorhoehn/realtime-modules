/**
 * Snapshot / version management for CRDT documents.
 *
 * Handles writing snapshots (debounced, periodic, immediate), retrieving
 * snapshots from the durable store, listing version history, restoring
 * historical versions, and saving named (manual) versions.
 *
 * Lift note (CRDT Cut 1): adapted from
 * src/realtime-fanout/crdt/SnapshotManager.ts. Logic-changes from the
 * gateway original are isolated to the persistence layer:
 *
 *   - `@aws-sdk/client-dynamodb` PutItem/Query is replaced with
 *     `SnapshotStore.putSnapshot / getLatestSnapshot / listVersions /
 *     getVersion`.
 *   - `@aws-sdk/client-eventbridge` PutEvents is removed — the lifted
 *     module always writes through the store. The DDB-backed store
 *     adapter can fan out to EventBridge internally if a deployment
 *     still needs the lambda-processed path (the gateway-origin
 *     orchestrator gated this on `DIRECT_DYNAMO_WRITE=true`; the lifted
 *     module unconditionally uses the store, since the store IS the
 *     write path now).
 *   - The Redis `setEx / get / del` calls become `HotCache.setEx / get
 *     / del` on a `HotCache` instance. The cache key (`crdt:snapshot:
 *     <channelId>`) and 1-hour TTL are unchanged; the cache stores raw
 *     un-compressed bytes (Buffer) and the manager encodes/decodes
 *     base64 at the boundary, matching gateway semantics.
 *   - `ensureTable()` becomes a no-op (adapter-owned).
 *   - Prometheus `recordCrdtSnapshot` is removed — observability is a
 *     consumer concern. The gateway adapter can wrap the store and
 *     record metrics there.
 *
 * Public surface is preserved: writeSnapshot, retrieveLatestSnapshot,
 * handleListSnapshots, handleGetSnapshotAtVersion, handleRestoreSnapshot,
 * handleSaveVersion, writePeriodicSnapshots, scheduleDebouncedSnapshot,
 * cancelDebouncedSnapshot, flushAndClearTimers, hydrateYDoc,
 * handleClearDocument, shutdown, saveSnapshotToRedis,
 * getSnapshotFromRedis.
 */
import * as Y from 'yjs';
import type { HotCache, SnapshotStore } from './stores/SnapshotStore';
interface ChannelState {
    ydoc: Y.Doc;
    operationsSinceSnapshot: number;
    subscriberCount: number;
    hydrated: boolean;
}
interface SnapshotManagerOpts {
    snapshotStore: SnapshotStore;
    /** Optional hot-cache; when omitted Redis-style hits are skipped. */
    hotCache?: HotCache | null;
    logger: any;
    getChannelState: (channelId: string) => ChannelState | undefined;
}
interface VersionMeta {
    type?: string;
    author?: string;
    name?: string;
}
declare class SnapshotManager {
    snapshotStore: SnapshotStore;
    hotCache: HotCache | null;
    logger: any;
    getChannelState: (channelId: string) => ChannelState | undefined;
    snapshotDebounceTimers: Map<string, NodeJS.Timeout>;
    SNAPSHOT_DEBOUNCE_MS: number;
    constructor({ snapshotStore, hotCache, logger, getChannelState }: SnapshotManagerOpts);
    /**
     * No-op in the lifted module. Table provisioning is the SnapshotStore
     * adapter's responsibility. Kept on the surface so the orchestrator
     * wiring stays unchanged.
     */
    ensureTable(): Promise<void>;
    /**
     * Write a snapshot for a channel via the SnapshotStore.
     *
     * @param channelId
     * @param meta           - Optional version metadata
     * @param meta.author    - userId/displayName or 'auto'
     * @param meta.name      - Optional user-provided version name
     * @param meta.type      - 'auto' | 'manual' | 'pre-restore' | 'pre-clear'
     */
    writeSnapshot(channelId: string, meta?: VersionMeta): Promise<void>;
    /**
     * Retrieve the latest snapshot for a channel from the store.
     *
     * @param channelId
     * @returns Promise<{data: string|null, timestamp: number|null}>
     */
    retrieveLatestSnapshot(channelId: string): Promise<{
        data: string | null;
        timestamp: number | null;
    }>;
    /**
     * List recent snapshots for a channel (version history).
     */
    handleListSnapshots(channel: string, limit?: number): Promise<any[]>;
    /**
     * Retrieve a specific snapshot by timestamp (version).
     */
    handleGetSnapshotAtVersion(channel: string, timestamp: number): Promise<{
        base64: string;
        timestamp: number;
    } | null>;
    /**
     * Restore a historical snapshot as the current channel state.
     * Creates a pre-restore checkpoint first, then replaces the Y.Doc.
     */
    handleRestoreSnapshot(channel: string, timestamp: number): Promise<{
        base64State: string;
        restoredTimestamp: number;
    } | null>;
    /**
     * Save a named version (manual checkpoint) of the current document state.
     */
    handleSaveVersion(channel: string, name: string, userId?: string): Promise<{
        name: string;
        author: string;
        timestamp: number;
    } | null>;
    /**
     * Write periodic snapshots for all channels with pending operations.
     */
    writePeriodicSnapshots(channelStates: Map<string, ChannelState>): Promise<void>;
    /**
     * Schedule a debounced snapshot write for a channel.
     */
    scheduleDebouncedSnapshot(channelId: string): void;
    /**
     * Cancel a pending debounced snapshot for a channel.
     */
    cancelDebouncedSnapshot(channelId: string): void;
    /**
     * Clear all debounce timers and flush pending snapshots (for shutdown).
     */
    flushAndClearTimers(channelStates: Map<string, ChannelState>): Promise<void>;
    hydrateYDoc(channel: string, state: ChannelState): Promise<void>;
    handleClearDocument(clientId: string, data: {
        channel: string;
    }, channelStates: Map<string, ChannelState>, sendToClient: (clientId: string, message: any) => void, sendError: (clientId: string, message: string) => void): Promise<void>;
    shutdown(channelStates: Map<string, ChannelState>): Promise<void>;
    private _saveSnapshotToHotCache;
    /**
     * Retrieve a snapshot from the hot-cache. Public for gateway-origin
     * compatibility (the orchestrator calls this directly during
     * hydrateYDoc). Returns a base64 string for symmetry with the
     * gateway-origin Redis path (Redis stored base64; the hot-cache
     * adapter stores raw bytes — this helper re-encodes).
     */
    getSnapshotFromRedis(channelId: string): Promise<string | null>;
    /**
     * Save to hot-cache (non-blocking, fire-and-forget from caller).
     * Accepts a base64-encoded string for gateway-origin compatibility.
     */
    saveSnapshotToRedis(channelId: string, base64Snapshot: string): Promise<void>;
}
export = SnapshotManager;
//# sourceMappingURL=SnapshotManager.d.ts.map