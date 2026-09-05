"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayContext = void 0;
exports.httpBaseFromSocketUrl = httpBaseFromSocketUrl;
exports.createGatewayRest = createGatewayRest;
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
//     to presence events on connect (emits a presence/subscribe frame).
//   - When 'chat' is in features, the provider joins the chat channel on
//     connect (gateway-real verb is 'join' — hub#1497).
//   - Both auto-wired frames REQUIRE a channel (the gateway rejects
//     channel-less subscribe/join), so they are skipped when no channel
//     prop / currentChannel is set — feature hooks handle their own wiring.
//   - Additive: omitting `features` is identical to the prior behavior where
//     the consumer wired subscriptions manually.
const react_1 = require("react");
const useWebSocket_1 = require("./useWebSocket");
/**
 * `ws://host` → `http://host`, `wss://` → `https://`. The gateway serves its
 * REST routes on the same origin it accepts sockets on, so the socket URL is
 * the only configuration a consumer should have to supply.
 */
function httpBaseFromSocketUrl(url) {
    try {
        const u = new URL(url);
        const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
        return `${protocol}//${u.host}`;
    }
    catch {
        return null;
    }
}
/** The default REST shim: plain fetch against the gateway's own origin. */
function createGatewayRest(url, token) {
    const base = httpBaseFromSocketUrl(url);
    if (!base)
        return null;
    const authHeaders = () => token ? { Authorization: `Bearer ${token}` } : {};
    const json = async (path, init) => {
        const res = await fetch(`${base}${path}`, {
            ...init,
            headers: { ...authHeaders(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
        });
        if (!res.ok) {
            const err = new Error(`gateway request failed: ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    };
    return {
        async listPins(channel) {
            const body = (await json(`/api/chat/pins?channel=${encodeURIComponent(channel)}`));
            return body.pins ?? [];
        },
        async pin(input) {
            const body = (await json('/api/chat/pins', {
                method: 'POST',
                body: JSON.stringify(input),
            }));
            return body.pin ?? null;
        },
        async unpin(channel, messageId) {
            await json('/api/chat/pins', {
                method: 'DELETE',
                body: JSON.stringify({ channel, messageId }),
            });
        },
        async getCapability(name, channel) {
            const qs = new URLSearchParams({ name });
            if (channel)
                qs.set('channel', channel);
            const res = await fetch(`${base}/api/capabilities?${qs.toString()}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!res.ok) {
                // Carries `status` so the hooks can tell 404 ("this gateway has no
                // capability endpoint" — the optimistic case) from a real failure.
                const err = new Error(`capability query failed: ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return (await res.json());
        },
    };
}
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
function GatewaySocketProvider({ url, children, features = [], token, channel, rest, }) {
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
        // Both auto-wired frames require a concrete channel — the gateway
        // rejects channel-less presence subscribe ("Channel is required") and
        // chat join ("Channel name is required"). Without a channel, leave the
        // wiring to the feature hooks.
        if (!currentChannel)
            return;
        if (active.includes('presence')) {
            // Notify the gateway that this client wants presence events for the
            // current channel.
            send({
                service: 'presence',
                action: 'subscribe',
                channel: currentChannel,
            });
        }
        if (active.includes('chat')) {
            // Join the chat channel (gateway-real verb — hub#1497). The gateway
            // acks with chat/joined and auto-pushes recent history.
            send({
                service: 'chat',
                action: 'join',
                channel: currentChannel,
            });
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
    const resolvedRest = (0, react_1.useMemo)(() => (rest === undefined ? createGatewayRest(url, token) : rest), [rest, url, token]);
    const contextValue = (0, react_1.useMemo)(() => ({ ...ws, onMessage: busOnMessage, rest: resolvedRest }), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, busOnMessage, resolvedRest]);
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