// @connorhoehn/realtime-modules — entry point.
//
// Feature triples (UI + backend + manifest) are exposed as subpath
// imports, e.g.:
//   import { ChatManifest } from '@connorhoehn/realtime-modules/chat';
//   import { CRDTService } from '@connorhoehn/realtime-modules/server';
//
// The top-level entry re-exports the FeatureManifest contract, the
// agent-streaming surface, the editor-agnostic CRDT client surface, and
// (for convenience) the backend CRDT server module. Bundlers that care
// about tree-shaking should still import from the dedicated subpaths.

export type { FeatureManifest } from './feature-manifest/types';

// Re-export the agent-streaming subpath at the top level so consumers
// that already import from the package root don't have to thread a
// subpath through their bundler config.
export * from './agent-streaming';

// Re-export the editor-agnostic CRDT client surface (also importable via
// the `./client` subpath — see package.json `exports`). Tiptap-coupled
// bits stay behind the separate `./adapters/tiptap` subpath so consumers
// using Monaco / CodeMirror / contentEditable don't pull in Tiptap or
// ProseMirror.
export * from './client';

// Re-export the backend CRDT server module (also importable via the
// `./server` subpath). Lifted from gateway in CRDT Cut 1.
export * from './server';

// Re-export the in-process presence module (also importable via the
// `./presence` subpath). Lifted from gateway in Wave 2.
export * from './presence';

// Re-export the in-process chat module (also importable via the
// `./chat` subpath). Lifted from gateway in Wave 2 / Cut 2.
export * from './chat';

// Re-export the in-process reactions module (also importable via the
// `./reactions` subpath). Lifted from gateway in Wave 2.
export * from './reactions';

// Re-export the in-process social WS-subscription module (also importable
// via the `./social` subpath). Lifted from gateway in Wave 2. Scope: WS
// subscribe / unsubscribe fan-out only. The social-api CRUD routes and
// Redis-side BroadcastService stay in platform-api.
export * from './social';

// Re-export the in-process call/hangout invite-signaling module (also
// importable via the `./call` subpath). Lifted from gateway in Wave 2
// catch-up. Signaling only — no WebRTC/SFU media plane.
export * from './call';

// Re-export the in-process ingest WS subscription module (also importable
// via the `./ingest` subpath). Lifted from gateway in Wave 2. Note: the
// gateway-side ingest-bridge / ingest-relay (event-bus → emitEvent) stays
// in gateway, as does the platform-api ingest engine.
export * from './ingest';

// Re-export the server-side WS handler factory (also importable via the
// `./server-ws` subpath). Wave 3 — pairs with ./client useWebSocket.
export * from './server-ws';

// Re-export the typed-documents WS-subscription module (also importable
// via the `./typed-documents` subpath). Lifted from gateway in Wave 2.
// Persistence stays gateway-side (DDB typed-document repository, wizard
// CRUD, validation rules, bulk import); only the subscribe/unsubscribe
// action surface + frame shape lives here.
export * from './typed-documents';

// Re-export the in-process activity-feed module (also importable via the
// `./activity` subpath). Lifted from gateway in Wave 2. The event-catalog
// durable-publish path + Redis-backed history adapter stay in gateway
// (see ActivityHistoryStore for the persistence boundary).
export * from './activity';

// Re-export the pipeline WS subscription module (also importable via the
// `./pipeline` subpath). Lifted from gateway in Wave 2 — only the WS
// channel subscription tracking + BusEvent → frame projection lives here;
// trigger / cancel / approval / audit / authz / tracing / PipelineModule
// wiring all stay in gateway's pipeline-service.
export * from './pipeline';

// Re-export the in-process cursor fan-out module (also importable via the
// `./cursor` subpath). Lifted from gateway in Wave 2 catch-up. The
// gateway-side ownership-cleanup-coordinator wiring stays at the gateway
// (cleanupRoom is exposed publicly so the adapter layer drives it). The
// periodic TTL sweep is a plain setInterval today; will swap to DC
// PeriodicSweep when that primitive ships (handoff #299).
export * from './cursor';
