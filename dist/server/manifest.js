"use strict";
/**
 * FeatureManifest for the document-sharing (CRDT) feature.
 *
 * Surfaced via `@connorhoehn/realtime-modules/server`. Consumers (gateway,
 * edge-gateway, future realtime-fanout) read this to discover env vars,
 * WS channel patterns, and the suggested wiring path without coupling to
 * CRDTService internals.
 *
 * Env-var keys + defaults are mirrored from `./config.ts` so the manifest
 * stays the single source of truth for ops/docs. If you add a new
 * `process.env.*` read in this subpath, add it here too.
 *
 * Wire/channel notes:
 *   - `crdt:*` covers logical CRDT-action channels passed to handleSubscribe;
 *     CRDTService validates name length but does not enforce a prefix.
 *   - `doc:*` is the canonical per-document channel used by createDocument /
 *     deleteDocument / deduplicateSections (`doc:${documentId}`) and by
 *     presence tracking (DocumentPresenceService rejects non-`doc:` channels).
 *   - `activity:broadcast` is the catalog-declared activity bus channel that
 *     DocumentMetadataService publishes `doc.created` to via the
 *     MessageRouter (see DocumentMetadataService.ts handleCreateDocument).
 *
 * Wire-message types (`crdt:update`, `crdt:snapshot`, `crdt:doc-replaced`,
 * `crdt:awareness`) are not channel names — they flow on the channels above.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.crdtManifest = void 0;
exports.crdtManifest = {
    name: 'document-sharing',
    version: '0.1.0',
    envVars: {
        DYNAMODB_CRDT_TABLE: {
            required: false,
            default: 'crdt-snapshots',
            description: 'DDB table for CRDT snapshots (informational — the SnapshotStore adapter owns the real table name).',
        },
        DYNAMODB_DOCUMENTS_TABLE: {
            required: false,
            default: 'crdt-documents',
            description: 'DDB table for document metadata (informational — the MetadataStore adapter owns the real table name).',
        },
        DDB_TABLE_PREFIX: {
            required: false,
            description: 'Optional prefix applied to DDB table names so multiple consumers can share a DDB-local instance without collision.',
        },
        SNAPSHOT_DEBOUNCE_MS: {
            required: false,
            default: '5000',
            description: 'Debounce window before writing a snapshot after the last CRDT update.',
        },
        SNAPSHOT_INTERVAL_MS: {
            required: false,
            default: '300000',
            description: 'Interval for periodic snapshot sweeps across all active channels.',
        },
        IDLE_EVICTION_MS: {
            required: false,
            default: '600000',
            description: 'Grace period before evicting an idle (0-subscriber) Y.Doc from memory.',
        },
        EVENT_BUS_NAME: {
            required: false,
            default: 'social-events',
            description: 'EventBridge bus name (informational — only used by an EventBridge-backed SnapshotStore adapter, if any).',
        },
    },
    channels: ['crdt:*', 'doc:*', 'activity:broadcast'],
    declarations: undefined,
    dependencies: [],
    install: {
        // realtime-modules ships the orchestrator + stores; it does not
        // mount HTTP routes. The consumer wires CRDTService into its own
        // WS message router.
        backendRoutes: undefined,
        frontendImport: '@connorhoehn/realtime-modules/client',
    },
};
//# sourceMappingURL=manifest.js.map