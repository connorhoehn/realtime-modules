// @connorhoehn/realtime-modules — entry point.
//
// @deprecated As of 0.116.1 this root barrel is deprecated: it mixes React
// (client) and server code, so importing it drags both into either bundle.
// Import from a dedicated subpath instead (`/client`, `/server`, `/server-ws`,
// `/agent-streaming`, ...). It is not removed in this minor.
//
//
// This package is a client-side realtime collaboration library.
// Feature subpaths are exposed via package.json "exports":
//   import { ... } from '@connorhoehn/realtime-modules/client';
//   import { ... } from '@connorhoehn/realtime-modules/server-ws';
//   import { ... } from '@connorhoehn/realtime-modules/proxy-client';
//   import { ... } from '@connorhoehn/realtime-modules/agent-streaming';
//
// Bundlers that care about tree-shaking should import from dedicated subpaths.

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

// Re-export the server-side WS handler factory (also importable via the
// `./server-ws` subpath). Pairs with ./client useWebSocket.
export * from './server-ws';
