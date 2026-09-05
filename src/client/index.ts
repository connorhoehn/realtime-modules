// realtime-modules/src/client/index.ts
//
// Editor-agnostic CRDT client surface for @connorhoehn/realtime-modules.
// Tiptap-specific code lives behind the separate `./adapters/tiptap`
// subpath so consumers using Monaco / CodeMirror / contentEditable don't
// pull in Tiptap or ProseMirror.

export { GatewayProvider } from './GatewayProvider';
export type { SendMessage } from './GatewayProvider';

export { useYjsDoc } from './useYjsDoc';
export type { UseYjsDocOptions, UseYjsDocReturn } from './useYjsDoc';

export { useCRDT } from './useCRDT';
export type { UseCRDTOptions, UseCRDTReturn } from './useCRDT';

export { useAwarenessState } from './useAwarenessState';
export type { AwarenessFields, AwarenessUpdaters } from './useAwarenessState';

export { useIdleDetector } from './useIdleDetector';
export type { UseIdleDetectorOptions, UseIdleDetectorReturn } from './useIdleDetector';

export { SharedTextEditor } from './SharedTextEditor';
export type { SharedTextEditorProps } from './SharedTextEditor';

// v0.30.0 — capture a canvas the page already owns as a MediaStreamTrack.
// Deliberately NOT screen capture: self-capture needs no permission prompt.
export { useCanvasCapture } from './useCanvasCapture';
export type {
  UseCanvasCaptureOptions,
  UseCanvasCaptureReturn,
} from './useCanvasCapture';

export { useWebSocket } from './useWebSocket';
export type {
  UseWebSocketOptions,
  UseWebSocketHookReturn,
} from './useWebSocket';

// v0.2.0 — useAgentStream hook. Pairs with the server-side
// agentStreamMiddleware (./agent-streaming) for full FE adoption of
// AG-UI v0.1.x. Replaces hand-rolled per-app hooks like OrgIQ's
// useAgUiStream (~188 LOC) with a single library import. Handles
// CUSTOM `session` and `tool_call_result` workarounds internally for
// spec-gap interop.
export { useAgentStream } from './useAgentStream';
export type {
  UseAgentStreamOptions,
  UseAgentStreamReturn,
  Message,
  ToolCall,
  BuildBody,
} from './useAgentStream';

export type {
  ConnectionState,
  GatewayError,
  GatewayMessage,
  UseWebSocketReturn,
  ChatMessage,
  PresenceStatus,
  PresenceEntry,
  Reaction,
  ActivityEvent,
} from './types';

// v0.3.x — GatewaySocketProvider + useFeatures for declarative feature activation.
// Provides the WebSocket context so child hooks (useChat, usePresence, etc.)
// work without manual wiring. Also exports useGateway() for direct WS access.
export {
  GatewaySocketProvider,
  GatewayContext,
  useGateway,
  useFeatures,
  // The REST half. Exported because an app that bridges its OWN socket onto
  // GatewayContext never mounts GatewaySocketProvider, and so never gets the
  // default shim — which is how a capability gate ends up complete on both
  // sides and never firing.
  createGatewayRest,
  httpBaseFromSocketUrl,
} from './GatewaySocketProvider';
export type { PinnedMessage } from './GatewaySocketProvider';

// Pinned messages — channel state, served over the gateway's REST half.
export { usePins } from './usePins';
export type { UsePinsResult } from './usePins';
export type {
  FeatureName,
  GatewaySocketProviderProps,
  GatewayRest,
  GatewayContextValue,
} from './GatewaySocketProvider';

// v0.7.0 — Feature hooks: useChat, usePresence, useReactions, useActivity.
// All hooks require a GatewaySocketProvider ancestor and use the message bus
// exposed by useGateway() to subscribe to inbound frames per channel.
export { useChat } from './useChat';
export type { UseChatReturn } from './useChat';

export { usePresence } from './usePresence';
export type { UsePresenceReturn } from './usePresence';

export { useReactions } from './useReactions';
export type { UseReactionsReturn } from './useReactions';

export { useActivity } from './useActivity';
export type { UseActivityReturn } from './useActivity';

// v0.7.2 — File upload lifecycle + video hangout signaling hooks.
// useFileUpload: presigned-URL upload with XHR progress + server-side AV scan state.
// useVideoHangout: LVS signaling layer — returns joinToken for <Stage> (web-broadcast-shim).
export { useFileUpload } from './useFileUpload';
export type {
  ChannelTransfer,
  CompletedTransfer,
  FileUploadState,
  UseFileUploadOptions,
  UseFileUploadResult,
} from './useFileUpload';

// useAttachmentSrc: authenticated download URL -> renderable object URL. The
// download route needs a bearer header and an <img> cannot send one.
export { useAttachmentSrc } from './useAttachmentSrc';
export type { UseAttachmentSrcOptions, UseAttachmentSrcResult } from './useAttachmentSrc';

export { useVideoHangout } from './useVideoHangout';
export type { HangoutParticipant, HangoutSession, UseVideoHangoutResult } from './useVideoHangout';

// v0.7.4 — useNotifications: user-scoped notification inbox that listens for
// `notification:*` frames from the gateway. Complements the channel-scoped
// hooks (useChat, usePresence, etc.) with a single cross-channel inbox.
// Read-state is persisted in localStorage so marks survive page refresh.
export { useNotifications } from './useNotifications';
export type {
  Notification,
  NotificationType,
  UseNotificationsOptions,
  UseNotificationsResult,
} from './useNotifications';

// v0.7.5 — useCapability: CRD-aware capability discovery. Apps can render
// conditionally based on whether a named capability is provisioned for the
// current user/context. Queries /api/capabilities on the gateway; falls back
// to optimistic enabled=true when the endpoint is not yet available. Also
// listens for capability:updated push frames so state updates without a remount.
export { useCapability } from './useCapability';
export type {
  CapabilityDescriptor,
  UseCapabilityResult,
} from './useCapability';

// useCapabilities: the same discovery for a SET of names. React forbids calling
// a hook in a loop, so a surface that composes on a caller-supplied capability
// list — the whole point of an embeddable module — cannot use the singular hook.
export { useCapabilities } from './useCapabilities';
export type { UseCapabilitiesResult } from './useCapabilities';

// v0.7.7 — useFeatureFlag: app-level boolean/variant feature flag hook.
// Orthogonal to useCapability (CRD-driven, infrastructure-level). Designed for
// A/B testing, gradual rollouts, and kill-switches. Queries
// /api/feature-flags/:name on the gateway; falls back to defaultValue when the
// endpoint is not yet available. Listens for feature-flag:updated push frames
// so state updates reactively without a remount.
export { useFeatureFlag } from './useFeatureFlag';
export type { UseFeatureFlagResult } from './useFeatureFlag';

// v0.7.8 — useChannel: composite hook bundling useChat + usePresence +
// useReactions + useActivity for a single channel. Reduces per-channel
// boilerplate for apps that want all four features. Each sub-hook is opt-out
// via opts.features; disabled features return null so consumers can
// optional-chain safely: chat?.sendMessage('hi').
export { useChannel } from './useChannel';
export type {
  UseChannelOptions,
  UseChannelFeatures,
  UseChannelResult,
} from './useChannel';

// v0.32.0 — useCanvasDocument: the Y.Doc ⇄ canvas binding. Gates on
// meta.schemaVersion >= 2, exposes the single `body` XmlFragment that holds the
// whole page, exports markdown straight from the CRDT, and materialises a
// migrated DocModel into an empty body atomically with the version flip.
// Pairs with @connorhoehn/realtime-modules/adapters/tiptap (MacroNode,
// HeadingAnchor, docModelToPm/pmToDocModel).
export {
  useCanvasDocument,
  canvasToDocModel,
  canvasToMarkdown,
  CANVAS_BODY_KEY,
} from './useCanvasDocument';
export type {
  CanvasDocument,
  UseCanvasDocumentOptions,
  MaterializeResult,
  PmSchemaLike,
} from './useCanvasDocument';

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
export { useDictation } from './useDictation';
export type {
  DictationState,
  MicPermission,
  UseDictationOptions,
  UseDictationResult,
} from './useDictation';
