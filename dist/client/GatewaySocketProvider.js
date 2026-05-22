"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayContext = void 0;
exports.GatewaySocketProvider = GatewaySocketProvider;
exports.useGateway = useGateway;
exports.useFeatures = useFeatures;
const jsx_runtime_1 = require("react/jsx-runtime");
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
const react_1 = require("react");
const useWebSocket_1 = require("./useWebSocket");
/**
 * Holds the full UseWebSocketHookReturn so child hooks can consume the
 * WS connection without prop-drilling. Do not call useGateway() outside
 * a GatewaySocketProvider — it throws.
 */
exports.GatewayContext = (0, react_1.createContext)(null);
exports.GatewayContext.displayName = 'GatewayContext';
/**
 * Holds the active FeatureName list. Empty array when `features` is not
 * passed. Do not call useFeatures() outside a GatewaySocketProvider — it
 * returns [] gracefully (no throw, so feature guards are safe to call at
 * any level).
 */
const FeaturesContext = (0, react_1.createContext)([]);
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
function GatewaySocketProvider({ url, children, features = [], token, channel, }) {
    // Message-bus: child hooks register handlers; GatewaySocketProvider fans
    // each inbound frame out to all registered handlers in registration order.
    const handlersRef = (0, react_1.useRef)(new Set());
    const busOnMessage = (0, react_1.useCallback)((handler) => {
        handlersRef.current.add(handler);
        return () => {
            handlersRef.current.delete(handler);
        };
    }, []);
    const ws = (0, useWebSocket_1.useWebSocket)({
        url,
        authToken: token,
        defaultChannel: channel,
        autoResubscribe: false,
        onMessage: (msg) => {
            for (const handler of handlersRef.current) {
                try {
                    handler(msg);
                }
                catch {
                    // user handler errors must not break the bus
                }
            }
        },
    });
    // Stable refs so the effect below doesn't re-run when features identity
    // changes between renders (array literal creates new ref each render).
    const featuresRef = (0, react_1.useRef)(features);
    (0, react_1.useEffect)(() => {
        featuresRef.current = features;
    }, [features]);
    // Auto-subscribe to feature channels on connect. Re-runs when the
    // connection state changes — guards against double-subscribe via idempotent
    // subscribe call (gateway deduplicates service subscriptions).
    const { connectionState, send, currentChannel } = ws;
    (0, react_1.useEffect)(() => {
        if (connectionState !== 'connected')
            return;
        const active = featuresRef.current;
        if (active.includes('presence')) {
            // Notify the gateway that this client wants presence events.
            // The gateway presence service accepts a subscribe action on the
            // 'presence' service channel.
            send({
                service: 'presence',
                action: 'subscribe',
                channel: currentChannel || undefined,
            });
        }
        if (active.includes('chat')) {
            // Subscribe to chat messages for the current channel.
            send({
                service: 'chat',
                action: 'subscribe',
                channel: currentChannel || undefined,
            });
        }
        // 'cursor', 'reactions', 'activity', 'agent-streaming' — each feature
        // hook manages its own subscription lifecycle. The provider registers
        // the name so useFeatures() returns the full declared list.
    }, [connectionState, send, currentChannel]);
    // Merge the message-bus subscriber into the WS context value. useMemo keeps
    // the identity stable across renders (only changes when `ws` identity changes,
    // which is rare — reconnects don't replace the ws object).
    const contextValue = (0, react_1.useMemo)(() => ({ ...ws, onMessage: busOnMessage }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, busOnMessage]);
    return ((0, jsx_runtime_1.jsx)(FeaturesContext.Provider, { value: features, children: (0, jsx_runtime_1.jsx)(exports.GatewayContext.Provider, { value: contextValue, children: children }) }));
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
function useGateway() {
    const ctx = (0, react_1.useContext)(exports.GatewayContext);
    if (!ctx) {
        throw new Error('useGateway() must be called inside a <GatewaySocketProvider>. ' +
            'Mount GatewaySocketProvider near the root of your component tree.');
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
function useFeatures() {
    return (0, react_1.useContext)(FeaturesContext);
}
//# sourceMappingURL=GatewaySocketProvider.js.map