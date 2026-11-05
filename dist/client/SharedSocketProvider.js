"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSharedSocket = useSharedSocket;
exports.SharedSocketProvider = SharedSocketProvider;
const jsx_runtime_1 = require("react/jsx-runtime");
// realtime-modules/src/client/SharedSocketProvider.tsx
//
// Puts one shared socket transport (createSharedSocketTransport) in context
// (0.145.0), so useLiveRefresh and an app's pages reach it without prop
// drilling — and without nulling it while the socket is down. The transport
// is stable for the provider's life; whether frames can arrive right now is
// `connectionState` / `live`, read beside it.
//
// Three ways to feed it:
//
//   // 1. It owns the socket (useSharedWebSocket inside).
//   <SharedSocketProvider options={{ url, authToken, maxRetries: 5 }}>
//
//   // 2. The host already owns one (useSharedWebSocket in the app shell).
//   const { socket, transport } = useSharedWebSocket({ url, onMessage });
//   <SharedSocketProvider socket={socket} transport={transport}>
//
//   // 3. Bridge the nearest GatewaySocketProvider's socket.
//   <GatewaySocketProvider url={url}><SharedSocketProvider fromGateway>…
//
// Precedence. This context and GatewaySocketProvider's are separate.
// useLiveRefresh reads its `socket` option first, then the nearest
// SharedSocketProvider, and never GatewaySocketProvider directly — inside a
// gateway provider, mount `<SharedSocketProvider fromGateway>` to use its
// socket. The feature hooks (useChat, usePipelineRunStatus without a
// `transport`, …) keep reading GatewaySocketProvider and are unaffected by
// this provider. The bridge's channel holds are refcounted among the shared
// transport's consumers only; the gateway's own feature hooks send their
// subscribes directly, so do not hold the same channel both ways.
const react_1 = require("react");
const useSharedSocketTransport_1 = require("./useSharedSocketTransport");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const SharedSocketContext = (0, react_1.createContext)(null);
/** The nearest SharedSocketProvider's value, or null outside one. */
function useSharedSocket() {
    return (0, react_1.useContext)(SharedSocketContext);
}
function useValue(transport, socket) {
    const connectionState = socket.connectionState ?? 'connected';
    const sessionEpoch = socket.sessionEpoch;
    return (0, react_1.useMemo)(() => ({
        transport,
        connectionState,
        live: connectionState === 'connected',
        ...(sessionEpoch !== undefined ? { sessionEpoch } : {}),
    }), [transport, connectionState, sessionEpoch]);
}
function Owned({ options, transportOptions, children }) {
    const { socket, transport } = (0, useSharedSocketTransport_1.useSharedWebSocket)(options, transportOptions);
    const value = useValue(transport, socket);
    return (0, jsx_runtime_1.jsx)(SharedSocketContext.Provider, { value: value, children: children });
}
function Bound({ socket, transport, children }) {
    const value = useValue(transport, socket);
    return (0, jsx_runtime_1.jsx)(SharedSocketContext.Provider, { value: value, children: children });
}
function FromGateway({ transportOptions, children }) {
    const gateway = (0, GatewaySocketProvider_1.useGateway)();
    const transport = (0, useSharedSocketTransport_1.useSharedSocketTransport)(gateway, transportOptions);
    const { onMessage } = gateway;
    (0, react_1.useEffect)(() => onMessage((frame) => transport.deliver(frame)), [onMessage, transport]);
    const value = useValue(transport, gateway);
    return (0, jsx_runtime_1.jsx)(SharedSocketContext.Provider, { value: value, children: children });
}
/** One shared socket transport in context; see the file header for the three modes and the precedence. */
function SharedSocketProvider(props) {
    if (props.fromGateway)
        return (0, jsx_runtime_1.jsx)(FromGateway, { transportOptions: props.transportOptions, children: props.children });
    if (props.transport)
        return (0, jsx_runtime_1.jsx)(Bound, { socket: props.socket, transport: props.transport, children: props.children });
    return (0, jsx_runtime_1.jsx)(Owned, { options: props.options, transportOptions: props.transportOptions, children: props.children });
}
//# sourceMappingURL=SharedSocketProvider.js.map