/**
 * Shared configuration constants for the CRDT server modules.
 * Lifted from src/realtime-fanout/crdt/config.ts (gateway origin).
 *
 * Cut 1 lift note: previously imported `tableName` from
 * `../../lib/ddb-table-name`. After the lift, table names are owned by
 * the SnapshotStore / MetadataStore adapters (the adapter chooses the
 * DDB table name; the module no longer touches DDB directly). The
 * SNAPSHOTS_TABLE / DOCUMENTS_TABLE constants are kept for backward-
 * compatibility with any code still reading them, with the prefix
 * helper inlined so this file has no path-walking dependencies on the
 * gateway source tree.
 */
/** Debounce window before writing a snapshot after the last CRDT update (ms). */
export declare const SNAPSHOT_DEBOUNCE_MS: number;
/** Interval for periodic snapshot sweeps across all active channels (ms). */
export declare const SNAPSHOT_INTERVAL_MS: number;
/** Grace period before evicting an idle (0-subscriber) Y.Doc from memory (ms). */
export declare const IDLE_EVICTION_MS: number;
/** Window for coalescing awareness updates before broadcasting (ms). */
export declare const AWARENESS_BATCH_WINDOW_MS = 50;
/** Window for coalescing CRDT operation broadcasts (ms). */
export declare const OPERATION_BATCH_WINDOW_MS = 10;
/** Number of operations before an immediate snapshot is triggered. */
export declare const OPERATIONS_BEFORE_SNAPSHOT = 50;
export declare const SNAPSHOTS_TABLE: string;
export declare const DOCUMENTS_TABLE: string;
/** TTL for Redis snapshot hot-cache entries (seconds). */
export declare const REDIS_SNAPSHOT_TTL_SEC = 3600;
export declare const TTL_30_DAYS_SEC: number;
export declare const TTL_90_DAYS_SEC: number;
export declare const EVENT_BUS_NAME: string;
export declare const TYPE_ICONS: Record<string, string>;
//# sourceMappingURL=config.d.ts.map