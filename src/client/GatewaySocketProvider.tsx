// realtime-modules/src/client/GatewaySocketProvider.tsx
//
// React context provider that wraps useWebSocket and exposes the WS
// connection to child hooks. Accepts an optional `features` prop so
// consumers can declare which realtime features are active — child hooks
// (usePresence, useChat, etc.) can read this list via useFeatures()
// instead of requiring each call-site to compose hooks manually.
//
// Design:
//   - GatewayContext exposes the UseWebSocketHookReturn so every child hook
//     can reach send / subscribe / connectionState / etc. without prop-drilling.
//   - FeaturesContext exposes FeatureName[] (empty when `features` not given).
//   - When 'presence' is in features, GatewaySocketProvider auto-subscribes
//     to presence events on connect (emits a presence:subscribe frame).
//   - When 'chat' is in features, the provider subscribes to the chat
//     service channel on connect.
//   - Additive: omitting `features` is identical to the prior behavior where
//     the consumer wired subscriptions manually.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useWebSocket } from './useWebSocket';
import type { UseWebSocketHookReturn } from './useWebSocket';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

// ---------------------------------------------------------------------------
// FeatureName
// ---------------------------------------------------------------------------

/** All feature identifiers that GatewaySocketProvider knows how to activate. */
export type FeatureName =
  | 'chat'
  | 'presence'
  | 'cursor'
  | 'reactions'
  | 'activity'
  | 'agent-streaming';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GatewaySocketProviderProps {
  /** WebSocket endpoint URL, e.g. ws://localhost:4000 */
  url: string;
  children: ReactNode;
  /**
   * Declare which realtime features this provider activates. When provided,
   * the provider auto-subscribes to required channels on connect so child
   * hooks work without manual wiring. Order is irrelevant; duplicates are
   * ignored.
   *
   * Currently auto-wired:
   *   - 'presence' → emits presence:subscribe on connect
   *   - 'chat'     → emits chat:subscribe on connect
   *
   * All other names are stored in context for useFeatures() but require no
   * provider-level subscription (the feature hooks handle their own wiring).
   *
   * If omitted, behavior is identical to calling useWebSocket() directly.
   */
  features?: FeatureName[];
  /**
   * Optional bearer token forwarded to useWebSocket as `authToken`.
   * Passed as the `bearer-token-v1` WS subprotocol header.
   */
  token?: string;
  /**
   * Optional channel name; forwarded as `defaultChannel` to useWebSocket.
   * Feature hooks (useChat, usePresence) read this from the ws context.
   */
  channel?: string;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/**
 * Extended WS context — `UseWebSocketHookReturn` plus a post-init message
 * subscription bus so child hooks (useChat, usePresence, etc.) can register
 * handlers without needing to be wired at construction time.
 *
 * `onMessage(handler)` — register a handler for inbound gateway frames.
 * Returns an unsubscribe function. Safe to call from any child component
 * inside a GatewaySocketProvider; handlers are called in registration order.
 */
export interface GatewayContextValue extends UseWebSocketHookReturn {
  onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
}

/**
 * Holds the full UseWebSocketHookReturn so child hooks can consume the
 * WS connection without prop-drilling. Do not call useGateway() outside
 * a GatewaySocketProvider — it throws.
 */
export const GatewayContext = createContext<GatewayContextValue | null>(null);
GatewayContext.displayName = 'GatewayContext';

/**
 * Holds the active FeatureName list. Empty array when `features` is not
 * passed. Do not call useFeatures() outside a GatewaySocketProvider — it
 * returns [] gracefully (no throw, so feature guards are safe to call at
 * any level).
 */
const FeaturesContext = createContext<FeatureName[]>([]);
FeaturesContext.displayName = 'FeaturesContext';

// ---------------------------------------------------------------------------
// Provider component
// ---------------------------------------------------------------------------

/**
 * GatewaySocketProvider — React context provider for the gateway WS
 * connection.
 *
 * Mount once near the top of your component tree:
 *
 * ```tsx
 * <GatewaySocketProvider
 *   url="wss://gateway.example.com"
 *   token={authToken}
 *   features={['presence', 'chat']}
 * >
 *   <App />
 * </GatewaySocketProvider>
 * ```
 *
 * Child components access the connection via useGateway() and the active
 * feature list via useFeatures().
 */
export function GatewaySocketProvider({
  url,
  children,
  features = [],
  token,
  channel,
}: GatewaySocketProviderProps) {
  // Message-bus: child hooks register handlers; GatewaySocketProvider fans
  // each inbound frame out to all registered handlers in registration order.
  const handlersRef = useRef<Set<(msg: GatewayMessage) => void>>(new Set());

  const busOnMessage = useCallback((handler: (msg: GatewayMessage) => void): (() => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const ws = useWebSocket({
    url,
    authToken: token,
    defaultChannel: channel,
    autoResubscribe: false,
    onMessage: (msg) => {
      for (const handler of handlersRef.current) {
        try {
          handler(msg);
        } catch {
          // user handler errors must not break the bus
        }
      }
    },
  });

  // Stable refs so the effect below doesn't re-run when features identity
  // changes between renders (array literal creates new ref each render).
  const featuresRef = useRef<FeatureName[]>(features);
  useEffect(() => {
    featuresRef.current = features;
  }, [features]);

  // Auto-subscribe to feature channels on connect. Re-runs when the
  // connection state changes — guards against double-subscribe via idempotent
  // subscribe call (gateway deduplicates service subscriptions).
  const { connectionState, send, currentChannel } = ws;
  useEffect(() => {
    if (connectionState !== 'connected') return;

    const active = featuresRef.current;

    if (active.includes('presence')) {
      // Notify the gateway that this client wants presence events.
      // The gateway presence service accepts a subscribe action on the
      // 'presence' service channel.
      send({
        service: 'presence',
        action: 'subscribe',
        channel: currentChannel || undefined,
      } satisfies ClientFramePayload<'client.presence.subscribe'>);
    }

    if (active.includes('chat')) {
      // Subscribe to chat messages for the current channel.
      send({
        service: 'chat',
        action: 'subscribe',
        channel: currentChannel || undefined,
      } satisfies ClientFramePayload<'client.chat.subscribe'>);
    }
    // 'cursor', 'reactions', 'activity', 'agent-streaming' — each feature
    // hook manages its own subscription lifecycle. The provider registers
    // the name so useFeatures() returns the full declared list.
  }, [connectionState, send, currentChannel]);

  // Merge the message-bus subscriber into the WS context value. useMemo keeps
  // the identity stable across renders (only changes when `ws` identity changes,
  // which is rare — reconnects don't replace the ws object).
  const contextValue = useMemo<GatewayContextValue>(
    () => ({ ...ws, onMessage: busOnMessage }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, busOnMessage],
  );

  return (
    <FeaturesContext.Provider value={features}>
      <GatewayContext.Provider value={contextValue}>
        {children}
      </GatewayContext.Provider>
    </FeaturesContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hooks
// ---------------------------------------------------------------------------

/**
 * useGateway — access the WS connection inside a GatewaySocketProvider.
 *
 * Returns `GatewayContextValue` — a superset of `UseWebSocketHookReturn` that
 * also includes `onMessage(handler) => unsubscribe` for child feature hooks.
 *
 * Throws if called outside a provider so the error message is actionable.
 */
export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error(
      'useGateway() must be called inside a <GatewaySocketProvider>. ' +
        'Mount GatewaySocketProvider near the root of your component tree.',
    );
  }
  return ctx;
}

/**
 * useFeatures — returns the FeatureName[] declared by the nearest
 * GatewaySocketProvider. Returns [] when called outside a provider
 * (safe to use in feature guards without wrapping in try/catch).
 *
 * ```tsx
 * function ChatPanel() {
 *   const features = useFeatures();
 *   if (!features.includes('chat')) return null;
 *   // ...
 * }
 * ```
 */
export function useFeatures(): FeatureName[] {
  return useContext(FeaturesContext);
}
