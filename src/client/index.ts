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
export { GatewaySocketProvider, GatewayContext, useGateway, useFeatures } from './GatewaySocketProvider';
export type {
  FeatureName,
  GatewaySocketProviderProps,
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
