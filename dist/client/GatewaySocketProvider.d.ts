import React, { type ReactNode } from 'react';
import type { UseWebSocketHookReturn } from './useWebSocket';
/** All feature identifiers that GatewaySocketProvider knows how to activate. */
export type FeatureName = 'chat' | 'presence' | 'cursor' | 'reactions' | 'activity' | 'agent-streaming';
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
/**
 * Holds the full UseWebSocketHookReturn so child hooks can consume the
 * WS connection without prop-drilling. Do not call useGateway() outside
 * a GatewaySocketProvider — it throws.
 */
export declare const GatewayContext: React.Context<UseWebSocketHookReturn | null>;
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
export declare function GatewaySocketProvider({ url, children, features, token, channel, }: GatewaySocketProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * useGateway — access the WS connection inside a GatewaySocketProvider.
 *
 * Throws if called outside a provider so the error message is actionable.
 */
export declare function useGateway(): UseWebSocketHookReturn;
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