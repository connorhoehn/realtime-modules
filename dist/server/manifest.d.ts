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
import type { FeatureManifest } from '../feature-manifest/types';
export declare const crdtManifest: FeatureManifest;
//# sourceMappingURL=manifest.d.ts.map