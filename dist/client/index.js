"use strict";
// realtime-modules/src/client/index.ts
//
// Editor-agnostic CRDT client surface for @connorhoehn/realtime-modules.
// Tiptap-specific code lives behind the separate `./adapters/tiptap`
// subpath so consumers using Monaco / CodeMirror / contentEditable don't
// pull in Tiptap or ProseMirror.
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
exports.usePresentationRevisions = exports.PAUSE_UNSUPPORTED_FALLBACK = exports.DEFAULT_AGENT_LOOP_POLL_MS = exports.isAgentLoopOver = exports.agentLoopProgress = exports.agentLoopPhase = exports.useAgentLoopRun = exports.useCursor = exports.useDictation = exports.CANVAS_BODY_KEY = exports.canvasToMarkdown = exports.canvasToDocModel = exports.useCanvasDocument = exports.useChannel = exports.useFeatureFlag = exports.useCapabilities = exports.useCapability = exports.useNotifications = exports.useVideoHangout = exports.useAttachmentSrc = exports.useFileUpload = exports.useActivity = exports.useReactions = exports.resetPresenceEntry = exports.presenceSetFrame = exports.presenceLeaveFrames = exports.joinedPresenceChannels = exports.joinPresenceChannel = exports.PRESENCE_LEFT_KEY = exports.usePresence = exports.useChatReadReceipts = exports.useChatMembers = exports.useChat = exports.usePins = exports.httpBaseFromSocketUrl = exports.createGatewayRest = exports.useFeatures = exports.useGatewayOptional = exports.useGateway = exports.GatewayContext = exports.GatewaySocketProvider = exports.useAgentStream = exports.useWebSocket = exports.useCanvasCapture = exports.SharedTextEditor = exports.useIdleDetector = exports.useAwarenessState = exports.useCRDT = exports.useYjsDoc = exports.GatewayProvider = void 0;
exports.generatePipelineDraft = exports.normalizeCatalogEntry = exports.fetchPipelineCatalog = exports.usePipelineCatalog = exports.mergeRunEvent = exports.applyRunEvent = exports.runEventFromFrame = exports.statusPillFor = exports.relativeTime = exports.groupByWorkType = exports.groupCatalog = exports.sortSummaries = exports.compareSummaries = exports.summarizeAll = exports.summarize = exports.kindOf = exports.workTypeOf = exports.isTerminalRunStatus = exports.isActiveRunStatus = exports.isFailedRunStatus = exports.isPipelineKind = exports.isWorkType = exports.emptyRollup = exports.RUN_EVENT_STATUS = exports.RECENT_LIMIT = exports.ROLLUP_RECENT_LIMIT = exports.RUN_ITEM_STATUSES = exports.MAX_ROUTE_ENTRIES = exports.MAX_INSTRUCTION_CHARS = exports.ORIGIN_KINDS = exports.PIPELINE_KINDS = exports.KIND_LABEL = exports.KIND_WORK_TYPE = exports.KIND_MARK = exports.PIPELINE_KIND_ORDER = exports.WORK_TYPE_ORDER = exports.WORK_TYPE_LABEL = exports.DECK_REVISION_WRITTEN_EVENT = exports.deckRevisionWrittenOf = exports.DECK_REVISE_EVENT_PREFIX = exports.DEFAULT_DECK_REVISE_STALE_MS = exports.isDeckReviseSettled = exports.markStaleDeckRevises = exports.reduceDeckReviseFrame = exports.deckRevisePhaseLabel = exports.deckReviseChannel = exports.useDeckReviseStatus = exports.PRESENTATION_REVISION_PAGE_SIZE = exports.releasePresentationRevisions = exports.mergePresentationRevisions = void 0;
exports.synthesizeRunStarted = exports.RunEventSequencer = exports.pipelineAllSubscribeFrames = exports.PIPELINE_ALL_CHANNEL = exports.newPipelineDraftRequestId = void 0;
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
Object.defineProperty(exports, "useGatewayOptional", { enumerable: true, get: function () { return GatewaySocketProvider_1.useGatewayOptional; } });
Object.defineProperty(exports, "useFeatures", { enumerable: true, get: function () { return GatewaySocketProvider_1.useFeatures; } });
// The REST half. Exported because an app that bridges its OWN socket onto
// GatewayContext never mounts GatewaySocketProvider, and so never gets the
// default shim — which is how a capability gate ends up complete on both
// sides and never firing.
Object.defineProperty(exports, "createGatewayRest", { enumerable: true, get: function () { return GatewaySocketProvider_1.createGatewayRest; } });
Object.defineProperty(exports, "httpBaseFromSocketUrl", { enumerable: true, get: function () { return GatewaySocketProvider_1.httpBaseFromSocketUrl; } });
// Pinned messages — channel state, served over the gateway's REST half.
var usePins_1 = require("./usePins");
Object.defineProperty(exports, "usePins", { enumerable: true, get: function () { return usePins_1.usePins; } });
// v0.7.0 — Feature hooks: useChat, usePresence, useReactions, useActivity.
// All hooks require a GatewaySocketProvider ancestor and use the message bus
// exposed by useGateway() to subscribe to inbound frames per channel.
var useChat_1 = require("./useChat");
Object.defineProperty(exports, "useChat", { enumerable: true, get: function () { return useChat_1.useChat; } });
var useChatMembers_1 = require("./useChatMembers");
Object.defineProperty(exports, "useChatMembers", { enumerable: true, get: function () { return useChatMembers_1.useChatMembers; } });
// Read receipts — a sibling of useChat, socket-explicit and provider-optional
// (opts.socket), so it renders and tests without a GatewaySocketProvider.
var useChatReadReceipts_1 = require("./useChatReadReceipts");
Object.defineProperty(exports, "useChatReadReceipts", { enumerable: true, get: function () { return useChatReadReceipts_1.useChatReadReceipts; } });
var usePresence_1 = require("./usePresence");
Object.defineProperty(exports, "usePresence", { enumerable: true, get: function () { return usePresence_1.usePresence; } });
var presenceEntry_1 = require("./presenceEntry");
Object.defineProperty(exports, "PRESENCE_LEFT_KEY", { enumerable: true, get: function () { return presenceEntry_1.PRESENCE_LEFT_KEY; } });
Object.defineProperty(exports, "joinPresenceChannel", { enumerable: true, get: function () { return presenceEntry_1.joinPresenceChannel; } });
Object.defineProperty(exports, "joinedPresenceChannels", { enumerable: true, get: function () { return presenceEntry_1.joinedPresenceChannels; } });
Object.defineProperty(exports, "presenceLeaveFrames", { enumerable: true, get: function () { return presenceEntry_1.presenceLeaveFrames; } });
Object.defineProperty(exports, "presenceSetFrame", { enumerable: true, get: function () { return presenceEntry_1.presenceSetFrame; } });
Object.defineProperty(exports, "resetPresenceEntry", { enumerable: true, get: function () { return presenceEntry_1.resetPresenceEntry; } });
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
__exportStar(require("./work-graph"), exports);
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
// useCursor — the client half of the cursor triple. CursorService and its
// manifest have shipped since the Wave 2 lift with no hook to match, so the
// docs pointed consumers at useAwarenessState, which only works if a Yjs
// document is already mounted. This hook speaks the gateway's cursor frames
// directly: subscribe + snapshot, per-client update/remove, and a local
// throttle matching the service's own (it silently drops anything faster),
// with a trailing send so the resting position is not lost.
var useCursor_1 = require("./useCursor");
Object.defineProperty(exports, "useCursor", { enumerable: true, get: function () { return useCursor_1.useCursor; } });
// v0.80.0 — useAgentLoopRun: one agent loop for a task card / task strip —
// phase, steps done of total, the step in hand, and Stop. Reads platform-api's
// /api/agent-loops/:runId and re-reads on the run's `pipeline:event` frames.
// Pause is not offered (the platform answers 501 and says why in
// `controls.pauseUnsupportedReason`); `canPause` is `false` so a UI renders
// no dead button.
var useAgentLoopRun_1 = require("./useAgentLoopRun");
Object.defineProperty(exports, "useAgentLoopRun", { enumerable: true, get: function () { return useAgentLoopRun_1.useAgentLoopRun; } });
Object.defineProperty(exports, "agentLoopPhase", { enumerable: true, get: function () { return useAgentLoopRun_1.agentLoopPhase; } });
Object.defineProperty(exports, "agentLoopProgress", { enumerable: true, get: function () { return useAgentLoopRun_1.agentLoopProgress; } });
Object.defineProperty(exports, "isAgentLoopOver", { enumerable: true, get: function () { return useAgentLoopRun_1.isAgentLoopOver; } });
Object.defineProperty(exports, "DEFAULT_AGENT_LOOP_POLL_MS", { enumerable: true, get: function () { return useAgentLoopRun_1.DEFAULT_AGENT_LOOP_POLL_MS; } });
Object.defineProperty(exports, "PAUSE_UNSUPPORTED_FALLBACK", { enumerable: true, get: function () { return useAgentLoopRun_1.PAUSE_UNSUPPORTED_FALLBACK; } });
// v0.95.3 — usePresentationRevisions: a deck's revisions a page at a time
// (cursor paging over GET …/revisions?limit&before), one module cache per
// (api, deck, person) shared by every view, live prepend on the deck
// channel's revision-written (NFR #15). Moved from the gateway frontend.
var usePresentationRevisions_1 = require("./usePresentationRevisions");
Object.defineProperty(exports, "usePresentationRevisions", { enumerable: true, get: function () { return usePresentationRevisions_1.usePresentationRevisions; } });
Object.defineProperty(exports, "mergePresentationRevisions", { enumerable: true, get: function () { return usePresentationRevisions_1.mergePresentationRevisions; } });
Object.defineProperty(exports, "releasePresentationRevisions", { enumerable: true, get: function () { return usePresentationRevisions_1.releasePresentationRevisions; } });
Object.defineProperty(exports, "PRESENTATION_REVISION_PAGE_SIZE", { enumerable: true, get: function () { return usePresentationRevisions_1.PRESENTATION_REVISION_PAGE_SIZE; } });
// v0.80.0 — useDeckReviseStatus: which slides of a presentation an agent is
// revising right now, from anyone's tab. Listens on
// `pipeline:run:deck-revise:<documentId>` for platform-api's
// `pipeline.deck.revise.{started,phase,completed,failed}` frames (sent when
// POST /api/deck/revise carries a documentId). `generatingSlideIds` drives the
// filmstrip's "Generating…"; `active[].label` the task strip's phase line.
var useDeckReviseStatus_1 = require("./useDeckReviseStatus");
Object.defineProperty(exports, "useDeckReviseStatus", { enumerable: true, get: function () { return useDeckReviseStatus_1.useDeckReviseStatus; } });
Object.defineProperty(exports, "deckReviseChannel", { enumerable: true, get: function () { return useDeckReviseStatus_1.deckReviseChannel; } });
Object.defineProperty(exports, "deckRevisePhaseLabel", { enumerable: true, get: function () { return useDeckReviseStatus_1.deckRevisePhaseLabel; } });
Object.defineProperty(exports, "reduceDeckReviseFrame", { enumerable: true, get: function () { return useDeckReviseStatus_1.reduceDeckReviseFrame; } });
Object.defineProperty(exports, "markStaleDeckRevises", { enumerable: true, get: function () { return useDeckReviseStatus_1.markStaleDeckRevises; } });
Object.defineProperty(exports, "isDeckReviseSettled", { enumerable: true, get: function () { return useDeckReviseStatus_1.isDeckReviseSettled; } });
Object.defineProperty(exports, "DEFAULT_DECK_REVISE_STALE_MS", { enumerable: true, get: function () { return useDeckReviseStatus_1.DEFAULT_DECK_REVISE_STALE_MS; } });
Object.defineProperty(exports, "DECK_REVISE_EVENT_PREFIX", { enumerable: true, get: function () { return useDeckReviseStatus_1.DECK_REVISE_EVENT_PREFIX; } });
// 0.94.0 — a revision written to the document while it is open (NFR #15).
Object.defineProperty(exports, "deckRevisionWrittenOf", { enumerable: true, get: function () { return useDeckReviseStatus_1.deckRevisionWrittenOf; } });
Object.defineProperty(exports, "DECK_REVISION_WRITTEN_EVENT", { enumerable: true, get: function () { return useDeckReviseStatus_1.DECK_REVISION_WRITTEN_EVENT; } });
// v0.88.0 — the pipelines directory (also under ./client/pipelines): the
// work-type / kind enum with its labels and marks, the last-run rollup and its
// merge rule, the status pill, and `usePipelineCatalog`, which reads
// `GET /api/pipelines/defs?include=rollup` and keeps each row's rollup current
// from the `pipeline:all` run frames. `generatePipelineDraft` is the `/agent`
// planner on the page (`POST /api/pipelines/defs/generate`).
var catalog_1 = require("./pipelines/catalog");
Object.defineProperty(exports, "WORK_TYPE_LABEL", { enumerable: true, get: function () { return catalog_1.WORK_TYPE_LABEL; } });
Object.defineProperty(exports, "WORK_TYPE_ORDER", { enumerable: true, get: function () { return catalog_1.WORK_TYPE_ORDER; } });
Object.defineProperty(exports, "PIPELINE_KIND_ORDER", { enumerable: true, get: function () { return catalog_1.PIPELINE_KIND_ORDER; } });
Object.defineProperty(exports, "KIND_MARK", { enumerable: true, get: function () { return catalog_1.KIND_MARK; } });
Object.defineProperty(exports, "KIND_WORK_TYPE", { enumerable: true, get: function () { return catalog_1.KIND_WORK_TYPE; } });
Object.defineProperty(exports, "KIND_LABEL", { enumerable: true, get: function () { return catalog_1.KIND_LABEL; } });
Object.defineProperty(exports, "PIPELINE_KINDS", { enumerable: true, get: function () { return catalog_1.PIPELINE_KINDS; } });
Object.defineProperty(exports, "ORIGIN_KINDS", { enumerable: true, get: function () { return catalog_1.ORIGIN_KINDS; } });
Object.defineProperty(exports, "MAX_INSTRUCTION_CHARS", { enumerable: true, get: function () { return catalog_1.MAX_INSTRUCTION_CHARS; } });
Object.defineProperty(exports, "MAX_ROUTE_ENTRIES", { enumerable: true, get: function () { return catalog_1.MAX_ROUTE_ENTRIES; } });
Object.defineProperty(exports, "RUN_ITEM_STATUSES", { enumerable: true, get: function () { return catalog_1.RUN_ITEM_STATUSES; } });
Object.defineProperty(exports, "ROLLUP_RECENT_LIMIT", { enumerable: true, get: function () { return catalog_1.ROLLUP_RECENT_LIMIT; } });
Object.defineProperty(exports, "RECENT_LIMIT", { enumerable: true, get: function () { return catalog_1.RECENT_LIMIT; } });
Object.defineProperty(exports, "RUN_EVENT_STATUS", { enumerable: true, get: function () { return catalog_1.RUN_EVENT_STATUS; } });
Object.defineProperty(exports, "emptyRollup", { enumerable: true, get: function () { return catalog_1.emptyRollup; } });
Object.defineProperty(exports, "isWorkType", { enumerable: true, get: function () { return catalog_1.isWorkType; } });
Object.defineProperty(exports, "isPipelineKind", { enumerable: true, get: function () { return catalog_1.isPipelineKind; } });
Object.defineProperty(exports, "isFailedRunStatus", { enumerable: true, get: function () { return catalog_1.isFailedRunStatus; } });
Object.defineProperty(exports, "isActiveRunStatus", { enumerable: true, get: function () { return catalog_1.isActiveRunStatus; } });
Object.defineProperty(exports, "isTerminalRunStatus", { enumerable: true, get: function () { return catalog_1.isTerminalRunStatus; } });
Object.defineProperty(exports, "workTypeOf", { enumerable: true, get: function () { return catalog_1.workTypeOf; } });
Object.defineProperty(exports, "kindOf", { enumerable: true, get: function () { return catalog_1.kindOf; } });
Object.defineProperty(exports, "summarize", { enumerable: true, get: function () { return catalog_1.summarize; } });
Object.defineProperty(exports, "summarizeAll", { enumerable: true, get: function () { return catalog_1.summarizeAll; } });
Object.defineProperty(exports, "compareSummaries", { enumerable: true, get: function () { return catalog_1.compareSummaries; } });
Object.defineProperty(exports, "sortSummaries", { enumerable: true, get: function () { return catalog_1.sortSummaries; } });
Object.defineProperty(exports, "groupCatalog", { enumerable: true, get: function () { return catalog_1.groupCatalog; } });
Object.defineProperty(exports, "groupByWorkType", { enumerable: true, get: function () { return catalog_1.groupByWorkType; } });
Object.defineProperty(exports, "relativeTime", { enumerable: true, get: function () { return catalog_1.relativeTime; } });
Object.defineProperty(exports, "statusPillFor", { enumerable: true, get: function () { return catalog_1.statusPillFor; } });
Object.defineProperty(exports, "runEventFromFrame", { enumerable: true, get: function () { return catalog_1.runEventFromFrame; } });
Object.defineProperty(exports, "applyRunEvent", { enumerable: true, get: function () { return catalog_1.applyRunEvent; } });
Object.defineProperty(exports, "mergeRunEvent", { enumerable: true, get: function () { return catalog_1.mergeRunEvent; } });
var usePipelineCatalog_1 = require("./pipelines/usePipelineCatalog");
Object.defineProperty(exports, "usePipelineCatalog", { enumerable: true, get: function () { return usePipelineCatalog_1.usePipelineCatalog; } });
Object.defineProperty(exports, "fetchPipelineCatalog", { enumerable: true, get: function () { return usePipelineCatalog_1.fetchPipelineCatalog; } });
Object.defineProperty(exports, "normalizeCatalogEntry", { enumerable: true, get: function () { return usePipelineCatalog_1.normalizeCatalogEntry; } });
Object.defineProperty(exports, "generatePipelineDraft", { enumerable: true, get: function () { return usePipelineCatalog_1.generatePipelineDraft; } });
Object.defineProperty(exports, "newPipelineDraftRequestId", { enumerable: true, get: function () { return usePipelineCatalog_1.newPipelineDraftRequestId; } });
Object.defineProperty(exports, "PIPELINE_ALL_CHANNEL", { enumerable: true, get: function () { return usePipelineCatalog_1.PIPELINE_ALL_CHANNEL; } });
Object.defineProperty(exports, "pipelineAllSubscribeFrames", { enumerable: true, get: function () { return usePipelineCatalog_1.pipelineAllSubscribeFrames; } });
// v0.95.3 — one run-frame sequencer (realtime-examples NFR #184).
var runEventSequencer_1 = require("./pipelines/runEventSequencer");
Object.defineProperty(exports, "RunEventSequencer", { enumerable: true, get: function () { return runEventSequencer_1.RunEventSequencer; } });
Object.defineProperty(exports, "synthesizeRunStarted", { enumerable: true, get: function () { return runEventSequencer_1.synthesizeRunStarted; } });
// v0.90.0 — the Documents four-pane redesign (also under ./client/documents):
// work fields on a document, the Work column grouped by work status, run drafts
// with request-id idempotency, and run estimates — REST helpers plus
// `useDocumentWork`, `useWorkList`, `useRunDraft`, `useRunEstimate`, kept live
// from the gateway's id-only `doc-work:*` signals.
__exportStar(require("./documents"), exports);
// Documents folders (realtime-examples documents-folders R1): folder records,
// nested live counts and conditional, request-id-idempotent moves over the
// gateway's `document-folders` service and its `doc-folders:<org>` hub.
__exportStar(require("./documents/folders"), exports);
//# sourceMappingURL=index.js.map