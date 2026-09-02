"use strict";
// realtime-modules/src/client/index.ts
//
// Editor-agnostic CRDT client surface for @connorhoehn/realtime-modules.
// Tiptap-specific code lives behind the separate `./adapters/tiptap`
// subpath so consumers using Monaco / CodeMirror / contentEditable don't
// pull in Tiptap or ProseMirror.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDictation = exports.CANVAS_BODY_KEY = exports.canvasToMarkdown = exports.canvasToDocModel = exports.useCanvasDocument = exports.useChannel = exports.useFeatureFlag = exports.useCapabilities = exports.useCapability = exports.useNotifications = exports.useVideoHangout = exports.useAttachmentSrc = exports.useFileUpload = exports.useActivity = exports.useReactions = exports.usePresence = exports.useChat = exports.useFeatures = exports.useGateway = exports.GatewayContext = exports.GatewaySocketProvider = exports.useAgentStream = exports.useWebSocket = exports.useCanvasCapture = exports.SharedTextEditor = exports.useIdleDetector = exports.useAwarenessState = exports.useCRDT = exports.useYjsDoc = exports.GatewayProvider = void 0;
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
// v0.30.0 — capture a canvas the page already owns as a MediaStreamTrack.
// Deliberately NOT screen capture: self-capture needs no permission prompt.
var useCanvasCapture_1 = require("./useCanvasCapture");
Object.defineProperty(exports, "useCanvasCapture", { enumerable: true, get: function () { return useCanvasCapture_1.useCanvasCapture; } });
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
// v0.7.2 — File upload lifecycle + video hangout signaling hooks.
// useFileUpload: presigned-URL upload with XHR progress + server-side AV scan state.
// useVideoHangout: LVS signaling layer — returns joinToken for <Stage> (web-broadcast-shim).
var useFileUpload_1 = require("./useFileUpload");
Object.defineProperty(exports, "useFileUpload", { enumerable: true, get: function () { return useFileUpload_1.useFileUpload; } });
// useAttachmentSrc: authenticated download URL -> renderable object URL. The
// download route needs a bearer header and an <img> cannot send one.
var useAttachmentSrc_1 = require("./useAttachmentSrc");
Object.defineProperty(exports, "useAttachmentSrc", { enumerable: true, get: function () { return useAttachmentSrc_1.useAttachmentSrc; } });
var useVideoHangout_1 = require("./useVideoHangout");
Object.defineProperty(exports, "useVideoHangout", { enumerable: true, get: function () { return useVideoHangout_1.useVideoHangout; } });
// v0.7.4 — useNotifications: user-scoped notification inbox that listens for
// `notification:*` frames from the gateway. Complements the channel-scoped
// hooks (useChat, usePresence, etc.) with a single cross-channel inbox.
// Read-state is persisted in localStorage so marks survive page refresh.
var useNotifications_1 = require("./useNotifications");
Object.defineProperty(exports, "useNotifications", { enumerable: true, get: function () { return useNotifications_1.useNotifications; } });
// v0.7.5 — useCapability: CRD-aware capability discovery. Apps can render
// conditionally based on whether a named capability is provisioned for the
// current user/context. Queries /api/capabilities on the gateway; falls back
// to optimistic enabled=true when the endpoint is not yet available. Also
// listens for capability:updated push frames so state updates without a remount.
var useCapability_1 = require("./useCapability");
Object.defineProperty(exports, "useCapability", { enumerable: true, get: function () { return useCapability_1.useCapability; } });
// useCapabilities: the same discovery for a SET of names. React forbids calling
// a hook in a loop, so a surface that composes on a caller-supplied capability
// list — the whole point of an embeddable module — cannot use the singular hook.
var useCapabilities_1 = require("./useCapabilities");
Object.defineProperty(exports, "useCapabilities", { enumerable: true, get: function () { return useCapabilities_1.useCapabilities; } });
// v0.7.7 — useFeatureFlag: app-level boolean/variant feature flag hook.
// Orthogonal to useCapability (CRD-driven, infrastructure-level). Designed for
// A/B testing, gradual rollouts, and kill-switches. Queries
// /api/feature-flags/:name on the gateway; falls back to defaultValue when the
// endpoint is not yet available. Listens for feature-flag:updated push frames
// so state updates reactively without a remount.
var useFeatureFlag_1 = require("./useFeatureFlag");
Object.defineProperty(exports, "useFeatureFlag", { enumerable: true, get: function () { return useFeatureFlag_1.useFeatureFlag; } });
// v0.7.8 — useChannel: composite hook bundling useChat + usePresence +
// useReactions + useActivity for a single channel. Reduces per-channel
// boilerplate for apps that want all four features. Each sub-hook is opt-out
// via opts.features; disabled features return null so consumers can
// optional-chain safely: chat?.sendMessage('hi').
var useChannel_1 = require("./useChannel");
Object.defineProperty(exports, "useChannel", { enumerable: true, get: function () { return useChannel_1.useChannel; } });
// v0.32.0 — useCanvasDocument: the Y.Doc ⇄ canvas binding. Gates on
// meta.schemaVersion >= 2, exposes the single `body` XmlFragment that holds the
// whole page, exports markdown straight from the CRDT, and materialises a
// migrated DocModel into an empty body atomically with the version flip.
// Pairs with @connorhoehn/realtime-modules/adapters/tiptap (MacroNode,
// HeadingAnchor, docModelToPm/pmToDocModel).
var useCanvasDocument_1 = require("./useCanvasDocument");
Object.defineProperty(exports, "useCanvasDocument", { enumerable: true, get: function () { return useCanvasDocument_1.useCanvasDocument; } });
Object.defineProperty(exports, "canvasToDocModel", { enumerable: true, get: function () { return useCanvasDocument_1.canvasToDocModel; } });
Object.defineProperty(exports, "canvasToMarkdown", { enumerable: true, get: function () { return useCanvasDocument_1.canvasToMarkdown; } });
Object.defineProperty(exports, "CANVAS_BODY_KEY", { enumerable: true, get: function () { return useCanvasDocument_1.CANVAS_BODY_KEY; } });
// v0.32.0 — useDictation: push-to-talk dictation where the transcript returns
// on the SAME request that carried the audio, instead of looping back through
// Redis and the gateway's caption fan-out.
//
// Measured on one 3.6 s utterance against the same resident model: 418 ms from
// key release to transcript, versus 1558 ms via the caption path — which also
// cut the sentence in half at its 3.0 s window boundary. Captions are a
// broadcast to a room; dictation is one person waiting for one answer, so it
// gets a request/response transport. See useDictation.ts for the full argument.
//
// Pairs with the live-captions sidecar's /dictate/{pcm,end,cancel} routes and
// reuses client/voice's PcmRecorder + contextFrame ladder unchanged.
var useDictation_1 = require("./useDictation");
Object.defineProperty(exports, "useDictation", { enumerable: true, get: function () { return useDictation_1.useDictation; } });
//# sourceMappingURL=index.js.map