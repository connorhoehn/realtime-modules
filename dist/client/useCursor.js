"use strict";
// realtime-modules/src/client/useCursor.ts
//
// useCursor(channel, opts?) — the client half of the cursor triple.
//
// CursorService has shipped since the Wave 2 lift with a manifest and a
// service but no hook, and both README and the adoption guide told consumers
// to "consume cursor updates through useAwarenessState" instead. That answer
// only holds if you are already running a Yjs document: awareness rides the
// CRDT provider. A channel that wants Figma-style cursors over the gateway —
// no Y.Doc anywhere — had to hand-roll the frames. This is that hook.
//
// Returns:
//   cursors   — everyone else's live cursor in the channel
//   move      — publish your own position (client-throttled, see below)
//   refresh   — re-ask for the channel snapshot
//
// WIRE CONTRACT (src/cursor/CursorService.ts handleAction):
//   outbound  { service:'cursor', action:'subscribe',   channel }
//             { service:'cursor', action:'unsubscribe', channel }
//             { service:'cursor', action:'update', channel, position, metadata?, mode? }
//             { service:'cursor', action:'get', channel }
//   inbound   { type:'cursor', action:'subscribed', channel, cursors: CursorData[] }
//             { type:'cursor', action:'cursors',    channel, cursors: CursorData[] }
//             { type:'cursor', action:'update',     channel, cursor: CursorData }
//             { type:'cursor', action:'remove',     channel, clientId }
//             { type:'cursor', action:'unsubscribed', channel }
// The cursor verbs have no event-catalog declarations yet, so the send-sites
// carry no `satisfies` annotations — unlike chat/presence/reaction, whose
// frames the contract test pins.
//
// Throttling is the whole reason this hook is not three lines of send().
// The service accepts one update per client per CURSOR_THROTTLE_INTERVAL_MS
// (250 default) and DROPS the rest silently — no error, no ack. A component
// wired straight to onMouseMove fires ~60/s, so roughly 95% of what it sends
// is thrown away after crossing the wire. So `move` throttles locally at the
// same interval, and keeps the last suppressed position to send on the
// trailing edge: without that, the cursor freezes wherever the last accepted
// frame landed rather than where the pointer actually stopped.
//
// Your own updates never come back (broadcastCursorUpdate excludes the
// sender), but the subscribe snapshot is the server's whole channel map and
// can still contain a stale cursor of yours from a previous connection. Pass
// opts.selfClientId to keep it out of `cursors`.
//
// Socket-explicit and provider-optional, like useReactions and
// useChatReadReceipts: pass opts.socket and the hook never reads
// GatewaySocketProvider context. With neither socket nor provider it goes
// inert (empty cursors, no-op move) instead of throwing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCursor = useCursor;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
/** Mirrors CURSOR_THROTTLE_INTERVAL_MS / DEFAULT_THROTTLE_INTERVAL_MS. */
const DEFAULT_THROTTLE_MS = 250;
// Module-scope so their identity never changes across renders — the
// subscribe effect depends on `send`, and a fresh closure each render would
// re-subscribe (and clear state) forever.
function noopSend() { }
function inertOnMessage() {
    return () => { };
}
function useCursor(channel, opts) {
    // Unconditional, non-throwing context read — rules of hooks apply even
    // when opts.socket is given and the context value goes unused.
    const gatewayCtx = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const send = opts?.socket?.send ?? gatewayCtx?.send ?? noopSend;
    const onMessage = opts?.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
    const [cursors, setCursors] = (0, react_1.useState)([]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => {
        channelRef.current = channel;
    }, [channel]);
    // Latest options read through refs so `move` keeps a stable identity — it
    // is handed to onMouseMove, and a new function every render would rebind
    // the listener on every pointer event.
    const optsRef = (0, react_1.useRef)(opts);
    (0, react_1.useEffect)(() => {
        optsRef.current = opts;
    });
    // Inbound frames.
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            const raw = msg;
            if (raw.type !== 'cursor')
                return;
            if (raw.channel !== channelRef.current)
                return;
            // The snapshot on subscribe, and the answer to `get`. Both are the
            // channel's whole map, so they REPLACE rather than merge.
            if (raw.action === 'subscribed' || raw.action === 'cursors') {
                const list = Array.isArray(raw.cursors) ? raw.cursors : [];
                setCursors(list.map((c) => asCursor(c)).filter(Boolean));
                return;
            }
            // Somebody moved. Replace their entry in place — one cursor per client.
            if (raw.action === 'update') {
                const entry = asCursor(raw.cursor);
                if (!entry)
                    return;
                setCursors((prev) => {
                    const i = prev.findIndex((c) => c.clientId === entry.clientId);
                    if (i === -1)
                        return [...prev, entry];
                    const next = prev.slice();
                    next[i] = entry;
                    return next;
                });
                return;
            }
            // Disconnected, or swept for going stale past CURSOR_TTL_MS.
            if (raw.action === 'remove') {
                const gone = typeof raw.clientId === 'string' ? raw.clientId : null;
                if (gone)
                    setCursors((prev) => prev.filter((c) => c.clientId !== gone));
            }
        });
        return unsubscribe;
    }, [onMessage]);
    // Subscribe / unsubscribe. The service only fans out to subscribers, and
    // the subscribe reply carries the snapshot.
    (0, react_1.useEffect)(() => {
        setCursors([]);
        send({ service: 'cursor', action: 'subscribe', channel });
        return () => {
            send({ service: 'cursor', action: 'unsubscribe', channel });
        };
    }, [channel, send]);
    // --- throttle state -------------------------------------------------
    // lastSentAt: when the last frame actually went out.
    // pending: the newest position suppressed since then, waiting on the timer.
    const lastSentAt = (0, react_1.useRef)(0);
    const pending = (0, react_1.useRef)(null);
    const timer = (0, react_1.useRef)(null);
    // A ref so the flush timer and `move` share one sender without either
    // depending on `send`'s identity.
    const sendRef = (0, react_1.useRef)(send);
    (0, react_1.useEffect)(() => {
        sendRef.current = send;
    }, [send]);
    const emit = (0, react_1.useCallback)((position, metadata) => {
        const o = optsRef.current;
        const frame = {
            service: 'cursor',
            action: 'update',
            channel: channelRef.current,
            position,
            mode: o?.mode ?? 'freeform',
        };
        const merged = { ...(o?.metadata ?? {}), ...(metadata ?? {}) };
        if (Object.keys(merged).length > 0)
            frame.metadata = merged;
        lastSentAt.current = Date.now();
        sendRef.current(frame);
    }, []);
    const move = (0, react_1.useCallback)((position, metadata) => {
        const gap = optsRef.current?.throttleMs ?? DEFAULT_THROTTLE_MS;
        const since = Date.now() - lastSentAt.current;
        if (since >= gap) {
            pending.current = null;
            emit(position, metadata);
            return;
        }
        // Inside the window: hold the newest position and arm one timer for
        // the trailing edge. Without this the cursor would stick at the last
        // accepted frame instead of where the pointer came to rest.
        pending.current = { position, metadata };
        if (timer.current === null) {
            timer.current = setTimeout(() => {
                timer.current = null;
                const held = pending.current;
                pending.current = null;
                if (held)
                    emit(held.position, held.metadata);
            }, gap - since);
        }
    }, [emit]);
    // Drop a queued trailing send on unmount — it would publish a position for
    // a component that is gone, and on a channel it no longer subscribes to.
    (0, react_1.useEffect)(() => () => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        pending.current = null;
    }, []);
    const refresh = (0, react_1.useCallback)(() => {
        sendRef.current({ service: 'cursor', action: 'get', channel: channelRef.current });
    }, []);
    const self = opts?.selfClientId;
    const visible = self !== undefined ? cursors.filter((c) => c.clientId !== self) : cursors;
    return { cursors: visible, move, refresh };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asCursor(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.clientId !== 'string' || typeof r.channel !== 'string')
        return null;
    if (!r.position || typeof r.position !== 'object')
        return null;
    const meta = (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {});
    return {
        clientId: r.clientId,
        channel: r.channel,
        position: r.position,
        metadata: {
            ...meta,
            mode: typeof meta.mode === 'string' ? meta.mode : 'freeform',
            userInitials: typeof meta.userInitials === 'string' ? meta.userInitials : '',
            userColor: typeof meta.userColor === 'string' ? meta.userColor : '',
        },
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
    };
}
//# sourceMappingURL=useCursor.js.map