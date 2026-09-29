"use strict";
// useIncomingConversationCalls — every DM / room ring addressed to you, for
// the app-wide toast and the DM row badge. One per app. Ported from
// realtime-examples' useIncomingCalls: FIFO queue, de-dup on callId, a TTL
// that ages a ring out silently (as a missed call, never as a decline),
// replayed invites anchored to their original time, and knock admissions
// that join rather than ring.
//
// Document-review invites are not rings here — useIncomingDocumentCalls owns
// those.
//
// `accept(ring)` does not signal the server by itself: joining is the
// conversation's useConversationCall().accept(ring), which sends `accepted`
// once it has a session to join. Wire `onAccept` to open the conversation and
// call that.
Object.defineProperty(exports, "__esModule", { value: true });
exports.announceRingSettled = announceRingSettled;
exports.onRingSettled = onRingSettled;
exports.parseConversationInvite = parseConversationInvite;
exports.useIncomingConversationCalls = useIncomingConversationCalls;
const react_1 = require("react");
const documentCallGateway_1 = require("./documentCallGateway");
const conversationLobby_1 = require("./conversationLobby");
const settledListeners = new Set();
/** Internal: a ring was answered in this page. */
function announceRingSettled(e) {
    for (const l of Array.from(settledListeners)) {
        try {
            l(e);
        }
        catch { /* a listener never breaks another */ }
    }
}
/** Internal: hear rings answered elsewhere in this page. */
function onRingSettled(fn) {
    settledListeners.add(fn);
    return () => { settledListeners.delete(fn); };
}
const str = (v) => (typeof v === 'string' && v ? v : undefined);
/**
 * An `invite` frame's data as a ring for `selfUserId`, or null when it is not
 * one (your own invite, a document call, an admission, no callId).
 */
function parseConversationInvite(data, selfUserId) {
    const callId = str(data.callId);
    const callerId = str(data.callerId);
    if (!callId || !callerId)
        return null;
    if (data.kind === 'document-review')
        return null;
    if (data.admit === true)
        return null;
    if (selfUserId && callerId === selfUserId)
        return null;
    const targets = new Set();
    if (Array.isArray(data.targetUserIds)) {
        for (const id of data.targetUserIds)
            if (typeof id === 'string' && id)
                targets.add(id);
    }
    if (typeof data.targetUserId === 'string' && data.targetUserId)
        targets.add(data.targetUserId);
    let receivedAt = Date.now();
    // A replayed invite (the server replays live rings on reconnect) keeps its
    // original time, so the TTL reflects how long it has already been ringing.
    if (data.replayed === true && typeof data.originalTimestamp === 'string') {
        const parsed = Date.parse(data.originalTimestamp);
        if (Number.isFinite(parsed))
            receivedAt = parsed;
    }
    const lobbyName = str(data.lobbyName) ?? '';
    return {
        callId,
        lobbyName,
        channel: str(data.channel) ?? (0, conversationLobby_1.channelForLobby)(lobbyName),
        callerId,
        callerName: str(data.callerName) ?? callerId,
        targeted: !!(selfUserId && targets.has(selfUserId)),
        kind: data.knock === true ? 'knock' : 'invite',
        audioOnly: data.audioOnly === true,
        receivedAt,
    };
}
function useIncomingConversationCalls(opts) {
    const gw = (0, documentCallGateway_1.useDocumentCallGateway)(opts.gateway);
    const gwRef = (0, react_1.useRef)(gw);
    gwRef.current = gw;
    const optsRef = (0, react_1.useRef)(opts);
    optsRef.current = opts;
    const ttlMs = opts.ttlMs ?? 60_000;
    const [rings, setRings] = (0, react_1.useState)([]);
    const ringsRef = (0, react_1.useRef)(rings);
    ringsRef.current = rings;
    const drop = (0, react_1.useCallback)((callId) => setRings((q) => (q.some((r) => r.callId === callId) ? q.filter((r) => r.callId !== callId) : q)), []);
    const onMessage = gw?.onMessage;
    (0, react_1.useEffect)(() => {
        if (!onMessage)
            return;
        return onMessage((msg) => {
            const f = (0, documentCallGateway_1.asCallFrame)(msg);
            if (!f)
                return;
            const d = f.data;
            const callId = str(d.callId);
            if (!callId)
                return;
            // Cancelled / ended / answered on another tab of mine — stop ringing.
            if (f.action === 'cancelled' || f.action === 'ended' || f.action === 'accepted') {
                const ring = ringsRef.current.find((r) => r.callId === callId);
                if (!ring)
                    return;
                drop(callId);
                if (f.action === 'cancelled' || (f.action === 'ended' && str(d.reason) === 'no-answer'))
                    optsRef.current.onCancelled?.(ring);
                return;
            }
            if (f.action !== 'invite')
                return;
            const self = optsRef.current.self.userId;
            if (d.admit === true) {
                const callerId = str(d.callerId);
                if (!callerId || callerId === self)
                    return;
                optsRef.current.onAdmitted?.({ callId, lobbyName: str(d.lobbyName) ?? '', callerId, callerName: str(d.callerName) ?? callerId });
                return;
            }
            const ring = parseConversationInvite(d, self);
            if (!ring)
                return;
            setRings((q) => (q.some((r) => r.callId === ring.callId) ? q : [...q, ring]));
        });
    }, [onMessage, drop]);
    (0, react_1.useEffect)(() => onRingSettled(({ callId }) => drop(callId)), [drop]);
    // TTL: the head of the queue ages out silently — never a decline.
    const head = rings[0] ?? null;
    (0, react_1.useEffect)(() => {
        if (!head)
            return;
        const remaining = head.receivedAt + ttlMs - Date.now();
        const t = setTimeout(() => {
            drop(head.callId);
            optsRef.current.onMissed?.(head);
        }, Math.max(0, remaining));
        return () => clearTimeout(t);
    }, [head, ttlMs, drop]);
    const accept = (0, react_1.useCallback)((ring) => {
        drop(ring.callId);
        optsRef.current.onAccept?.(ring);
    }, [drop]);
    const decline = (0, react_1.useCallback)((ring, reason) => {
        drop(ring.callId);
        announceRingSettled({ callId: ring.callId, how: 'declined' });
        // Only a targeted ring has someone waiting on an answer.
        if (!ring.targeted)
            return;
        (0, documentCallGateway_1.gatewaySend)(gwRef.current, {
            service: 'call',
            action: 'declined',
            callId: ring.callId,
            targetUserIds: [ring.callerId],
            callerId: optsRef.current.self.userId,
            lobbyName: ring.lobbyName,
            ...(reason ? { reason } : {}),
        });
    }, [drop]);
    return { rings, accept, decline };
}
//# sourceMappingURL=useIncomingConversationCalls.js.map