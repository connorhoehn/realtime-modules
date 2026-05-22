"use strict";
// @connorhoehn/realtime-modules — entry point.
//
// This package is a client-side realtime collaboration library.
// Feature subpaths are exposed via package.json "exports":
//   import { ... } from '@connorhoehn/realtime-modules/client';
//   import { ... } from '@connorhoehn/realtime-modules/server-ws';
//   import { ... } from '@connorhoehn/realtime-modules/proxy-client';
//   import { ... } from '@connorhoehn/realtime-modules/agent-streaming';
//
// Bundlers that care about tree-shaking should import from dedicated subpaths.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// Re-export the agent-streaming subpath at the top level so consumers
// that already import from the package root don't have to thread a
// subpath through their bundler config.
__exportStar(require("./agent-streaming"), exports);
// Re-export the editor-agnostic CRDT client surface (also importable via
// the `./client` subpath — see package.json `exports`). Tiptap-coupled
// bits stay behind the separate `./adapters/tiptap` subpath so consumers
// using Monaco / CodeMirror / contentEditable don't pull in Tiptap or
// ProseMirror.
__exportStar(require("./client"), exports);
// Re-export the server-side WS handler factory (also importable via the
// `./server-ws` subpath). Pairs with ./client useWebSocket.
__exportStar(require("./server-ws"), exports);
//# sourceMappingURL=index.js.map