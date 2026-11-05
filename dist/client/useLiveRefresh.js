"use strict";
// realtime-modules/src/client/useLiveRefresh.ts
//
// React binding for createLiveRefresh (0.145.0): read a record, re-read it on
// a frame hint, and poll when frames cannot be trusted to arrive.
//
//   const { data: project, live } = useLiveRefresh(readProject, {
//     channel: `studio:project:${id}`,
//     isHint: (f) => f.type === 'studio.work.changed' && f.projectId === id,
//     coalesceMs: 100,
//     pollMs: 15_000,
//   });
//
// `live` = the socket is connected AND the channel's subscribe was
// acknowledged in this session. A refused channel (`{ type: 'error', channel }`)
// or one the server never answers (the subscribe service's silence is a
// refusal) stays on polling. Becoming live — including after every reconnect,
// since a new session puts the channel back to pending until its ack — reads
// the record once to catch up. Polling pauses while the document is hidden.
//
// The socket: the `socket` option, else the nearest SharedSocketProvider.
// GatewaySocketProvider is not read directly — bridge it with
// `<SharedSocketProvider fromGateway>`. With no socket at all the hook polls.
// The channel is held through the shared transport, refcounted with every
// other holder (two views of one project send one subscribe, and the first to
// unmount does not cut the other).
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLiveRefresh = useLiveRefresh;
const react_1 = require("react");
const liveRefresh_1 = require("./liveRefresh");
const SharedSocketProvider_1 = require("./SharedSocketProvider");
const useDocumentHidden_1 = require("./useDocumentHidden");
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isControlFrame = (f) => f.type === 'error' || f.action === 'subscribed' || f.action === 'unsubscribed';
/** Read a record, re-read it on frame hints while live, poll otherwise. See the file header. */
function useLiveRefresh(read, options = {}) {
    const provided = (0, SharedSocketProvider_1.useSharedSocket)();
    const socket = options.socket !== undefined ? options.socket : provided;
    const transport = socket?.transport;
    const connectionState = socket ? socket.connectionState ?? 'connected' : null;
    const enabled = options.enabled !== false;
    const channel = enabled && options.channel ? options.channel : undefined;
    const { service, coalesceMs, livePollMs, pollMs, maxBackoff } = options;
    // Callbacks travel by ref: a fresh closure per render re-creates nothing.
    const latest = (0, react_1.useRef)({ read, options });
    latest.current = { read, options };
    // The channel, held while mounted (refcounted on the shared transport).
    (0, react_1.useEffect)(() => {
        if (!transport || !channel)
            return undefined;
        return transport.subscribe(channel, service ? { service } : undefined);
    }, [transport, channel, service]);
    // The channel's state, and the transport's session when it was seen.
    const [seen, setSeen] = (0, react_1.useState)({ state: 'unheld', epoch: undefined });
    const channelState = seen.state;
    const [refusedHere, setRefusedHere] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        setRefusedHere(false);
        if (!transport || !channel) {
            setSeen({ state: 'unheld', epoch: undefined });
            return undefined;
        }
        setSeen({ state: transport.channelState(channel), epoch: transport.sessionEpoch });
        const offState = transport.onChannelState((c, state) => {
            if (c !== channel)
                return;
            setSeen({ state, epoch: transport.sessionEpoch });
            if (state === 'pending')
                setRefusedHere(false); // a re-sent subscribe awaits a new answer
        });
        const offFrames = transport.onMessage((frame) => {
            const refuses = latest.current.options.isRefusal;
            if (refuses && isRecord(frame) && refuses(frame))
                setRefusedHere(true);
        });
        return () => { offState(); offFrames(); };
    }, [transport, channel]);
    const sessionEpoch = socket?.sessionEpoch;
    const live = enabled && !!transport && connectionState === 'connected'
        && (!channel || (channelState === 'subscribed' && !refusedHere
            && (sessionEpoch === undefined || seen.epoch === sessionEpoch)));
    const hidden = (0, useDocumentHidden_1.useDocumentHidden)();
    const [data, setData] = (0, react_1.useState)(undefined);
    const [error, setError] = (0, react_1.useState)(undefined);
    const controller = (0, react_1.useRef)(null);
    const state = (0, react_1.useRef)({ live, hidden });
    state.current = { live, hidden };
    // Start over on a new record (channel / key).
    const key = options.key;
    (0, react_1.useEffect)(() => {
        setData(undefined);
        setError(undefined);
    }, [channel, key, enabled]);
    (0, react_1.useEffect)(() => {
        if (!enabled)
            return undefined;
        const ctl = (0, liveRefresh_1.createLiveRefresh)({
            read: (signal) => latest.current.read(signal),
            coalesceMs, livePollMs, pollMs, maxBackoff,
            live: state.current.live,
            hidden: state.current.hidden,
            onData: (value) => { setData(value); setError(undefined); latest.current.options.onData?.(value); },
            onError: (err) => { setError(err); latest.current.options.onError?.(err); },
        });
        controller.current = ctl;
        return () => {
            ctl.dispose();
            if (controller.current === ctl)
                controller.current = null;
        };
    }, [enabled, channel, key, coalesceMs, livePollMs, pollMs, maxBackoff]);
    (0, react_1.useEffect)(() => { controller.current?.setLive(live); }, [live]);
    (0, react_1.useEffect)(() => { controller.current?.setHidden(hidden); }, [hidden]);
    // Frames → hints.
    (0, react_1.useEffect)(() => {
        if (!transport || !enabled)
            return undefined;
        return transport.onMessage((frame) => {
            if (!isRecord(frame))
                return;
            const isHint = latest.current.options.isHint;
            const counts = isHint ? isHint(frame) : !!channel && frame.channel === channel && !isControlFrame(frame);
            if (counts)
                controller.current?.hint();
        });
    }, [transport, enabled, channel]);
    const [refresh] = (0, react_1.useState)(() => () => controller.current?.refresh());
    return {
        data,
        error,
        loading: enabled && data === undefined && error === undefined,
        live,
        connectionState,
        channelState,
        refresh,
    };
}
//# sourceMappingURL=useLiveRefresh.js.map