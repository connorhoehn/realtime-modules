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
