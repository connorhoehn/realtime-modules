// realtime-modules/src/server/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/server`.
//
// Backend CRDT toolkit lifted from gateway's src/realtime-fanout/ in
// CRDT Cut 1. Consumers wire a `SnapshotStore`, `MetadataStore`,
// `HotCache`, and `MessageRouterContract` (all defined in
// `./stores`) and get a ready-to-go CRDTService orchestrator.

import CRDTService from './CRDTService';
import SnapshotManager from './SnapshotManager';
import DocumentMetadataService from './DocumentMetadataService';
import DocumentPresenceService from './DocumentPresenceService';
import AwarenessCoalescer from './AwarenessCoalescer';
import IdleEvictionManager from './IdleEvictionManager';

export {
    CRDTService,
    SnapshotManager,
    DocumentMetadataService,
    DocumentPresenceService,
    AwarenessCoalescer,
    IdleEvictionManager,
};

export type { CRDTServiceOpts, OrchestratorMessageRouter } from './CRDTService';

// Re-export store contracts + memory implementations so consumers only
// need to import from `'@connorhoehn/realtime-modules/server'`.
export type { HotCache, SnapshotStore, VersionMeta } from './stores/SnapshotStore';
export type { DocumentMeta, MetadataStore } from './stores/MetadataStore';
export type { MessageRouterContract } from './stores/MessageRouterContract';
export {
    MemoryHotCache,
    MemoryMetadataStore,
    MemorySnapshotStore,
} from './stores/MemoryStore';

// Configuration constants, exposed so consumers can override windows
// per deployment (e.g. for soak tests).
export * as config from './config';

// FeatureManifest — apps read this to discover env vars + channels.
export { crdtManifest } from './manifest';
