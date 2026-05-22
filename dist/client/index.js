"use strict";
// realtime-modules/src/client/index.ts
//
// Editor-agnostic CRDT client surface for @connorhoehn/realtime-modules.
// Tiptap-specific code lives behind the separate `./adapters/tiptap`
// subpath so consumers using Monaco / CodeMirror / contentEditable don't
// pull in Tiptap or ProseMirror.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useActivity = exports.useReactions = exports.usePresence = exports.useChat = exports.useFeatures = exports.useGateway = exports.GatewayContext = exports.GatewaySocketProvider = exports.useAgentStream = exports.useWebSocket = exports.SharedTextEditor = exports.useIdleDetector = exports.useAwarenessState = exports.useCRDT = exports.useYjsDoc = exports.GatewayProvider = void 0;
var GatewayProvider_1 = require("./GatewayProvider");
Object.defineProperty(exports, "GatewayProvider", { enumerable: true, get: function () { return GatewayProvider_1.GatewayProvider; } });
var useYjsDoc_1 = require("./useYjsDoc");
Object.defineProperty(exports, "useYjsDoc", { enumerable: true, get: function () { return useYjsDoc_1.useYjsDoc; } });
var useCRDT_1 = require("./useCRDT");
Object.defineProperty(exports, "useCRDT", { enumerable: true, get: function () { return useCRDT_1.useCRDT; } });
var useAwarenessState_1 = require("./useAwarenessState");
Object.defineProperty(exports, "useAwarenessState", { enumerable: true, get: function () { return useAwarenessState_1.useAwarenessState; } });
var useIdleDetector_1 = require("./useIdleDetector");
Object.defineProperty(exports, "useIdleDetector", { enumerable: true, get: function () { return useIdleDetector_1.useIdleDetector; } });
var SharedTextEditor_1 = require("./SharedTextEditor");
Object.defineProperty(exports, "SharedTextEditor", { enumerable: true, get: function () { return SharedTextEditor_1.SharedTextEditor; } });
var useWebSocket_1 = require("./useWebSocket");
Object.defineProperty(exports, "useWebSocket", { enumerable: true, get: function () { return useWebSocket_1.useWebSocket; } });
// v0.2.0 — useAgentStream hook. Pairs with the server-side
// agentStreamMiddleware (./agent-streaming) for full FE adoption of
// AG-UI v0.1.x. Replaces hand-rolled per-app hooks like OrgIQ's
// useAgUiStream (~188 LOC) with a single library import. Handles
// CUSTOM `session` and `tool_call_result` workarounds internally for
// spec-gap interop.
var useAgentStream_1 = require("./useAgentStream");
Object.defineProperty(exports, "useAgentStream", { enumerable: true, get: function () { return useAgentStream_1.useAgentStream; } });
// v0.3.x — GatewaySocketProvider + useFeatures for declarative feature activation.
// Provides the WebSocket context so child hooks (useChat, usePresence, etc.)
// work without manual wiring. Also exports useGateway() for direct WS access.
var GatewaySocketProvider_1 = require("./GatewaySocketProvider");
Object.defineProperty(exports, "GatewaySocketProvider", { enumerable: true, get: function () { return GatewaySocketProvider_1.GatewaySocketProvider; } });
Object.defineProperty(exports, "GatewayContext", { enumerable: true, get: function () { return GatewaySocketProvider_1.GatewayContext; } });
Object.defineProperty(exports, "useGateway", { enumerable: true, get: function () { return GatewaySocketProvider_1.useGateway; } });
Object.defineProperty(exports, "useFeatures", { enumerable: true, get: function () { return GatewaySocketProvider_1.useFeatures; } });
// v0.7.0 — Feature hooks: useChat, usePresence, useReactions, useActivity.
// All hooks require a GatewaySocketProvider ancestor and use the message bus
// exposed by useGateway() to subscribe to inbound frames per channel.
var useChat_1 = require("./useChat");
Object.defineProperty(exports, "useChat", { enumerable: true, get: function () { return useChat_1.useChat; } });
var usePresence_1 = require("./usePresence");
Object.defineProperty(exports, "usePresence", { enumerable: true, get: function () { return usePresence_1.usePresence; } });
var useReactions_1 = require("./useReactions");
Object.defineProperty(exports, "useReactions", { enumerable: true, get: function () { return useReactions_1.useReactions; } });
var useActivity_1 = require("./useActivity");
Object.defineProperty(exports, "useActivity", { enumerable: true, get: function () { return useActivity_1.useActivity; } });
//# sourceMappingURL=index.js.map