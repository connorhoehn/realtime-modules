"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TYPE_ICONS = exports.EVENT_BUS_NAME = exports.TTL_90_DAYS_SEC = exports.TTL_30_DAYS_SEC = exports.REDIS_SNAPSHOT_TTL_SEC = exports.DOCUMENTS_TABLE = exports.SNAPSHOTS_TABLE = exports.OPERATIONS_BEFORE_SNAPSHOT = exports.OPERATION_BATCH_WINDOW_MS = exports.AWARENESS_BATCH_WINDOW_MS = exports.IDLE_EVICTION_MS = exports.SNAPSHOT_INTERVAL_MS = exports.SNAPSHOT_DEBOUNCE_MS = void 0;
/** Debounce window before writing a snapshot after the last CRDT update (ms). */
exports.SNAPSHOT_DEBOUNCE_MS = parseInt(process.env.SNAPSHOT_DEBOUNCE_MS || '5000', 10);
/** Interval for periodic snapshot sweeps across all active channels (ms). */
exports.SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '300000', 10);
/** Grace period before evicting an idle (0-subscriber) Y.Doc from memory (ms). */
exports.IDLE_EVICTION_MS = parseInt(process.env.IDLE_EVICTION_MS || '600000', 10);
/** Window for coalescing awareness updates before broadcasting (ms). */
exports.AWARENESS_BATCH_WINDOW_MS = 50;
/** Window for coalescing CRDT operation broadcasts (ms). */
exports.OPERATION_BATCH_WINDOW_MS = 10;
/** Number of operations before an immediate snapshot is triggered. */
exports.OPERATIONS_BEFORE_SNAPSHOT = 50;
// ---------------------------------------------------------------------------
// DynamoDB table names (now informational — adapters own the real names)
// ---------------------------------------------------------------------------
const tableName = (base) => `${process.env.DDB_TABLE_PREFIX ?? ''}${base}`;
exports.SNAPSHOTS_TABLE = tableName(process.env.DYNAMODB_CRDT_TABLE || 'crdt-snapshots');
exports.DOCUMENTS_TABLE = tableName(process.env.DYNAMODB_DOCUMENTS_TABLE || 'crdt-documents');
// ---------------------------------------------------------------------------
// Redis cache settings
// ---------------------------------------------------------------------------
/** TTL for Redis snapshot hot-cache entries (seconds). */
exports.REDIS_SNAPSHOT_TTL_SEC = 3600; // 1 hour
// ---------------------------------------------------------------------------
// DynamoDB TTL values (seconds from now) — used by SnapshotStore adapters
// ---------------------------------------------------------------------------
exports.TTL_30_DAYS_SEC = 30 * 24 * 60 * 60;
exports.TTL_90_DAYS_SEC = 90 * 24 * 60 * 60;
// ---------------------------------------------------------------------------
// EventBridge bus name (informational — the lifted module does not publish
// directly; this is kept so an EventBridge-backed SnapshotStore adapter can
// honour the same convention if desired).
// ---------------------------------------------------------------------------
exports.EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'social-events';
// ---------------------------------------------------------------------------
// Default document type icons
// ---------------------------------------------------------------------------
exports.TYPE_ICONS = {
    meeting: '\u{1F4DD}', sprint: '\u{1F680}', design: '\u{1F3A8}', project: '\u{1F4CB}',
    decision: '⚖️', retro: '\u{1F504}', custom: '\u{1F4C4}',
};
//# sourceMappingURL=config.js.map