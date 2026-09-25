"use strict";
// useIncomingDocumentCalls — rings for document calls (`kind:'document-review'`
// invites), queued FIFO with the same TTL and de-dup rules as the app's
// useIncomingCalls. Other invites (DM, room) are ignored here and keep their
// own toast. SPEC §2.5 / §5.3.
//
// `accept` does not signal the server by itself: joining is
// useDocumentCall.join(), which sends `accepted` once the media session is
// minted. Wire `onAccept` to it (or call join with the returned invite).
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CLOCK_SKEW_MS = void 0;
exports.parseDocumentInvite = parseDocumentInvite;
exports.useIncomingDocumentCalls = useIncomingDocumentCalls;
const react_1 = require("react");
const documentCallGateway_1 = require("./documentCallGateway");
const str = (v) => (typeof v === 'string' && v ? v : undefined);
/** How far the client's clock may be off the server's before we stop trusting
 *  `invitedAt` for the ring's end (only used without `expiresInMs`). */
exports.MAX_CLOCK_SKEW_MS = 5_000;
/** Parse an invite frame into an IncomingDocumentCall, or null when it is not
 *  a document-call ring for this user. Exported for tests and custom queues. */
function parseDocumentInvite(data, localUserId, ttlMs, now = Date.now()) {
    if (data.kind !== 'document-review')
        return null;
    const callId = str(data.callId);
    const callerId = str(data.callerId);
    if (!callId || !callerId)
        return null;
    if (localUserId && callerId === localUserId)
        return null; // my own other tabs
    const targets = Array.isArray(data.targetUserIds) ? data.targetUserIds.filter((t) => typeof t === 'string') : [];
    // When the ring started and ends, on the SERVER's clock where it said so.
    // `expiresInMs` (time left when the server sent it) is skew-free; failing
    // that, `invitedAt` / a replay's `originalTimestamp` with the client's clock
    // skew bounded to MAX_CLOCK_SKEW_MS; failing that, arrival.
    let receivedAt = now;
    let expiresAt = null;
    const serverStart = typeof data.invitedAt === 'number' ? data.invitedAt
        : (data.replayed === true && typeof data.originalTimestamp === 'string' ? Date.parse(data.originalTimestamp) : NaN);
    if (Number.isFinite(serverStart))
        receivedAt = Math.min(now, serverStart);
    if (typeof data.expiresInMs === 'number' && Number.isFinite(data.expiresInMs)) {
        expiresAt = now + Math.max(0, Math.min(ttlMs, data.expiresInMs));
    }
    else if (Number.isFinite(serverStart)) {
        // A client clock behind the server makes serverStart look like the
        // future; one ahead makes it look older. Clamp both by the bound.
        const start = Math.min(now + exports.MAX_CLOCK_SKEW_MS, Math.max(serverStart, now - ttlMs - exports.MAX_CLOCK_SKEW_MS));
        expiresAt = Math.min(now + ttlMs, start + ttlMs);
    }
    const documentId = str(data.documentId) ?? str(data.lobbyName) ?? '';
    const documentIds = Array.isArray(data.documentIds)
        ? data.documentIds.filter((d) => typeof d === 'string')
        : (documentId ? [documentId] : []);
    const out = {
        callId,
        callerId,
        callerName: str(data.callerName) ?? callerId,
        lobbyName: str(data.lobbyName) ?? documentId,
        targeted: !!(localUserId && targets.includes(localUserId)),
        kind: 'document-review',
        documentId,
        title: str(data.title) ?? 'Call',
        documentIds,
        participantCount: typeof data.participantCount === 'number' ? data.participantCount : 1,
        media: data.media === 'audio' ? 'audio' : 'video',
        receivedAt,
        expiresAt: expiresAt ?? receivedAt + ttlMs,
    };
    const avatar = str(data.callerAvatarUrl);
    if (avatar)
        out.callerAvatarUrl = avatar;
    const message = str(data.message);
    if (message)
        out.message = message;
    if (data.documentTitles && typeof data.documentTitles === 'object')
        out.documentTitles = data.documentTitles;
    if (Array.isArray(data.participants)) {
        out.participants = data.participants
            .filter((p) => !!p && typeof p === 'object' && typeof p.userId === 'string')
            .map((p) => ({
            userId: p.userId,
            displayName: str(p.displayName) ?? p.userId,
            ...(str(p.avatarUrl) ? { avatarUrl: str(p.avatarUrl) } : {}),
        }));
    }
    return out;
}
function useIncomingDocumentCalls(opts) {
    const gw = (0, documentCallGateway_1.useDocumentCallGateway)(opts.gateway);
    const ttlMs = opts.ttlMs ?? 60_000;
    const { localUserId } = opts;
    const onMissedRef = (0, react_1.useRef)(opts.onMissed);
    onMissedRef.current = opts.onMissed;
    const onAcceptRef = (0, react_1.useRef)(opts.onAccept);
    onAcceptRef.current = opts.onAccept;
    const gwRef = (0, react_1.useRef)(gw);
    gwRef.current = gw;
    const [queue, setQueue] = (0, react_1.useState)([]);
    const queueRef = (0, react_1.useRef)(queue);
    queueRef.current = queue;
    const current = queue[0] ?? null;
    const onMessage = gw?.onMessage;
    (0, react_1.useEffect)(() => {
        if (!onMessage)
            return;
        return onMessage((msg) => {
            const f = (0, documentCallGateway_1.asCallFrame)(msg);
            if (!f)
                return;
            const callId = str(f.data.callId);
            if (!callId)
                return;
            if (f.action === 'ended' || f.action === 'cancelled' || f.action === 'accepted') {
                // Over, withdrawn, or answered on another of my tabs.
                setQueue((q) => q.filter((i) => i.callId !== callId));
                return;
            }
            if (f.action === 'invite-expired') {
                // The server's ring for me ran out: close it now, whatever my timer says.
                if (str(f.data.userId) !== localUserId)
                    return;
                const expired = queueRef.current.find((i) => i.callId === callId);
                if (!expired)
                    return;
                setQueue((q) => q.filter((i) => i.callId !== callId));
                onMissedRef.current?.(expired);
                return;
            }
            if (f.action === 'active-call') {
                // The live roster of a call that is ringing us.
                if (!Array.isArray(f.data.participantUserIds))
                    return;
                const ids = Array.from(new Set(f.data.participantUserIds.filter((u) => typeof u === 'string' && !!u)));
                setQueue((q) => (q.some((i) => i.callId === callId)
                    ? q.map((i) => (i.callId === callId ? { ...i, participantUserIds: ids, participantCount: ids.length } : i))
                    : q));
                return;
            }
            if (f.action !== 'invite')
                return;
            const inv = parseDocumentInvite(f.data, localUserId, ttlMs);
            if (!inv || inv.expiresAt <= Date.now())
                return;
            setQueue((q) => (q.some((i) => i.callId === inv.callId) ? q : [...q, inv]));
        });
    }, [onMessage, localUserId, ttlMs]);
    // The head of the queue ages out on its own timer.
    (0, react_1.useEffect)(() => {
        if (!current)
            return;
        const expiring = current;
        const t = setTimeout(() => {
            setQueue((q) => q.filter((i) => i.callId !== expiring.callId));
            onMissedRef.current?.(expiring);
        }, Math.max(0, expiring.expiresAt - Date.now()));
        return () => clearTimeout(t);
    }, [current]);
    const pop = (0, react_1.useCallback)(() => {
        const head = queueRef.current[0] ?? null;
        if (head)
            setQueue((q) => q.filter((i) => i.callId !== head.callId));
        return head;
    }, []);
    const accept = (0, react_1.useCallback)((media) => {
        const head = pop();
        if (head)
            onAcceptRef.current?.(head, media);
        return head;
    }, [pop]);
    const decline = (0, react_1.useCallback)((reason) => {
        const head = pop();
        if (!head)
            return;
        (0, documentCallGateway_1.gatewaySend)(gwRef.current, {
            service: 'call',
            action: 'declined',
            callId: head.callId,
            lobbyName: head.lobbyName,
            // Not `callerId: head.callerId` — a gateway refuses a callerId that is
            // not the sender's own user. The caller is the target.
            targetUserIds: [head.callerId],
            ...(localUserId ? { userId: localUserId } : {}),
            reason,
        });
    }, [pop, localUserId]);
    const dismiss = (0, react_1.useCallback)(() => { pop(); }, [pop]);
    return { current, queue, queueLength: queue.length, accept, decline, dismiss };
}
//# sourceMappingURL=useIncomingDocumentCalls.js.map