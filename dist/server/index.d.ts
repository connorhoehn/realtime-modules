import CRDTService from './CRDTService';
import SnapshotManager from './SnapshotManager';
import DocumentMetadataService from './DocumentMetadataService';
import DocumentPresenceService from './DocumentPresenceService';
import AwarenessCoalescer from './AwarenessCoalescer';
import IdleEvictionManager from './IdleEvictionManager';
export { CRDTService, SnapshotManager, DocumentMetadataService, DocumentPresenceService, AwarenessCoalescer, IdleEvictionManager, };
export type { CRDTServiceOpts, OrchestratorMessageRouter } from './CRDTService';
export type { HotCache, SnapshotStore, VersionMeta } from './stores/SnapshotStore';
export type { DocumentMeta, MetadataStore } from './stores/MetadataStore';
export type { MessageRouterContract } from './stores/MessageRouterContract';
export { MemoryHotCache, MemoryMetadataStore, MemorySnapshotStore, } from './stores/MemoryStore';
export * as config from './config';
export { crdtManifest } from './manifest';
//# sourceMappingURL=index.d.ts.map