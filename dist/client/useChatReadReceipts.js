"use strict";
// realtime-modules/src/client/useChatReadReceipts.ts
//
// useChatReadReceipts(channel, opts?) — who has read how far in a chat
// channel, and the one call that says the viewer has read up to a point.
//
// A sibling of useChat rather than more return fields on it, for three
// reasons. (1) The socket dependency: useChat reads
// GatewaySocketProvider context and THROWS without it, and the lesson this
// codebase already wrote down — see the consuming app's
// `frontend/src/hooks/useCallReactions.ts` header, and `useReactions`'
// `opts.socket` that followed it — is that a hidden context dependency is
// the wrong default. This hook takes the socket in its signature, so it
// renders in a subtree with no provider and unit-tests without one.
// (2) The inputs are different: a receipt depends on whether the panel is
// being LOOKED at, which the transcript does not care about. (3) A
// conversation rail wants "who has read my last message" without mounting
// a transcript at all.
//
// ---------------------------------------------------------------------
// WHEN TO SEND A RECEIPT — the rule, so no host has to guess
// ---------------------------------------------------------------------
// A read receipt must mean "a person looked at this", not "a browser tab
// received this". The hook sends `read` when ALL of these hold:
//
//   1. the document is VISIBLE (`document.visibilityState === 'visible'`)
//      — a background tab has received the messages and read none of them;
//   2. the panel is ACTIVE — the window has focus and the chat is the thing
//      on screen (not a minimised popout, not a hidden tab in the app's own
//      tab strip). The host owns this fact and passes it as `opts.active`,
//      because only the host knows its own layout;
//   3. the NEWEST message is actually rendered — `opts.newestMessage` is
//      what the transcript has scrolled to the bottom of. Scrolled up
//      through history, the cursor stays where it was: the server refuses
//      to move it backwards anyway, so passing an older message is safe but
//      pointless.
//
// The hook applies (1) itself and folds it into `opts.active`, so a host
// that passes `active={panelFocused}` gets the visibility rule for free.
// It also de-duplicates (never re-sends a cursor at or behind the last one
// sent) and coalesces bursts to at most one frame per `throttleMs`, so a
// fast-arriving thread costs one frame a second, not one per message.
//
// Call `markRead()` by hand for the cases the rule cannot see: the user
// clicking into the composer, an "jump to latest" button, a panel that
// became active without any new message arriving.
//
// ---------------------------------------------------------------------
// WIRE CONTRACT (gateway ChatService — realtime-modules/src/chat)
// ---------------------------------------------------------------------
//   outbound { service:'chat', action:'read',     channel, messageId?, at? }
//   outbound { service:'chat', action:'receipts', channel }
//   inbound  { type:'chat', action:'receipts', channel, enabled, reason?,
//              limit, receipts: [{ userId, displayName?, readAt, updatedAt }] }
//              — full state: the reply to `receipts`, and re-broadcast to
//                the channel whenever the roster changes. REPLACES.
//   inbound  { type:'chat', action:'readReceipt', channel, userId,
//              displayName?, readAt, updatedAt } — one cursor moved. MERGES.
//
// `enabled:false` means this channel does not keep receipts —
// `reason: 'open-channel' | 'too-many-members' | 'unknown-roster' |
// 'disabled'`. The hook then stops sending `read` entirely, so a large
// channel costs nothing. Surface the reason rather than an empty list: "no
// receipts here" and "nobody has read it" look identical otherwise.
//
// The server stores a CURSOR per person (`readAt` = the timestamp of the
// newest message they have seen), so "has X read message M" is
// `readAt >= M.timestamp` — which is what `readersOf` does. There is no
// per-message receipt to ask for, by design; see ChatReadReceiptStore.
//
// No `satisfies ClientFramePayload<...>` on the send-sites: `client.chat.read`
// and `client.chat.receipts` are not declared in @connorhoehn/event-catalog
// yet (the same state `leave` and the reaction subscribe verbs are in, and
// annotated the same way — the declarations land with the next EC cut).
Object.defineProperty(exports, "__esModule", { value: true });
exports.useChatReadReceipts = useChatReadReceipts;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
const DEFAULT_THROTTLE_MS = 1_000;
// Stable module-scope fallbacks for the "no socket, no provider" case, so
// the hook's effects do not re-fire on every render.
function noopSend() { }
function inertOnMessage() {
    return () => { };
}
function useChatReadReceipts(channel, opts) {
    // Unconditional, non-throwing context read — rules of hooks, even when
    // opts.socket is given and the context value ends up unused.
    const gatewayCtx = (0, GatewaySocketProvider_1.useGatewayOptional)();
    // undefined when the caller supplied opts.socket — they own that socket's
    // lifecycle, so there is no epoch to follow.
    const sessionEpoch = gatewayCtx?.sessionEpoch;
    const send = opts?.socket?.send ?? gatewayCtx?.send ?? noopSend;
    const onMessage = opts?.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
    const [all, setAll] = (0, react_1.useState)([]);
    const [enabled, setEnabled] = (0, react_1.useState)(false);
    const [reason, setReason] = (0, react_1.useState)(null);
    const [limit, setLimit] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => { channelRef.current = channel; }, [channel]);
    // What this connection last told the server it had read. The de-dupe that
    // keeps a fast thread from costing one frame per message.
    const sentRef = (0, react_1.useRef)('');
    const lastSendAtRef = (0, react_1.useRef)(0);
    const pendingRef = (0, react_1.useRef)(null);
    const enabledRef = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => { enabledRef.current = enabled; }, [enabled]);
    const refresh = (0, react_1.useCallback)(() => {
        if (!channelRef.current)
            return;
        send({ service: 'chat', action: 'receipts', channel: channelRef.current });
    }, [send]);
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.type !== 'chat' || msg.channel !== channelRef.current)
                return;
            const raw = msg;
            if (msg.action === 'receipts') {
                // Full state — replace.
                const list = Array.isArray(raw.receipts) ? raw.receipts : [];
                setAll(list.map(asReceipt).filter(Boolean));
                setEnabled(raw.enabled === true);
                setReason(raw.enabled === true ? null : asReason(raw.reason));
                setLimit(typeof raw.limit === 'number' ? raw.limit : null);
                setLoading(false);
                return;
            }
            if (msg.action === 'readReceipt') {
                // One cursor moved — merge. The server only broadcasts a cursor that
                // actually advanced, so last-write-wins is correct here.
                const entry = asReceipt(raw);
                if (!entry)
                    return;
                setAll((prev) => {
                    const without = prev.filter((r) => r.userId !== entry.userId);
                    return [entry, ...without].sort((a, b) => (a.readAt < b.readAt ? 1 : a.readAt > b.readAt ? -1 : 0));
                });
                // Our own echo carries the value the server ACCEPTED (clamped to
                // now, never backwards). Trust it over what we believed we sent.
                if (opts?.currentUserId && entry.userId === opts.currentUserId) {
                    if (!sentRef.current || isBefore(sentRef.current, entry.readAt))
                        sentRef.current = entry.readAt;
                }
                return;
            }
            if (msg.action === 'removed') {
                // This connection was removed from the channel: it may not see who
                // is reading it any more.
                setAll([]);
                setEnabled(false);
                return;
            }
        });
        return unsubscribe;
    }, [onMessage, opts?.currentUserId]);
    // Ask for the roster on mount / channel change. Deliberately NOT pushed
    // by the server on join: a client that does not render receipts should
    // not pay a frame for them.
    (0, react_1.useEffect)(() => {
        setAll([]);
        setEnabled(false);
        setReason(null);
        setLimit(null);
        setLoading(true);
        sentRef.current = '';
        lastSendAtRef.current = 0;
        refresh();
        return () => {
            if (pendingRef.current) {
                clearTimeout(pendingRef.current);
                pendingRef.current = null;
            }
        };
        // sessionEpoch: the reply to this only ever arrives once, on request —
        // nothing is pushed on join. Without it a reconnect leaves whatever the
        // panel held before the drop standing for the rest of the session, so a
        // membership change or a read that happened while offline is never seen.
    }, [channel, refresh, sessionEpoch]);
    const sendRead = (0, react_1.useCallback)((position) => {
        const channelNow = channelRef.current;
        if (!channelNow || !enabledRef.current)
            return;
        const at = timestampOf(position) ?? new Date().toISOString();
        // Never walk the cursor backwards, and never repeat it.
        if (sentRef.current && !isBefore(sentRef.current, at))
            return;
        const fire = () => {
            pendingRef.current = null;
            lastSendAtRef.current = Date.now();
            sentRef.current = at;
            const id = typeof position === 'object' && position && position.id ? position.id : undefined;
            send({
                service: 'chat',
                action: 'read',
                channel: channelNow,
                ...(id ? { messageId: id } : {}),
                at,
            });
        };
        const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
        const since = Date.now() - lastSendAtRef.current;
        if (since >= throttleMs) {
            fire();
            return;
        }
        // Trailing edge: the last position in a burst is the one that matters.
        if (pendingRef.current)
            clearTimeout(pendingRef.current);
        pendingRef.current = setTimeout(fire, throttleMs - since);
    }, [send, opts?.throttleMs]);
    const markRead = (0, react_1.useCallback)((upTo) => { sendRead(upTo); }, [sendRead]);
    // The automatic path: active panel + a visible document + a newest
    // message on screen. Re-runs when any of the three changes.
    const newestTimestamp = timestampOf(opts?.newestMessage ?? undefined);
    const newestId = typeof opts?.newestMessage === 'object' && opts?.newestMessage ? opts.newestMessage.id : undefined;
    (0, react_1.useEffect)(() => {
        if (!enabled || !opts?.active || !newestTimestamp)
            return;
        if (!documentIsVisible())
            return;
        sendRead(newestId ? { id: newestId, timestamp: newestTimestamp } : newestTimestamp);
    }, [enabled, opts?.active, newestTimestamp, newestId, sendRead]);
    // A tab brought back to the front is a read, and no message needs to have
    // arrived for it to be one.
    (0, react_1.useEffect)(() => {
        if (typeof document === 'undefined' || !opts?.active || !newestTimestamp)
            return;
        const onVisible = () => {
            if (documentIsVisible()) {
                sendRead(newestId ? { id: newestId, timestamp: newestTimestamp } : newestTimestamp);
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [opts?.active, newestTimestamp, newestId, sendRead]);
    const receipts = (0, react_1.useMemo)(() => (opts?.currentUserId ? all.filter((r) => r.userId !== opts.currentUserId) : all), [all, opts?.currentUserId]);
    const readersOf = (0, react_1.useCallback)((message) => {
        const at = timestampOf(message);
        if (!at)
            return [];
        return receipts.filter((r) => !isBefore(r.readAt, at));
    }, [receipts]);
    const readCountOf = (0, react_1.useCallback)((message) => readersOf(message).length, [readersOf]);
    return { receipts, enabled, reason, limit, loading, markRead, readersOf, readCountOf, refresh };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function documentIsVisible() {
    // Non-browser (SSR, jsdom without the property): assume visible rather
    // than silently never sending.
    if (typeof document === 'undefined')
        return true;
    return document.visibilityState !== 'hidden';
}
function timestampOf(position) {
    if (typeof position === 'string')
        return position || undefined;
    if (position && typeof position === 'object' && typeof position.timestamp === 'string')
        return position.timestamp;
    return undefined;
}
/** ISO-8601 compare that tolerates a value that will not parse. */
function isBefore(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (Number.isFinite(x) && Number.isFinite(y))
        return x < y;
    return a < b;
}
function asReceipt(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.userId !== 'string' || !r.userId)
        return null;
    if (typeof r.readAt !== 'string' || !r.readAt)
        return null;
    return {
        userId: r.userId,
        ...(typeof r.displayName === 'string' && r.displayName ? { displayName: r.displayName } : {}),
        readAt: r.readAt,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : r.readAt,
    };
}
function asReason(raw) {
    return raw === 'disabled' || raw === 'open-channel' || raw === 'unknown-roster' || raw === 'too-many-members'
        ? raw
        : null;
}
//# sourceMappingURL=useChatReadReceipts.js.map