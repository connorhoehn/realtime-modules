// Non-CRDT WebSocket surface — safe to import without yjs / y-protocols.
// Use this subpath (./client/ws) when you only need useWebSocket and its
// types. The ./client barrel re-exports GatewayProvider which has a hard
// yjs/y-protocols dependency; consumers that don't use CRDT must not import
// from ./client directly.
//
// GatewaySocketProvider is included here because it only depends on
// useWebSocket (no yjs / y-protocols imports) and is the recommended
// zero-config way to wire the WS connection in React apps.
export { useWebSocket } from './useWebSocket';
export type {
  UseWebSocketOptions,
  UseWebSocketHookReturn,
  UseWebSocketPersistConfig,
} from './useWebSocket';

export type {
  ConnectionState,
  GatewayError,
  GatewayMessage,
  UseWebSocketReturn,
} from './types';

export { GatewaySocketProvider, useGateway, useFeatures } from './GatewaySocketProvider';
export type { FeatureName } from './GatewaySocketProvider';

// v0.144.0 — one host-owned socket shared by several consumers: fan-out of
// inbound frames, refcounted channel subscriptions, re-subscription per
// session epoch, and adapters for the pipeline hooks' `transport` and
// ui-components' EventStreamProvider `channelTransport`.
export { createSharedSocketTransport, defaultChannelService } from './sharedSocketTransport';
export type {
  SharedSocketTransport,
  SharedSocketTransportOptions,
  SharedSocketSubscribeOptions,
  SharedSocketChannelService,
  SharedSocketFrame,
  SharedPipelineRunTransport,
  SharedChannelTransport,
} from './sharedSocketTransport';
export { useSharedSocketTransport, useSharedWebSocket } from './useSharedSocketTransport';
export type {
  SharedSocketBinding,
  UseSharedSocketTransportOptions,
  UseSharedWebSocketResult,
} from './useSharedSocketTransport';
