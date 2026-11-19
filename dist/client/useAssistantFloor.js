"use strict";
// realtime-modules/src/client/useAssistantFloor.ts
//
// Who has a call assistant's ear, pushed. A call that runs its assistant
// hands-free has a "floor": at most one person the assistant is listening to
// (they said its name, asked a follow-up, or are holding a talk button). The
// server sends a frame on the call's chat channel whenever the floor changes:
//
//   { type: 'assistant-floor', channel, handsfree: boolean,
//     floor: { userId, name, via, phase } | null }
//
// The hook reads the floor once with `read` (the app's REST read; it may also
// carry per-viewer fields such as `mayHold`), then applies every frame for its
// channel. It reads again after the socket reconnects (frames sent while it
// was away are lost), and never polls. The channel guard is the server's: a
// frame reaches only sockets admitted to that channel.
//
//   const { view } = useAssistantFloor({
//     channel: `orgiq:huddle:${callId}`,
//     read: (signal) => fetch(`/api/calls/${callId}/assistant/floor`, { signal }).then((r) => r.json()),
//   });
//
// The socket: the `gateway` option (anything with `onMessage`, and
// `connectionState` for the reconnect read), else the nearest GatewayContext.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_ASSISTANT_FLOOR = exports.ASSISTANT_FLOOR_FRAME = void 0;
exports.parseAssistantFloor = parseAssistantFloor;
exports.assistantFloorFrame = assistantFloorFrame;
exports.floorFromFrame = floorFromFrame;
exports.useAssistantFloor = useAssistantFloor;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
exports.ASSISTANT_FLOOR_FRAME = 'assistant-floor';
exports.NO_ASSISTANT_FLOOR = Object.freeze({ handsfree: false, floor: null });
const VIA = ['name', 'follow-up', 'hold'];
const PHASE = ['routing', 'answering'];
const MAX_NAME = 80;
const recordOf = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
/** Reads a floor body (a `read` answer or a frame); anything malformed is no floor. `mayHold` is kept when it is a boolean. */
function parseAssistantFloor(body) {
    const b = recordOf(body) ?? {};
    const f = recordOf(b['floor']);
    const via = VIA.find((v) => v === f?.['via']);
    const phase = PHASE.find((p) => p === f?.['phase']);
    const userId = f?.['userId'];
    const name = typeof f?.['name'] === 'string' ? f['name'].trim() : '';
    const handsfree = b['handsfree'] === true;
    const floor = handsfree && typeof userId === 'string' && userId && name && via && phase
        ? { userId, name: name.slice(0, MAX_NAME), via, phase } : null;
    return { handsfree, floor, ...(typeof b['mayHold'] === 'boolean' ? { mayHold: b['mayHold'] } : {}) };
}
/** The frame a server sends on `channel` when the floor changes (the shape the hook applies). */
function assistantFloorFrame(channel, view) {
    return { type: exports.ASSISTANT_FLOOR_FRAME, channel, handsfree: view.handsfree, floor: view.handsfree ? view.floor : null };
}
/** A floor frame for `channel`, parsed; null for any other frame. */
function floorFromFrame(frame, channel) {
    const f = recordOf(frame);
    if (!f || f['type'] !== exports.ASSISTANT_FLOOR_FRAME || f['channel'] !== channel)
        return null;
    const { mayHold: _ignored, ...view } = parseAssistantFloor(f);
    return view;
}
function useAssistantFloor(options) {
    const { channel, read, enabled = true } = options;
    const context = (0, react_1.useContext)(GatewaySocketProvider_1.GatewayContext);
    const gateway = options.gateway !== undefined ? options.gateway : context;
    const on = enabled && !!channel;
    const [view, setView] = (0, react_1.useState)(exports.NO_ASSISTANT_FLOOR);
    const readRef = (0, react_1.useRef)(read);
    readRef.current = read;
    const [readEpoch, setReadEpoch] = (0, react_1.useState)(0);
    // A frame changes who has the floor; the viewer's own `mayHold` stays as last read.
    const merge = (0, react_1.useCallback)((next) => {
        setView((cur) => ({ ...next, ...(next.mayHold === undefined && cur.mayHold !== undefined ? { mayHold: cur.mayHold } : {}) }));
    }, []);
    (0, react_1.useEffect)(() => {
        if (!on) {
            setView(exports.NO_ASSISTANT_FLOOR);
            return undefined;
        }
        const doRead = readRef.current;
        if (!doRead)
            return undefined;
        const ctrl = new AbortController();
        doRead(ctrl.signal).then((body) => { if (!ctrl.signal.aborted)
            merge(parseAssistantFloor(body)); }, () => { });
        return () => ctrl.abort();
    }, [on, channel, readEpoch, merge]);
    const onMessage = gateway?.onMessage;
    (0, react_1.useEffect)(() => {
        if (!on || !onMessage || !channel)
            return undefined;
        return onMessage((frame) => { const next = floorFromFrame(frame, channel); if (next)
            merge(next); });
    }, [on, onMessage, channel, merge]);
    // Frames sent while the socket was away are lost: read again when it is back.
    const connectionState = gateway?.connectionState;
    const wasConnected = (0, react_1.useRef)(connectionState === 'connected');
    (0, react_1.useEffect)(() => {
        const connected = connectionState === 'connected';
        if (connected && !wasConnected.current && on)
            setReadEpoch((n) => n + 1);
        wasConnected.current = connected;
    }, [connectionState, on]);
    const refresh = (0, react_1.useCallback)(() => setReadEpoch((n) => n + 1), []);
    const apply = (0, react_1.useCallback)((body) => merge(parseAssistantFloor(body)), [merge]);
    return { view: on ? view : exports.NO_ASSISTANT_FLOOR, refresh, apply };
}
//# sourceMappingURL=useAssistantFloor.js.map