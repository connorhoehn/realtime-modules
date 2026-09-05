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
//     to presence events on connect (emits a presence/subscribe frame).
//   - When 'chat' is in features, the provider joins the chat channel on
//     connect (gateway-real verb is 'join' — hub#1497).
//   - Both auto-wired frames REQUIRE a channel (the gateway rejects
//     channel-less subscribe/join), so they are skipped when no channel
//     prop / currentChannel is set — feature hooks handle their own wiring.
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
  | 'agent-streaming'
  // File transfer. Named here because the WS side of an upload is a real
  // service (request-upload / complete / cancel + the channel broadcasts);
  // only the bytes leave the socket.
  | 'fileupload';

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
   * Currently auto-wired (requires `channel` to be set — the gateway
   * rejects channel-less presence subscribe / chat join frames):
   *   - 'presence' → emits a presence/subscribe frame on connect
   *   - 'chat'     → emits a chat/join frame on connect (hub#1497: the
   *                  gateway chat verb is 'join'; 'subscribe' was never
   *                  accepted)
   *
   * All other names are stored in context for useFeatures() but require no
   * provider-level subscription (the feature hooks handle their own wiring).
   *
   * If omitted, behavior is identical to calling useWebSocket() directly.
   */
  features?: FeatureName[];
  /**
   * REST surface for the questions a socket cannot answer — today that is
   * capability resolution (`GET /api/capabilities`).
   *
   * Defaults to an HTTP shim derived from `url`, because the alternative was
   * worse than it looked: `rest` used to be an undeclared extension point
   * that only Lambda-tier proxy clients wired in, so in every browser app
   * `useCapability`/`useCapabilities` found no way to ask, took their
   * optimistic fallback, and reported EVERY capability enabled. The gate was
   * wired end to end and never fired once.
   *
   * Pass `null` to switch it off deliberately (a deployment with no
   * capability endpoint), or your own object to route through a proxy.
   */
  rest?: GatewayRest | null;
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
/**
 * The non-socket half of the gateway. Small on purpose: this is for the
 * questions that are not a stream.
 */
export interface GatewayRest {
  getCapability?: (
    name: string,
    channel?: string,
  ) => Promise<{ enabled: boolean; version?: string; metadata?: Record<string, unknown> }>;
}

export interface GatewayContextValue extends UseWebSocketHookReturn {
  onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
  /** See GatewaySocketProviderProps.rest. Null when explicitly disabled. */
  rest?: GatewayRest | null;
}

/**
 * `ws://host` → `http://host`, `wss://` → `https://`. The gateway serves its
 * REST routes on the same origin it accepts sockets on, so the socket URL is
 * the only configuration a consumer should have to supply.
 */
export function httpBaseFromSocketUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The default REST shim: plain fetch against the gateway's own origin. */
export function createGatewayRest(url: string, token?: string): GatewayRest | null {
  const base = httpBaseFromSocketUrl(url);
  if (!base) return null;
  return {
    async getCapability(name: string, channel?: string) {
      const qs = new URLSearchParams({ name });
      if (channel) qs.set('channel', channel);
      const res = await fetch(`${base}/api/capabilities?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        // Carries `status` so the hooks can tell 404 ("this gateway has no
        // capability endpoint" — the optimistic case) from a real failure.
        const err = new Error(`capability query failed: ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as { enabled: boolean; version?: string; metadata?: Record<string, unknown> };
    },
  };
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
  rest,
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

    // Both auto-wired frames require a concrete channel — the gateway
    // rejects channel-less presence subscribe ("Channel is required") and
    // chat join ("Channel name is required"). Without a channel, leave the
    // wiring to the feature hooks.
    if (!currentChannel) return;

    if (active.includes('presence')) {
      // Notify the gateway that this client wants presence events for the
      // current channel.
      send({
        service: 'presence',
        action: 'subscribe',
        channel: currentChannel,
      } satisfies ClientFramePayload<'client.presence.subscribe'>);
    }

    if (active.includes('chat')) {
      // Join the chat channel (gateway-real verb — hub#1497). The gateway
      // acks with chat/joined and auto-pushes recent history.
      send({
        service: 'chat',
        action: 'join',
        channel: currentChannel,
      } satisfies ClientFramePayload<'client.chat.join'>);
    }
    // 'cursor', 'reactions', 'activity', 'agent-streaming' — each feature
    // hook manages its own subscription lifecycle. The provider registers
    // the name so useFeatures() returns the full declared list.
  }, [connectionState, send, currentChannel]);

  // Merge the message-bus subscriber into the WS context value. useMemo keeps
  // the identity stable across renders (only changes when `ws` identity changes,
  // which is rare — reconnects don't replace the ws object).
  // `undefined` means "give me the default"; `null` means "there is no REST
  // surface here" and must survive as null so the hooks take their no-endpoint
  // path rather than building a shim against a URL nobody wanted used.
  const resolvedRest = useMemo<GatewayRest | null>(
    () => (rest === undefined ? createGatewayRest(url, token) : rest),
    [rest, url, token],
  );

  const contextValue = useMemo<GatewayContextValue>(
    () => ({ ...ws, onMessage: busOnMessage, rest: resolvedRest }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, busOnMessage, resolvedRest],
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
