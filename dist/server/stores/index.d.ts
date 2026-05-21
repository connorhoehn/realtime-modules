/**
 * Barrel re-exports for the prep interfaces + MemoryStore implementations.
 *
 * Consumers should import from `'./stores'` rather than the individual
 * files so the package layout can evolve without churning import sites.
 */
export type { HotCache, SnapshotStore, VersionMeta } from './SnapshotStore';
export type { DocumentMeta, MetadataStore } from './MetadataStore';
export type { MessageRouterContract } from './MessageRouterContract';
export { MemoryHotCache, MemoryMetadataStore, MemorySnapshotStore, } from './MemoryStore';
//# sourceMappingURL=index.d.ts.map