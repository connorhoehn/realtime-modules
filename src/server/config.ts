// realtime-modules/src/server/config.ts
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
//
// ---------------------------------------------------------------------------
// Timing / batching
// ---------------------------------------------------------------------------

/** Debounce window before writing a snapshot after the last CRDT update (ms). */
export const SNAPSHOT_DEBOUNCE_MS = parseInt(process.env.SNAPSHOT_DEBOUNCE_MS || '5000', 10);

/** Interval for periodic snapshot sweeps across all active channels (ms). */
export const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '300000', 10);

/** Grace period before evicting an idle (0-subscriber) Y.Doc from memory (ms). */
export const IDLE_EVICTION_MS = parseInt(process.env.IDLE_EVICTION_MS || '600000', 10);

/** Window for coalescing awareness updates before broadcasting (ms). */
export const AWARENESS_BATCH_WINDOW_MS = 50;

/** Window for coalescing CRDT operation broadcasts (ms). */
export const OPERATION_BATCH_WINDOW_MS = 10;

/** Number of operations before an immediate snapshot is triggered. */
export const OPERATIONS_BEFORE_SNAPSHOT = 50;

// ---------------------------------------------------------------------------
// DynamoDB table names (now informational — adapters own the real names)
// ---------------------------------------------------------------------------

const tableName = (base: string): string =>
    `${process.env.DDB_TABLE_PREFIX ?? ''}${base}`;

export const SNAPSHOTS_TABLE = tableName(process.env.DYNAMODB_CRDT_TABLE || 'crdt-snapshots');
export const DOCUMENTS_TABLE = tableName(process.env.DYNAMODB_DOCUMENTS_TABLE || 'crdt-documents');

// ---------------------------------------------------------------------------
// Redis cache settings
// ---------------------------------------------------------------------------

/** TTL for Redis snapshot hot-cache entries (seconds). */
export const REDIS_SNAPSHOT_TTL_SEC = 3600; // 1 hour

// ---------------------------------------------------------------------------
// DynamoDB TTL values (seconds from now) — used by SnapshotStore adapters
// ---------------------------------------------------------------------------

export const TTL_30_DAYS_SEC = 30 * 24 * 60 * 60;
export const TTL_90_DAYS_SEC = 90 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// EventBridge bus name (informational — the lifted module does not publish
// directly; this is kept so an EventBridge-backed SnapshotStore adapter can
// honour the same convention if desired).
// ---------------------------------------------------------------------------

export const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'social-events';

// ---------------------------------------------------------------------------
// Default document type icons
// ---------------------------------------------------------------------------

export const TYPE_ICONS: Record<string, string> = {
    meeting: '\u{1F4DD}', sprint: '\u{1F680}', design: '\u{1F3A8}', project: '\u{1F4CB}',
    decision: '⚖️', retro: '\u{1F504}', custom: '\u{1F4C4}',
};
