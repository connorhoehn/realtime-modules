"use strict";
// realtime-modules/src/client/documents/transport.ts
//
// The transport seam the documents hooks share with `usePipelineCatalog`: a
// host-owned `{ send, onMessage }` handle, else the nearest
// GatewaySocketProvider, and `null` for no live frames. Plus the reconnect
// rule: every session epoch after the first is a new connection that may have
// missed frames, so the hook re-reads once.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useResolvedTransport = useResolvedTransport;
exports.useRefreshOnReconnect = useRefreshOnReconnect;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
function useResolvedTransport(transport, sessionEpoch) {
    const gateway = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage;
    const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage;
    const epoch = sessionEpoch ?? (transport === undefined ? gateway?.sessionEpoch : undefined);
    return { send, onMessage, epoch };
}
/** Calls `refresh` once per session epoch after the first one seen (a reconnect). */
function useRefreshOnReconnect(epoch, refresh) {
    const seen = (0, react_1.useRef)(undefined);
    (0, react_1.useEffect)(() => {
        if (epoch === undefined)
            return;
        if (seen.current === undefined) {
            seen.current = epoch;
            return;
        }
        if (epoch === seen.current)
            return;
        seen.current = epoch;
        refresh();
    }, [epoch, refresh]);
}
//# sourceMappingURL=transport.js.map