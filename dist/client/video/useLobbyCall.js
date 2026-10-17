"use strict";
// useLobbyCall(lobbyName, opts?) — is there a call in this lobby right now,
// and who is in it, for someone who is NOT in it (0.136.0, lane L9).
//
// A page that shows a huddle card subscribes with the call service's `watch`
// verb: the server runs the host's channel authority on
// `callLobbyChannel(lobbyName)`, subscribes this socket there and answers
// with a `lobby-occupancy` snapshot; after that every seat, leave, dropped
// socket past its grace and call end arrives as another `lobby-occupancy`
// frame. No refresh, no ring.
//
// Outbound: { service: 'call', action: 'watch' | 'unwatch', lobbyName }.
// Inbound:  { type: 'call', action: 'lobby-occupancy', data: CallLobbyOccupancy }.
//
// Socket: like useMeeting, pass `socket` to bypass GatewaySocketProvider;
// with neither the hook is inert. Watches again after every reconnect
// (`sessionEpoch`).
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLobbyOccupancy = parseLobbyOccupancy;
exports.useLobbyCall = useLobbyCall;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
const IDLE = { live: false, callId: null, participantUserIds: [], count: 0, startedAt: null };
/**
 * A `lobby-occupancy` frame's data, checked; null when it is not one. Shared
 * with useConversationCall's discovery.
 */
function parseLobbyOccupancy(data) {
    if (!data || typeof data !== 'object')
        return null;
    const d = data;
    if (typeof d.lobbyName !== 'string' || !d.lobbyName)
        return null;
    const active = d.active === true && typeof d.callId === 'string' && d.callId.length > 0;
    const ids = active && Array.isArray(d.participantUserIds)
        ? Array.from(new Set(d.participantUserIds.filter((u) => typeof u === 'string' && u.length > 0)))
        : [];
    const out = {
        lobbyName: d.lobbyName,
        active,
        callId: active ? d.callId : null,
        participantUserIds: ids,
        participantCount: ids.length,
        startedAt: active && typeof d.startedAt === 'string' ? d.startedAt : null,
    };
    if (active && typeof d.callerId === 'string' && d.callerId)
        out.callerId = d.callerId;
    if (active && typeof d.callerName === 'string' && d.callerName)
        out.callerName = d.callerName;
    if (active && d.pageHuddle === true)
        out.pageHuddle = true;
    return out;
}
function noopSend() { }
function inertOnMessage() {
    return () => { };
}
function useLobbyCall(lobbyName, opts = {}) {
    const gatewayCtx = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const sessionEpoch = opts.socket ? opts.socket.sessionEpoch : gatewayCtx?.sessionEpoch;
    const send = opts.socket?.send ?? gatewayCtx?.send ?? noopSend;
    const onMessage = opts.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
    const enabled = opts.enabled !== false && !!lobbyName;
    const [state, setState] = (0, react_1.useState)({ lobby: null, value: IDLE });
    // `send` through a ref: an inline socket hands a new function each render,
    // and keying the watch on it would re-watch forever.
    const sendRef = (0, react_1.useRef)(send);
    sendRef.current = send;
    const lobbyRef = (0, react_1.useRef)(enabled ? lobbyName : null);
    lobbyRef.current = enabled ? lobbyName : null;
    // Inbound first, so the snapshot cannot arrive before anyone listens.
    (0, react_1.useEffect)(() => {
        return onMessage((msg) => {
            const m = msg;
            if (m.type !== 'call' || m.action !== 'lobby-occupancy')
                return;
            const occ = parseLobbyOccupancy(m.data);
            if (!occ || occ.lobbyName !== lobbyRef.current)
                return;
            setState({
                lobby: occ.lobbyName,
                value: { live: occ.active, callId: occ.callId, participantUserIds: occ.participantUserIds, count: occ.participantCount, startedAt: occ.startedAt },
            });
        });
    }, [onMessage]);
    // Watch per lobby, and again after every reconnect.
    (0, react_1.useEffect)(() => {
        if (!enabled || !lobbyName)
            return;
        sendRef.current({ service: 'call', action: 'watch', lobbyName });
        return () => {
            sendRef.current({ service: 'call', action: 'unwatch', lobbyName });
        };
    }, [enabled, lobbyName, sessionEpoch]);
    // A frame for another lobby never shows here; neither does a stale one.
    return enabled && state.lobby === lobbyName ? state.value : IDLE;
}
//# sourceMappingURL=useLobbyCall.js.map