// realtime-modules/src/server/SnapshotManager.ts
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
import * as zlib from 'zlib';
import { promisify } from 'util';

import {
    REDIS_SNAPSHOT_TTL_SEC,
    SNAPSHOT_DEBOUNCE_MS,
} from './config';
import type { HotCache, SnapshotStore } from './stores/SnapshotStore';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

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

class SnapshotManager {
    snapshotStore: SnapshotStore;
    hotCache: HotCache | null;
    logger: any;
    getChannelState: (channelId: string) => ChannelState | undefined;
    snapshotDebounceTimers: Map<string, NodeJS.Timeout>;
    SNAPSHOT_DEBOUNCE_MS: number;

    constructor({ snapshotStore, hotCache, logger, getChannelState }: SnapshotManagerOpts) {
        this.snapshotStore = snapshotStore;
        this.hotCache = hotCache || null;
        this.logger = logger;
        this.getChannelState = getChannelState;

        // Debounced snapshot timers per channel
        this.snapshotDebounceTimers = new Map();
        this.SNAPSHOT_DEBOUNCE_MS = SNAPSHOT_DEBOUNCE_MS;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * No-op in the lifted module. Table provisioning is the SnapshotStore
     * adapter's responsibility. Kept on the surface so the orchestrator
     * wiring stays unchanged.
     */
    async ensureTable(): Promise<void> {
        // Adapter-owned; nothing to do at the service level.
    }

    /**
     * Write a snapshot for a channel via the SnapshotStore.
     *
     * @param channelId
     * @param meta           - Optional version metadata
     * @param meta.author    - userId/displayName or 'auto'
     * @param meta.name      - Optional user-provided version name
     * @param meta.type      - 'auto' | 'manual' | 'pre-restore' | 'pre-clear'
     */
    async writeSnapshot(channelId: string, meta: VersionMeta = {}): Promise<void> {
        const state = this.getChannelState(channelId);
        if (!state || !state.ydoc) {
            return; // No snapshot to write
        }

        try {
            // Encode full state from Y.Doc and gzip compress
            const stateUpdate = Y.encodeStateAsUpdate(state.ydoc);
            if (stateUpdate.byteLength === 0) {
                return; // Empty doc, nothing to persist
            }

            // Always update hot-cache with uncompressed bytes (base64-equivalent
            // semantics; bytes-in, bytes-out at the contract level).
            await this._saveSnapshotToHotCache(channelId, Buffer.from(stateUpdate));

            const compressed = await gzip(Buffer.from(stateUpdate));

            const versionName = meta.name || undefined;
            const timestamp = Date.now();

            await this.snapshotStore.putSnapshot(channelId, compressed, {
                timestamp,
                versionName,
            });

            state.operationsSinceSnapshot = 0;
            const versionType = meta.type || 'auto';
            const author = meta.author || 'auto';
            this.logger.info(`Snapshot written via SnapshotStore for channel ${channelId} (type=${versionType}, author=${author})`);
        } catch (error: any) {
            // Log-and-continue: persistence failure must not crash the gateway
            this.logger.error(`Failed to persist snapshot for ${channelId}:`, error.message);
        }
    }

    /**
     * Retrieve the latest snapshot for a channel from the store.
     *
     * @param channelId
     * @returns Promise<{data: string|null, timestamp: number|null}>
     */
    async retrieveLatestSnapshot(channelId: string): Promise<{ data: string | null; timestamp: number | null }> {
        try {
            const hit = await this.snapshotStore.getLatestSnapshot(channelId);
            if (!hit) {
                return { data: null, timestamp: null };
            }
            const decompressed = await gunzip(hit.bytes);
            return { data: decompressed.toString('base64'), timestamp: hit.timestamp };
        } catch (error: any) {
            this.logger.error(`Failed to retrieve snapshot for ${channelId}:`, error.message);
            return { data: null, timestamp: null };
        }
    }

    /**
     * List recent snapshots for a channel (version history).
     */
    async handleListSnapshots(channel: string, limit = 20): Promise<any[]> {
        try {
            const versions = await this.snapshotStore.listVersions(channel, limit);
            const now = Date.now();
            return versions.map((v) => ({
                timestamp: v.timestamp,
                age: now - v.timestamp,
                // Gateway origin exposed these from DDB columns. The lifted
                // store contract doesn't surface them; fall back to the
                // legacy defaults so the wire shape stays compatible.
                type: 'auto',
                author: 'auto',
                name: v.versionName || null,
                sizeBytes: v.size || null,
            }));
        } catch (error: any) {
            this.logger.error(`Failed to list snapshots for ${channel}:`, error.message);
            return [];
        }
    }

    /**
     * Retrieve a specific snapshot by timestamp (version).
     */
    async handleGetSnapshotAtVersion(channel: string, timestamp: number): Promise<{ base64: string; timestamp: number } | null> {
        const bytes = await this.snapshotStore.getVersion(channel, timestamp);
        if (!bytes) return null;

        const decompressed = await gunzip(bytes);
        return { base64: decompressed.toString('base64'), timestamp };
    }

    /**
     * Restore a historical snapshot as the current channel state.
     * Creates a pre-restore checkpoint first, then replaces the Y.Doc.
     */
    async handleRestoreSnapshot(channel: string, timestamp: number): Promise<{ base64State: string; restoredTimestamp: number } | null> {
        const bytes = await this.snapshotStore.getVersion(channel, timestamp);
        if (!bytes) return null;

        // Decompress to get raw Y.js update bytes
        const decompressed = await gunzip(bytes);
        const historicalUpdate = new Uint8Array(decompressed);

        // Get or create the channel state
        const state = this.getChannelState(channel);
        if (!state) {
            return null; // Orchestrator must have a channel state
        }

        // Pre-restore checkpoint: save current state so the operation is reversible
        try {
            const currentState = Y.encodeStateAsUpdate(state.ydoc);
            if (currentState.byteLength > 0) {
                state.operationsSinceSnapshot = 1; // Ensure writeSnapshot actually writes
                await this.writeSnapshot(channel, { type: 'pre-restore', author: 'system' });
                this.logger.info(`Pre-restore checkpoint saved for channel ${channel}`);
            }
        } catch (checkpointErr: any) {
            this.logger.error(`Failed to save pre-restore checkpoint for ${channel}:`, checkpointErr.message);
            // Continue with restore even if checkpoint fails
        }

        // Create a fresh Y.Doc and apply the historical update
        const freshDoc = new Y.Doc();
        Y.applyUpdate(freshDoc, historicalUpdate);
        const fullState = Y.encodeStateAsUpdate(freshDoc);

        // Replace the live channel's Y.Doc
        state.ydoc.destroy();
        state.ydoc = freshDoc;

        const base64State = Buffer.from(fullState).toString('base64');

        // Write a new snapshot for the restored state
        await this.writeSnapshot(channel, { type: 'auto', author: 'system' });

        this.logger.info(`Restored snapshot at version ${timestamp} for channel ${channel}`);

        return { base64State, restoredTimestamp: timestamp };
    }

    /**
     * Save a named version (manual checkpoint) of the current document state.
     */
    async handleSaveVersion(channel: string, name: string, userId?: string): Promise<{ name: string; author: string; timestamp: number } | null> {
        const state = this.getChannelState(channel);
        if (!state || !state.ydoc) {
            return null;
        }

        const author = userId || 'unknown';

        // Force a snapshot write even if operationsSinceSnapshot is 0
        state.operationsSinceSnapshot = 1;
        await this.writeSnapshot(channel, {
            type: 'manual',
            author,
            name: name.trim(),
        });

        const ts = Date.now();
        this.logger.info(`Named version "${name.trim()}" saved for channel ${channel} by ${author}`);

        return { name: name.trim(), author, timestamp: ts };
    }

    /**
     * Write periodic snapshots for all channels with pending operations.
     */
    async writePeriodicSnapshots(channelStates: Map<string, ChannelState>): Promise<void> {
        for (const [channelId, state] of channelStates.entries()) {
            if (state.operationsSinceSnapshot > 0) {
                await this.writeSnapshot(channelId);
            }
        }
    }

    /**
     * Schedule a debounced snapshot write for a channel.
     */
    scheduleDebouncedSnapshot(channelId: string): void {
        const existing = this.snapshotDebounceTimers.get(channelId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(async () => {
            this.snapshotDebounceTimers.delete(channelId);
            const state = this.getChannelState(channelId);
            if (state && state.operationsSinceSnapshot > 0) {
                await this.writeSnapshot(channelId);
            }
        }, this.SNAPSHOT_DEBOUNCE_MS);
        // R2 bug #5: unref so a pending debounced snapshot does not hold
        // the event loop open past graceful shutdown.
        if ((timer as any).unref) (timer as any).unref();
        this.snapshotDebounceTimers.set(channelId, timer);
    }

    /**
     * Cancel a pending debounced snapshot for a channel.
     */
    cancelDebouncedSnapshot(channelId: string): void {
        const timer = this.snapshotDebounceTimers.get(channelId);
        if (timer) {
            clearTimeout(timer);
            this.snapshotDebounceTimers.delete(channelId);
        }
    }

    /**
     * Clear all debounce timers and flush pending snapshots (for shutdown).
     */
    async flushAndClearTimers(channelStates: Map<string, ChannelState>): Promise<void> {
        for (const [channelId, timer] of this.snapshotDebounceTimers.entries()) {
            clearTimeout(timer);
            const state = channelStates.get(channelId);
            if (state && state.operationsSinceSnapshot > 0) {
                try {
                    await this.writeSnapshot(channelId);
                } catch (err: any) {
                    this.logger.error(`Failed to write final snapshot for ${channelId} during shutdown:`, err.message);
                }
            }
        }
        this.snapshotDebounceTimers.clear();
    }

    // ------------------------------------------------------------------
    // Y.Doc hydration (HotCache → SnapshotStore fallback)
    // ------------------------------------------------------------------

    async hydrateYDoc(channel: string, state: ChannelState): Promise<void> {
        let base64: string | null = null;
        let source = 'none';

        // Try hot-cache first
        try {
            base64 = await this.getSnapshotFromRedis(channel);
            if (base64) source = 'cache';
        } catch (err: any) {
            this.logger.error(`Hot-cache hydration failed for ${channel}, falling back to durable store:`, err.message);
        }

        // Fall back to durable store
        if (!base64) {
            try {
                const dbResult = await this.retrieveLatestSnapshot(channel);
                if (dbResult.data) {
                    base64 = dbResult.data;
                    source = 'store';
                }
            } catch (err: any) {
                this.logger.error(`Store hydration failed for ${channel}:`, err.message);
            }
        }

        if (base64) {
            try {
                const update = new Uint8Array(Buffer.from(base64, 'base64'));
                Y.applyUpdate(state.ydoc, update);
                this.logger.info(`Y.Doc hydrated from ${source} for channel ${channel}`);
            } catch (err: any) {
                this.logger.error(`Failed to apply hydration update for ${channel}:`, err.message);
            }
        } else {
            this.logger.info(`No existing snapshot for channel ${channel} — starting fresh`);
        }
    }

    // ------------------------------------------------------------------
    // handleClearDocument
    // ------------------------------------------------------------------

    async handleClearDocument(
        clientId: string,
        data: { channel: string },
        channelStates: Map<string, ChannelState>,
        sendToClient: (clientId: string, message: any) => void,
        sendError: (clientId: string, message: string) => void
    ): Promise<void> {
        const channel = data.channel;
        if (!channel) {
            sendError(clientId, 'Channel name is required');
            return;
        }

        const state = channelStates.get(channel);
        if (!state || !state.ydoc) {
            sendError(clientId, 'No active document for channel');
            return;
        }

        // Pre-clear checkpoint so the operation is reversible
        try {
            const currentState = Y.encodeStateAsUpdate(state.ydoc);
            if (currentState.byteLength > 0) {
                state.operationsSinceSnapshot = 1;
                await this.writeSnapshot(channel, { type: 'pre-clear', author: clientId });
                this.logger.info(`Pre-clear checkpoint saved for channel ${channel}`);
            }
        } catch (err: any) {
            this.logger.error(`Failed pre-clear checkpoint for ${channel}:`, err.message);
        }

        // Replace with fresh Y.Doc
        state.ydoc.destroy();
        state.ydoc = new Y.Doc();
        state.operationsSinceSnapshot = 0;

        const emptyStateBytes = Y.encodeStateAsUpdate(state.ydoc);
        const emptyState = Buffer.from(emptyStateBytes).toString('base64');

        // Persist the cleared state
        await this.writeSnapshot(channel, { type: 'auto', author: clientId });

        // Update hot-cache
        await this._saveSnapshotToHotCache(channel, Buffer.from(emptyStateBytes));

        sendToClient(clientId, {
            type: 'crdt',
            action: 'documentCleared',
            channel,
            update: emptyState,
        });

        this.logger.info(`Document cleared for channel ${channel} by ${clientId}`);
    }

    // ------------------------------------------------------------------
    // Shutdown
    // ------------------------------------------------------------------

    async shutdown(channelStates: Map<string, ChannelState>): Promise<void> {
        return this.flushAndClearTimers(channelStates);
    }

    // ------------------------------------------------------------------
    // HotCache helpers
    // ------------------------------------------------------------------

    private async _saveSnapshotToHotCache(channelId: string, rawBytes: Buffer): Promise<void> {
        if (!this.hotCache) return;
        try {
            const key = `crdt:snapshot:${channelId}`;
            await this.hotCache.setEx(key, REDIS_SNAPSHOT_TTL_SEC, rawBytes);
            this.logger.info(`Hot-cache snapshot stored for channel ${channelId}`);
        } catch (err: any) {
            this.logger.error(`Failed to cache snapshot for ${channelId}:`, err.message);
        }
    }

    /**
     * Retrieve a snapshot from the hot-cache. Public for gateway-origin
     * compatibility (the orchestrator calls this directly during
     * hydrateYDoc). Returns a base64 string for symmetry with the
     * gateway-origin Redis path (Redis stored base64; the hot-cache
     * adapter stores raw bytes — this helper re-encodes).
     */
    async getSnapshotFromRedis(channelId: string): Promise<string | null> {
        if (!this.hotCache) return null;
        try {
            const key = `crdt:snapshot:${channelId}`;
            const data = await this.hotCache.get(key);
            if (data) {
                this.logger.info(`Hot-cache hit for channel ${channelId}`);
                return data.toString('base64');
            }
            return null;
        } catch (err: any) {
            this.logger.error(`Failed to read snapshot from hot-cache for ${channelId}:`, err.message);
            return null;
        }
    }

    /**
     * Save to hot-cache (non-blocking, fire-and-forget from caller).
     * Accepts a base64-encoded string for gateway-origin compatibility.
     */
    async saveSnapshotToRedis(channelId: string, base64Snapshot: string): Promise<void> {
        const bytes = Buffer.from(base64Snapshot, 'base64');
        return this._saveSnapshotToHotCache(channelId, bytes);
    }
}

export = SnapshotManager;
