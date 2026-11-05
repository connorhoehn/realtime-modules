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
  SharedChannelState,
} from './sharedSocketTransport';
export { useSharedSocketTransport, useSharedWebSocket } from './useSharedSocketTransport';
export type {
  SharedSocketBinding,
  UseSharedSocketTransportOptions,
  UseSharedWebSocketResult,
} from './useSharedSocketTransport';

// v0.145.0 — live refresh: a frame is a hint that re-reads the record
// (coalesced, one read in flight + one queued), polling when the socket is
// down or the channel refused, paused while hidden. Plus the provider that
// keeps the shared transport in context (non-null while disconnected).
export {
  createLiveRefresh,
  liveRefreshDelay,
  DEFAULT_LIVE_REFRESH_POLL_MS,
  DEFAULT_LIVE_REFRESH_LIVE_POLL_MS,
  MAX_LIVE_REFRESH_BACKOFF,
} from './liveRefresh';
export type { LiveRefresh, LiveRefreshOptions, LiveRefreshTimers } from './liveRefresh';
export { useLiveRefresh } from './useLiveRefresh';
export type { UseLiveRefreshOptions, UseLiveRefreshResult, LiveRefreshSocket } from './useLiveRefresh';
export { SharedSocketProvider, useSharedSocket } from './SharedSocketProvider';
export type { SharedSocketProviderProps, SharedSocketContextValue, SharedSocketStatus } from './SharedSocketProvider';
export { useDocumentHidden, isDocumentHidden } from './useDocumentHidden';
