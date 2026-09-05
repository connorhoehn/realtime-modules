import React, { type ReactNode } from 'react';
import type { UseWebSocketHookReturn } from './useWebSocket';
import type { GatewayMessage } from './types';
/** All feature identifiers that GatewaySocketProvider knows how to activate. */
export type FeatureName = 'chat' | 'presence' | 'cursor' | 'reactions' | 'activity' | 'agent-streaming' | 'fileupload';
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
    getCapability?: (name: string, channel?: string) => Promise<{
        enabled: boolean;
        version?: string;
        metadata?: Record<string, unknown>;
    }>;
    /** Pinned messages for a channel, newest pin first. */
    listPins?: (channel: string) => Promise<PinnedMessage[]>;
    pin?: (input: {
        channel: string;
        messageId: string;
        text: string;
        author: string;
    }) => Promise<PinnedMessage | null>;
    unpin?: (channel: string, messageId: string) => Promise<void>;
}
/**
 * A message pinned to the top of a channel.
 *
 * Channel state, not message content: set by one person, seen by everyone,
 * and outliving the session that set it — which is why it has its own store
 * rather than riding the message's metadata, where a later pin by someone
 * else would have nowhere to live.
 */
export interface PinnedMessage {
    channelId: string;
    messageId: string;
    /** userId of whoever pinned it. */
    pinnedBy: string;
    /** ISO-8601. */
    pinnedAt: string;
    /** Short excerpt, so a pin panel renders without re-reading the transcript. */
    preview: string;
    /** Display name of the original sender. */
    author: string;
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
export declare function httpBaseFromSocketUrl(url: string): string | null;
/** The default REST shim: plain fetch against the gateway's own origin. */
export declare function createGatewayRest(url: string, token?: string): GatewayRest | null;
/**
 * Holds the full UseWebSocketHookReturn so child hooks can consume the
 * WS connection without prop-drilling. Do not call useGateway() outside
 * a GatewaySocketProvider — it throws.
 */
export declare const GatewayContext: React.Context<GatewayContextValue | null>;
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
export declare function GatewaySocketProvider({ url, children, features, token, channel, rest, }: GatewaySocketProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * useGateway — access the WS connection inside a GatewaySocketProvider.
 *
 * Returns `GatewayContextValue` — a superset of `UseWebSocketHookReturn` that
 * also includes `onMessage(handler) => unsubscribe` for child feature hooks.
 *
 * Throws if called outside a provider so the error message is actionable.
 */
export declare function useGateway(): GatewayContextValue;
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
export declare function useFeatures(): FeatureName[];
//# sourceMappingURL=GatewaySocketProvider.d.ts.map