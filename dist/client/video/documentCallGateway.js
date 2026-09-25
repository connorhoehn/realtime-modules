"use strict";
// The slice of the gateway the document-call hooks use, and how they find
// it: an explicit `gateway` option wins, else the GatewayContext of a
// surrounding GatewaySocketProvider.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDocumentCallGateway = useDocumentCallGateway;
exports.gatewaySend = gatewaySend;
exports.asCallFrame = asCallFrame;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
function useDocumentCallGateway(explicit) {
    const ctx = (0, react_1.useContext)(GatewaySocketProvider_1.GatewayContext);
    if (explicit)
        return explicit;
    if (!ctx)
        return null;
    return ctx;
}
function gatewaySend(gw, msg) {
    if (!gw)
        return;
    const fn = gw.send ?? gw.sendMessage;
    if (typeof fn === 'function')
        fn(msg);
}
/** A `{ type:'call', action, data }` frame, or null. */
function asCallFrame(msg) {
    const m = msg;
    if (m.type !== 'call' || typeof m.action !== 'string')
        return null;
    const data = m.data && typeof m.data === 'object' ? m.data : {};
    return { action: m.action, data };
}
//# sourceMappingURL=documentCallGateway.js.map