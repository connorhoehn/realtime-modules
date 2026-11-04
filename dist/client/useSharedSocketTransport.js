"use strict";
// realtime-modules/src/client/useSharedSocketTransport.ts
//
// React binding for createSharedSocketTransport (v0.144.0).
//
//   // The host owns the socket; useSharedWebSocket wraps useWebSocket and
//   // fans its single onMessage out to everyone.
//   const { socket, transport } = useSharedWebSocket({ url, authToken });
//   const runTransport = transport.asPipelineRunTransport();
//   usePipelineRunStatus(runs, { apiBaseUrl, idToken, transport: runTransport,
//     sessionEpoch: socket.sessionEpoch });
//   <EventStreamProvider channelTransport={transport.asChannelTransport()}>
//
// Or bind a socket built elsewhere with `useSharedSocketTransport(socket)` and
// hand each inbound frame to `transport.deliver`.
//
// The binding runs in a layout effect, before the consumers' passive effects
// in the same commit, so a new epoch re-sends every held channel once and the
// consumers' own release-and-re-hold on that epoch sends nothing more.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSharedSocketTransport = useSharedSocketTransport;
exports.useSharedWebSocket = useSharedWebSocket;
const react_1 = require("react");
const useWebSocket_1 = require("./useWebSocket");
const sharedSocketTransport_1 = require("./sharedSocketTransport");
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? react_1.useLayoutEffect : react_1.useEffect;
/**
 * A stable shared transport bound to `socket` (send, session epoch,
 * connection state). `null`/`undefined` unbinds: subscriptions are held and
 * re-sent when a socket is bound again. Inbound frames go to `transport.deliver`.
 */
function useSharedSocketTransport(socket, options) {
    const [transport] = (0, react_1.useState)(() => (0, sharedSocketTransport_1.createSharedSocketTransport)({
        ...(options?.scheduleRelease ? { scheduleRelease: options.scheduleRelease } : {}),
        ...(options?.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
    }));
    const send = socket?.send;
    const epoch = socket ? socket.sessionEpoch : 0;
    const state = socket?.connectionState;
    useIsomorphicLayoutEffect(() => {
        transport.update({
            send,
            sessionEpoch: epoch,
            isOpen: state === undefined ? undefined : () => state === 'connected',
        });
    }, [transport, send, epoch, state]);
    return transport;
}
/**
 * `useWebSocket` whose inbound frames fan out through a shared transport.
 * `options.onMessage`, when given, is called first for every frame.
 */
function useSharedWebSocket(options, transportOptions) {
    const [holder] = (0, react_1.useState)(() => ({}));
    const hostOnMessage = options.onMessage;
    const socket = (0, useWebSocket_1.useWebSocket)({
        ...options,
        onMessage: (msg) => {
            hostOnMessage?.(msg);
            holder.deliver?.(msg);
        },
    });
    const transport = useSharedSocketTransport(socket, transportOptions);
    holder.deliver = transport.deliver;
    return { socket, transport };
}
//# sourceMappingURL=useSharedSocketTransport.js.map