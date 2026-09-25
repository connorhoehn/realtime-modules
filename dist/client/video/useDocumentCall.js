"use strict";
// useDocumentCall — a call that belongs to a document review (SPEC §5.3).
//
// One hook for the page: the durable record (platform-api video session),
// signalling (the gateway's `call` service: invite / accepted / meta /
// set-documents / present / set-title / participant-state / user-status),
// the roster those frames build, and follow-the-presenter. Media is NOT
// opened here: the hook mints the LVS stage token (`lvs`) and the consumer
// mounts `LVSHangoutSessionProvider` with it, then hands the session back
// through `media` so toggles, members and the active speaker line up. No new
// transport.
//
// What the consumer still owns: registering the call with the app's
// active-session registry (one call per browser), rendering, and routing
// (`onNavigate` is called when the person you follow presents another
// document).
Object.defineProperty(exports, "__esModule", { value: true });
exports.toDocumentCallSession = toDocumentCallSession;
exports.mergeDocumentCall = mergeDocumentCall;
exports.useDocumentCall = useDocumentCall;
const react_1 = require("react");
const documentCallGateway_1 = require("./documentCallGateway");
const FOLLOW_KEY = (callId) => `doc-call:follow:${callId}`;
const str = (v) => (typeof v === 'string' && v ? v : undefined);
function defaultFollowStorage() {
    try {
        return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    }
    catch {
        return null;
    }
}
/** A platform-api video-session row → DocumentCallSession (lenient: rows from
 *  before `kind` existed still parse, as the host document's call). */
function toDocumentCallSession(row) {
    const sessionId = str(row.sessionId);
    if (!sessionId)
        return null;
    const documentId = str(row.documentId) ?? str(row.lobbyName) ?? '';
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt
        : Date.parse(str(row.createdAt) ?? str(row.startedAt) ?? '') || 0;
    const endedRaw = row.endedAt;
    const endedAt = typeof endedRaw === 'number' ? endedRaw : (typeof endedRaw === 'string' ? Date.parse(endedRaw) || undefined : undefined);
    const rec = row.recording ?? row.recordingDecision;
    const out = {
        sessionId,
        lobbyName: str(row.lobbyName) ?? documentId,
        kind: 'document-review',
        documentId,
        title: str(row.title) ?? '',
        documentIds: Array.isArray(row.documentIds) ? row.documentIds.filter((d) => typeof d === 'string') : (documentId ? [documentId] : []),
        hostUserId: str(row.hostUserId) ?? str(row.startedBy) ?? str(row.createdBy) ?? '',
        media: row.media === 'audio' ? 'audio' : 'video',
        createdBy: str(row.createdBy) ?? str(row.startedBy) ?? '',
        createdAt,
        recordingDecision: rec && typeof rec === 'object' && typeof rec.enabled === 'boolean'
            ? { enabled: rec.enabled, reason: String(rec.reason ?? '') }
            : null,
    };
    if (endedAt)
        out.endedAt = endedAt;
    if (typeof row.participantCount === 'number')
        out.participantCount = row.participantCount;
    return out;
}
function isLive(s, row) {
    if (s.endedAt)
        return false;
    return row.status === undefined || row.status === 'active';
}
/** Session + meta → one call object. Meta (live) wins over the record. */
function mergeDocumentCall(session, meta) {
    if (!session && !meta)
        return null;
    if (session && meta && session.sessionId !== meta.callId)
        meta = null;
    const callId = meta?.callId ?? session.sessionId;
    const base = session ?? {
        sessionId: callId,
        lobbyName: meta.documentId,
        kind: 'document-review',
        documentId: meta.documentId,
        title: meta.title,
        documentIds: meta.documentIds,
        hostUserId: meta.hostUserId,
        media: meta.media,
        createdBy: meta.hostUserId,
        createdAt: meta.startedAt,
        recordingDecision: null,
    };
    const m = meta ?? {
        callId,
        documentId: base.documentId,
        title: base.title,
        documentIds: base.documentIds,
        hostUserId: base.hostUserId,
        media: base.media,
        startedAt: base.createdAt,
        presenting: null,
        invites: {},
    };
    return { ...base, ...m, title: m.title || base.title, documentIds: m.documentIds.length ? m.documentIds : base.documentIds };
}
const INVITE_ORDER = { 'in-call': 0, reconnecting: 1, ringing: 2, missed: 3, notified: 4, declined: 5, left: 6 };
function useDocumentCall(opts) {
    const gw = (0, documentCallGateway_1.useDocumentCallGateway)(opts.gateway);
    const gwRef = (0, react_1.useRef)(gw);
    gwRef.current = gw;
    const optsRef = (0, react_1.useRef)(opts);
    optsRef.current = opts;
    const { documentId, identity } = opts;
    const selfId = identity.userId;
    const fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    const fetchRef = (0, react_1.useRef)(fetchImpl);
    fetchRef.current = fetchImpl;
    const followStorage = opts.followStorage === undefined ? defaultFollowStorage() : opts.followStorage;
    const leftLingerMs = opts.leftLingerMs ?? 30_000;
    const endedHoldMs = opts.endedHoldMs ?? 10_000;
    const [session, setSession] = (0, react_1.useState)(null);
    const [meta, setMeta] = (0, react_1.useState)(null);
    // A live call on this document that we are not in (from `status` → `active-call`).
    // `participantUserIds` is what the gateway reply carries; `participantCount` only
    // as a fallback for a reply without ids. Roster frames keep the ids current.
    const [discovered, setDiscovered] = (0, react_1.useState)(null);
    const discoveredRef = (0, react_1.useRef)(discovered);
    discoveredRef.current = discovered;
    const [joinedCallId, setJoinedCallId] = (0, react_1.useState)(null);
    const joinedRef = (0, react_1.useRef)(null);
    joinedRef.current = joinedCallId;
    const [lvs, setLvs] = (0, react_1.useState)({ stageToken: null, participantId: null, sessionId: null });
    const lvsRef = (0, react_1.useRef)(lvs);
    lvsRef.current = lvs;
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const [ended, setEnded] = (0, react_1.useState)(null);
    const [self, setSelf] = (0, react_1.useState)({ audioOn: true, cameraOn: true, screenSharing: false });
    const selfRef = (0, react_1.useRef)(self);
    selfRef.current = self;
    const [roster, setRoster] = (0, react_1.useState)({});
    const rosterRef = (0, react_1.useRef)(roster);
    rosterRef.current = roster;
    const [following, setFollowing] = (0, react_1.useState)(null);
    const followingRef = (0, react_1.useRef)(following);
    followingRef.current = following;
    const [moderation, setModeration] = (0, react_1.useState)(null);
    const [mutedForMe, setMutedForMeState] = (0, react_1.useState)({});
    const setMutedForMe = (0, react_1.useCallback)((userId, muted) => {
        setMutedForMeState((m) => {
            if (!!m[userId] === muted)
                return m;
            const next = { ...m };
            if (muted)
                next[userId] = true;
            else
                delete next[userId];
            return next;
        });
    }, []);
    // Set once the actions below exist; the frame handler reaches them through these.
    const leaveRef = (0, react_1.useRef)(async () => undefined);
    const muteSelfRef = (0, react_1.useRef)(() => undefined);
    const [now, setNow] = (0, react_1.useState)(() => Date.now());
    const metaRef = (0, react_1.useRef)(meta);
    metaRef.current = meta;
    const sessionRef = (0, react_1.useRef)(session);
    sessionRef.current = session;
    const authRef = (0, react_1.useRef)({});
    // Ring outcomes (declined / didn't answer) as they arrive, per call. Kept
    // apart from `meta` so an outcome that arrives before the call's meta —
    // or a call-meta read before the change but delivered after it — cannot
    // leave the row on "Ringing…". A later ring of the same person (a newer
    // invite `at`) supersedes it.
    const [outcomes, setOutcomes] = (0, react_1.useState)({});
    const call = (0, react_1.useMemo)(() => {
        const merged = mergeDocumentCall(session, meta);
        if (!merged)
            return merged;
        let invites = merged.invites;
        for (const [key, o] of Object.entries(outcomes)) {
            const [cid, uid] = key.split('|');
            if (cid !== merged.callId || !uid)
                continue;
            const cur = invites[uid];
            if (cur && (cur.state === 'accepted' || cur.state === 'removed' || cur.state === 'notified'))
                continue;
            if (cur && o.inviteAt !== undefined && cur.at > o.inviteAt)
                continue; // rung again since
            if (cur && o.inviteAt === undefined && cur.state !== 'ringing')
                continue;
            invites = { ...invites, [uid]: { ...(cur ?? { at: o.inviteAt ?? 0 }), state: o.state } };
        }
        return invites === merged.invites ? merged : { ...merged, invites };
    }, [session, meta, outcomes]);
    const callRef = (0, react_1.useRef)(call);
    callRef.current = call;
    // ---- transport helpers ---------------------------------------------
    const send = (0, react_1.useCallback)((msg) => (0, documentCallGateway_1.gatewaySend)(gwRef.current, msg), []);
    const api = (0, react_1.useCallback)(async (path, init = {}) => {
        const f = fetchRef.current;
        if (!f)
            throw new Error('fetch is not available');
        const headers = { 'Content-Type': 'application/json', ...(await optsRef.current.platformApi.getAuthHeaders()) };
        authRef.current = headers;
        const res = await f(`${optsRef.current.platformApi.baseUrl.replace(/\/$/, '')}${path}`, {
            method: init.method ?? 'GET',
            headers,
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            ...(init.keepalive ? { keepalive: true } : {}),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || `HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }, []);
    const writeActiveCall = (0, react_1.useCallback)((sessionId) => {
        optsRef.current.updateDocumentMeta?.({ activeCallSessionId: sessionId });
        send({ service: 'crdt', action: 'updateDocumentMeta', documentId: optsRef.current.documentId, meta: { activeCallSessionId: sessionId } });
    }, [send]);
    const selfStateFrame = (0, react_1.useCallback)((status = 'in-call') => {
        const c = callRef.current;
        const callId = joinedRef.current;
        if (!callId)
            return null;
        const o = optsRef.current;
        return {
            service: 'call',
            action: 'participant-state',
            callId,
            lobbyName: c?.documentId ?? o.documentId,
            callerId: o.identity.userId,
            userId: o.identity.userId,
            displayName: o.identity.displayName,
            ...(o.identity.avatarUrl ? { avatarUrl: o.identity.avatarUrl } : {}),
            ...(lvsRef.current.participantId ? { participantId: lvsRef.current.participantId } : {}),
            audioOn: selfRef.current.audioOn,
            cameraOn: selfRef.current.cameraOn,
            screenSharing: selfRef.current.screenSharing,
            status,
            // Lets the server route it to the call even if it overtakes the invite.
            kind: 'document-review',
        };
    }, []);
    const lastAnnounce = (0, react_1.useRef)(0);
    const announceSelf = (0, react_1.useCallback)((force = false) => {
        const t = Date.now();
        if (!force && t - lastAnnounce.current < 1000)
            return;
        lastAnnounce.current = t;
        const f = selfStateFrame();
        if (f)
            send(f);
    }, [selfStateFrame, send]);
    // ---- discovery -------------------------------------------------------
    //
    // Two separate things (2026-09-25, lane C): the platform-api READ of the
    // call record, and the gateway `status` QUERY. They used to be one effect
    // keyed on a refresh counter, and an `active-call` reply that did not match
    // the record called refresh() — which sent another `status`, whose reply was
    // another `active-call`: 300–1,400 `status` frames per run for a joiner,
    // enough to exhaust the gateway's per-client call budget and get their
    // `accepted` refused. Now `active-call` only triggers the read, at most one
    // in flight per call id and not again for READ_COOLDOWN_MS; `status` goes
    // out on mount / document change, reconnect, the discovery poll, and an
    // explicit refresh() by the consumer.
    const readsInFlight = (0, react_1.useRef)(new Set());
    const lastReadAt = (0, react_1.useRef)(new Map());
    const readGeneration = (0, react_1.useRef)(0);
    const readPlatformSession = (0, react_1.useCallback)(async (wantedCallId) => {
        const docId = optsRef.current.documentId;
        const key = `${docId}|${wantedCallId ?? ''}`;
        if (readsInFlight.current.has(key))
            return;
        readsInFlight.current.add(key);
        lastReadAt.current.set(key, Date.now());
        const generation = readGeneration.current;
        try {
            let found = null;
            const wanted = wantedCallId ?? optsRef.current.callId ?? joinedRef.current;
            if (wanted) {
                try {
                    const body = await api(`/api/video/sessions/${encodeURIComponent(wanted)}`);
                    const row = (body.session ?? body);
                    const s = toDocumentCallSession(row);
                    if (s && isLive(s, row))
                        found = s;
                }
                catch { /* fall back to the document listing */ }
            }
            if (!found) {
                const body = await api(`/api/video/sessions/document/${encodeURIComponent(docId)}`);
                const rows = Array.isArray(body.sessions) ? body.sessions : [];
                const live = rows
                    .map((r) => ({ r, s: toDocumentCallSession(r) }))
                    .filter((x) => !!x.s && isLive(x.s, x.r))
                    .filter((x) => x.r.kind === undefined || x.r.kind === 'document-review')
                    .sort((a, b) => b.s.createdAt - a.s.createdAt);
                found = live[0]?.s ?? null;
            }
            // Stale: the page moved to another document (or unmounted) meanwhile.
            if (generation !== readGeneration.current)
                return;
            // Never drop the record of the call we are in over a flaky read.
            if (found || !joinedRef.current)
                setSession(found);
        }
        catch { /* no PA, no record — gateway discovery still works */ }
        finally {
            readsInFlight.current.delete(key);
        }
    }, [api]);
    /** `active-call` named a call the record does not match: read it — once. */
    const READ_COOLDOWN_MS = 5_000;
    const readForActiveCall = (0, react_1.useCallback)((callId) => {
        const key = `${optsRef.current.documentId}|${callId}`;
        if (readsInFlight.current.has(key))
            return;
        const last = lastReadAt.current.get(key);
        if (last !== undefined && Date.now() - last < READ_COOLDOWN_MS)
            return;
        void readPlatformSession(callId);
    }, [readPlatformSession]);
    const sendStatus = (0, react_1.useCallback)(() => {
        send({ service: 'call', action: 'status', lobbyName: optsRef.current.documentId });
    }, [send]);
    /** Consumer-requested re-read (after a navigation, say): record + one `status`. */
    const refresh = (0, react_1.useCallback)(() => {
        void readPlatformSession(null);
        sendStatus();
    }, [readPlatformSession, sendStatus]);
    (0, react_1.useEffect)(() => {
        readGeneration.current += 1;
        readsInFlight.current.clear();
        lastReadAt.current.clear();
        void readPlatformSession(null);
        sendStatus();
        return () => { readGeneration.current += 1; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId, opts.callId]);
    // ---- keep a watched call's count live -------------------------------
    const discoveryPollMs = opts.discoveryPollMs ?? 15_000;
    const watchingCallId = !joinedCallId ? discovered?.callId ?? null : null;
    (0, react_1.useEffect)(() => {
        if (!watchingCallId || discoveryPollMs <= 0)
            return;
        const t = setInterval(() => {
            send({ service: 'call', action: 'status', lobbyName: optsRef.current.documentId });
        }, discoveryPollMs);
        return () => clearInterval(t);
    }, [watchingCallId, discoveryPollMs, send]);
    // ---- follow target (per tab) ----------------------------------------
    const callIdForFollow = joinedCallId ?? call?.callId ?? null;
    (0, react_1.useEffect)(() => {
        if (!callIdForFollow) {
            setFollowing(null);
            return;
        }
        try {
            setFollowing(followStorage?.getItem(FOLLOW_KEY(callIdForFollow)) || null);
        }
        catch {
            setFollowing(null);
        }
    }, [callIdForFollow, followStorage]);
    const follow = (0, react_1.useCallback)((userId) => {
        const callId = joinedRef.current ?? callRef.current?.callId;
        setFollowing(userId);
        if (!callId || !followStorage)
            return;
        try {
            if (userId)
                followStorage.setItem(FOLLOW_KEY(callId), userId);
            else
                followStorage.removeItem(FOLLOW_KEY(callId));
        }
        catch { /* per-tab convenience */ }
    }, [followStorage]);
    // ---- inbound frames ---------------------------------------------------
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
            const known = (id) => !!id && (id === joinedRef.current || id === callRef.current?.callId || id === sessionRef.current?.sessionId
                || id === discoveredRef.current?.callId);
            // Not in the call but watching it: keep the discovered people current.
            const trackDiscovered = (uid, present) => {
                if (!uid || joinedRef.current || !callId || discoveredRef.current?.callId !== callId)
                    return;
                setDiscovered((cur) => {
                    if (!cur || cur.callId !== callId)
                        return cur;
                    const has = cur.participantUserIds.includes(uid);
                    if (present === has)
                        return cur;
                    const ids = present ? [...cur.participantUserIds, uid] : cur.participantUserIds.filter((u) => u !== uid);
                    // Once we track ids, the reply's count no longer applies.
                    return { ...cur, participantUserIds: ids, participantCount: ids.length };
                });
            };
            if (f.action === 'active-call') {
                if (d.lobbyName !== optsRef.current.documentId)
                    return;
                if (d.active === true && callId) {
                    setDiscovered({
                        callId,
                        participantCount: typeof d.participantCount === 'number' ? d.participantCount : 0,
                        participantUserIds: Array.isArray(d.participantUserIds)
                            ? Array.from(new Set(d.participantUserIds.filter((u) => typeof u === 'string' && !!u)))
                            : [],
                    });
                    if (!sessionRef.current || sessionRef.current.sessionId !== callId)
                        readForActiveCall(callId);
                }
                else {
                    setDiscovered(null);
                }
                return;
            }
            if (f.action === 'call-meta') {
                const m = d;
                if (!callId || !(known(callId) || (Array.isArray(m.documentIds) && m.documentIds.includes(optsRef.current.documentId))))
                    return;
                setMeta({ ...m, invites: m.invites ?? {}, presenting: m.presenting ?? null });
                return;
            }
            if (!known(callId))
                return;
            if (f.action === 'participant-state' || f.action === 'user-status') {
                const uid = str(d.userId) ?? str(d.callerId);
                if (!uid || uid === optsRef.current.identity.userId)
                    return;
                const status = (str(d.status) ?? 'in-call');
                trackDiscovered(uid, status !== 'left');
                const wasAbsent = !rosterRef.current[uid] || rosterRef.current[uid].status === 'left';
                setRoster((r) => {
                    const prev = r[uid];
                    const next = {
                        clientId: prev?.clientId ?? '',
                        audioOn: typeof d.audioOn === 'boolean' ? d.audioOn : prev?.audioOn ?? true,
                        cameraOn: typeof d.cameraOn === 'boolean' ? d.cameraOn : prev?.cameraOn ?? true,
                        screenSharing: typeof d.screenSharing === 'boolean' ? d.screenSharing : prev?.screenSharing ?? false,
                        status: status === 'left' || status === 'reconnecting' ? status : 'in-call',
                        at: Date.now(),
                        ...(str(d.displayName) ?? prev?.displayName ? { displayName: str(d.displayName) ?? prev?.displayName } : {}),
                        ...(str(d.avatarUrl) ?? prev?.avatarUrl ? { avatarUrl: str(d.avatarUrl) ?? prev?.avatarUrl } : {}),
                    };
                    return { ...r, [uid]: next };
                });
                // A newcomer does not know our state yet — say it again (late join).
                if (wasAbsent && status !== 'left' && joinedRef.current)
                    announceSelf(true);
                return;
            }
            if (f.action === 'accepted') {
                trackDiscovered(str(d.userId), true);
                if (joinedRef.current)
                    announceSelf(true);
                return;
            }
            if (f.action === 'invite-expired' || f.action === 'declined') {
                const uid = str(d.userId);
                if (!uid)
                    return;
                if (uid === optsRef.current.identity.userId)
                    return; // my own ring (useIncomingDocumentCalls)
                const state = f.action === 'declined' ? 'declined' : 'missed';
                const inviteAt = typeof d.inviteAt === 'number' ? d.inviteAt : undefined;
                setOutcomes((o) => ({ ...o, [`${callId}|${uid}`]: { state, ...(inviteAt !== undefined ? { inviteAt } : {}) } }));
                return;
            }
            if (f.action === 'mute-participant' || f.action === 'remove-participant') {
                if (str(d.userId) !== optsRef.current.identity.userId)
                    return;
                const by = str(d.by) ?? '';
                if (f.action === 'mute-participant') {
                    setModeration({ kind: 'muted', by, at: Date.now() });
                    muteSelfRef.current();
                }
                else {
                    setModeration({ kind: 'removed', by, at: Date.now() });
                    void leaveRef.current('removed');
                }
                return;
            }
            if (f.action === 'ended') {
                const wasJoined = joinedRef.current === callId;
                const startedAt = metaRef.current?.startedAt ?? sessionRef.current?.createdAt ?? null;
                setMeta(null);
                setSession(null);
                setDiscovered(null);
                setRoster({});
                if (wasJoined) {
                    setJoinedCallId(null);
                    setLvs({ stageToken: null, participantId: null, sessionId: null });
                    setEnded({ at: Date.now(), durationMs: startedAt ? Date.now() - startedAt : null, reason: str(d.reason) ?? 'ended' });
                }
            }
        });
    }, [onMessage, readForActiveCall, announceSelf]);
    // ---- reconnect: re-announce on a new gateway session -----------------
    const epoch = gw?.sessionEpoch;
    const connectionState = gw?.connectionState;
    const lastEpoch = (0, react_1.useRef)(epoch);
    const wasConnected = (0, react_1.useRef)(connectionState === 'connected');
    (0, react_1.useEffect)(() => {
        const isConnected = connectionState === undefined || connectionState === 'connected';
        const epochBumped = epoch !== undefined && lastEpoch.current !== undefined && epoch !== lastEpoch.current;
        const cameBack = isConnected && !wasConnected.current;
        lastEpoch.current = epoch;
        wasConnected.current = isConnected;
        if (!(epochBumped || cameBack))
            return;
        const callId = joinedRef.current;
        const lobby = callRef.current?.documentId ?? optsRef.current.documentId;
        send({ service: 'call', action: 'status', lobbyName: lobby });
        if (!callId)
            return;
        send({ service: 'call', action: 'meta', callId });
        announceSelf(true);
    }, [epoch, connectionState, send, announceSelf]);
    // ---- clocks ------------------------------------------------------------
    const startedAt = call?.startedAt ?? null;
    (0, react_1.useEffect)(() => {
        if (!startedAt && !Object.values(roster).some((r) => r.status === 'left'))
            return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [startedAt, roster]);
    // `left` people drop out of the list after a while.
    (0, react_1.useEffect)(() => {
        const stale = Object.entries(roster).filter(([, r]) => r.status === 'left' && now - r.at > leftLingerMs);
        if (stale.length)
            setRoster((r) => {
                const next = { ...r };
                for (const [uid] of stale)
                    delete next[uid];
                return next;
            });
    }, [now, roster, leftLingerMs]);
    (0, react_1.useEffect)(() => {
        if (!ended)
            return;
        const t = setTimeout(() => setEnded(null), endedHoldMs);
        return () => clearTimeout(t);
    }, [ended, endedHoldMs]);
    // ---- follow the presenter --------------------------------------------
    const presenting = call?.presenting ?? null;
    const prevPresenting = (0, react_1.useRef)(presenting);
    (0, react_1.useEffect)(() => {
        const prev = prevPresenting.current;
        prevPresenting.current = presenting;
        if (!joinedRef.current)
            return;
        const f = followingRef.current;
        if (!f || !presenting)
            return;
        // The host took over from the person you were following: follow them.
        if (prev && prev.userId === f && presenting.userId !== f) {
            follow(presenting.userId);
        }
        else if (presenting.userId !== f) {
            return;
        }
        if (presenting.documentId !== optsRef.current.documentId)
            optsRef.current.onNavigate?.(presenting.documentId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [presenting?.userId, presenting?.documentId, presenting?.since]);
    // Starting to follow someone who is presenting elsewhere takes you there.
    (0, react_1.useEffect)(() => {
        const p = callRef.current?.presenting;
        if (!following || !joinedRef.current || !p)
            return;
        if (p.userId === following && p.documentId !== optsRef.current.documentId)
            optsRef.current.onNavigate?.(p.documentId);
    }, [following]);
    // ---- media binding -------------------------------------------------------
    const media = opts.media ?? null;
    const mediaConnected = media?.connectionState === 'connected';
    // Apply the chosen join state once the media session is up.
    (0, react_1.useEffect)(() => {
        if (!mediaConnected || !joinedCallId)
            return;
        void media?.setMicEnabled?.(selfRef.current.audioOn);
        void media?.setCameraEnabled?.(selfRef.current.cameraOn);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaConnected, joinedCallId]);
    // ---- actions ---------------------------------------------------------------
    const enterCall = (0, react_1.useCallback)(async (callId, lobbyName, m) => {
        const o = optsRef.current;
        const joined = await api(`/api/video/sessions/${encodeURIComponent(callId)}/join`, {
            method: 'POST',
            body: { lobbyName, documentId: lobbyName, displayName: o.identity.displayName },
        });
        setLvs({ stageToken: str(joined.token) ?? null, participantId: str(joined.participantId) ?? null, sessionId: callId });
        lvsRef.current = { stageToken: str(joined.token) ?? null, participantId: str(joined.participantId) ?? null, sessionId: callId };
        setSelf({ audioOn: m.micOn, cameraOn: m.cameraOn, screenSharing: false });
        selfRef.current = { audioOn: m.micOn, cameraOn: m.cameraOn, screenSharing: false };
        setJoinedCallId(callId);
        joinedRef.current = callId;
        setEnded(null);
        setModeration(null);
    }, [api]);
    const inviteFrame = (0, react_1.useCallback)((userIds, extra = {}) => {
        const c = callRef.current;
        const callId = joinedRef.current;
        if (!c || !callId)
            return null;
        const o = optsRef.current;
        const inCall = Object.values(rosterRef.current).filter((r) => r.status !== 'left').length + 1;
        return {
            service: 'call',
            action: 'invite',
            callId,
            lobbyName: c.documentId,
            targetUserIds: userIds,
            callerId: o.identity.userId,
            callerName: o.identity.displayName,
            ...(o.identity.avatarUrl ? { callerAvatarUrl: o.identity.avatarUrl } : {}),
            kind: 'document-review',
            documentId: c.documentId,
            title: c.title,
            documentIds: c.documentIds,
            ...(c.documentTitles ? { documentTitles: c.documentTitles } : {}),
            ...(extra.message ? { message: extra.message.slice(0, 280) } : {}),
            media: c.media,
            participantCount: inCall,
            participants: [
                { userId: o.identity.userId, displayName: o.identity.displayName, ...(o.identity.avatarUrl ? { avatarUrl: o.identity.avatarUrl } : {}) },
                ...Object.entries(rosterRef.current).filter(([, r]) => r.status !== 'left')
                    .map(([uid, r]) => ({ userId: uid, displayName: r.displayName ?? uid, ...(r.avatarUrl ? { avatarUrl: r.avatarUrl } : {}) })),
            ].slice(0, 8),
            ...(extra.ring === false ? { ring: false } : {}),
        };
    }, []);
    const start = (0, react_1.useCallback)(async (input) => {
        const o = optsRef.current;
        setBusy('starting');
        setError(null);
        try {
            const hostDoc = o.documentId;
            const documentIds = [hostDoc, ...input.documentIds.filter((d) => d !== hostDoc)];
            const created = await api('/api/video/sessions', {
                method: 'POST',
                body: {
                    kind: 'document-review',
                    title: input.title,
                    documentIds,
                    media: input.media,
                    findOrCreate: true,
                    lobbyName: hostDoc,
                    documentId: hostDoc,
                    displayName: o.identity.displayName,
                },
            });
            const sessionId = str(created.sessionId);
            if (!sessionId)
                throw new Error('No session id from the server');
            const now0 = Date.now();
            setSession({
                sessionId,
                lobbyName: hostDoc,
                kind: 'document-review',
                documentId: hostDoc,
                title: input.title,
                documentIds,
                hostUserId: o.identity.userId,
                media: input.media,
                createdBy: o.identity.userId,
                createdAt: now0,
                recordingDecision: created.recording && typeof created.recording === 'object'
                    ? created.recording : null,
            });
            const cameraOn = input.media === 'audio' ? false : input.cameraOn;
            await enterCall(sessionId, hostDoc, { micOn: input.micOn, cameraOn });
            // Seed meta locally so the dock renders before call-meta arrives.
            setMeta((m) => (m && m.callId === sessionId) ? m : {
                callId: sessionId, documentId: hostDoc, title: input.title, documentIds,
                ...(input.documentTitles ? { documentTitles: input.documentTitles } : {}),
                hostUserId: o.identity.userId, media: input.media, startedAt: now0, presenting: null, invites: {},
            });
            callRef.current = mergeDocumentCall(sessionRef.current ?? {
                sessionId, lobbyName: hostDoc, kind: 'document-review', documentId: hostDoc, title: input.title, documentIds,
                hostUserId: o.identity.userId, media: input.media, createdBy: o.identity.userId, createdAt: now0, recordingDecision: null,
            }, null);
            if (callRef.current && input.documentTitles)
                callRef.current.documentTitles = input.documentTitles;
            const frame = inviteFrame(input.targetUserIds.filter((u) => u !== o.identity.userId), { message: input.message, ring: input.ring });
            if (frame)
                send(frame);
            announceSelf(true);
            writeActiveCall(sessionId);
        }
        catch (err) {
            const message = err.message || 'Could not start the call';
            setError({ message, retry: () => { void start(input); } });
        }
        finally {
            setBusy(null);
        }
    }, [api, enterCall, inviteFrame, send, announceSelf, writeActiveCall]);
    const join = (0, react_1.useCallback)(async (callId, m) => {
        const o = optsRef.current;
        setBusy('joining');
        setError(null);
        try {
            const c = callRef.current && callRef.current.callId === callId ? callRef.current : null;
            const lobby = c?.documentId ?? (discovered?.callId === callId ? o.documentId : o.documentId);
            const cameraOn = c?.media === 'audio' ? false : m.cameraOn;
            await enterCall(callId, lobby, { micOn: m.micOn, cameraOn });
            const host = c?.hostUserId ?? '';
            send({
                service: 'call',
                action: 'accepted',
                callId,
                lobbyName: lobby,
                // No `callerId` here: gateways refuse a frame whose callerId is not
                // the sender's own user (anti-spoofing), and this sender is not the
                // host. The server fills the host in from the call meta.
                ...(host ? { targetUserIds: [host] } : {}),
                userId: o.identity.userId,
                displayName: o.identity.displayName,
            });
            announceSelf(true);
            send({ service: 'call', action: 'meta', callId });
            if (!c)
                void readPlatformSession(callId);
        }
        catch (err) {
            const message = err.message || 'Could not join the call';
            setError({ message, retry: () => { void join(callId, m); } });
        }
        finally {
            setBusy(null);
        }
    }, [discovered, enterCall, send, announceSelf, readPlatformSession]);
    const leaveInternal = (0, react_1.useCallback)(async (mode) => {
        const forEveryone = mode === 'everyone';
        const callId = joinedRef.current;
        if (!callId)
            return;
        const c = callRef.current;
        const o = optsRef.current;
        const lobby = c?.documentId ?? o.documentId;
        // Removed by the host: the server already took us off the call.
        if (mode !== 'removed')
            send({
                service: 'call',
                action: 'ended',
                callId,
                lobbyName: lobby,
                userId: o.identity.userId,
                ...(forEveryone ? { forEveryone: true } : {}),
            });
        const startedAt0 = c?.startedAt ?? null;
        const participantId = lvsRef.current.participantId;
        setJoinedCallId(null);
        joinedRef.current = null;
        setLvs({ stageToken: null, participantId: null, sessionId: null });
        setRoster({});
        setEnded({ at: Date.now(), durationMs: startedAt0 ? Date.now() - startedAt0 : null, reason: forEveryone ? 'ended-for-everyone' : mode });
        if (mode === 'removed') {
            setMeta(null);
            setSession(null);
        }
        let callOver = forEveryone;
        try {
            const r = await api(`/api/video/sessions/${encodeURIComponent(callId)}/end`, {
                method: 'POST',
                body: { lobbyName: lobby, documentId: lobby, participantId, userId: o.identity.userId },
            });
            if (r.ended === true)
                callOver = true;
        }
        catch { /* the stale-session reaper ends it */ }
        if (callOver) {
            writeActiveCall('');
            setSession(null);
            setMeta(null);
        }
    }, [api, send, writeActiveCall]);
    const leave = (0, react_1.useCallback)(() => leaveInternal('left'), [leaveInternal]);
    const endForEveryone = (0, react_1.useCallback)(() => leaveInternal('everyone'), [leaveInternal]);
    leaveRef.current = leaveInternal;
    const moderate = (0, react_1.useCallback)((action, userId) => {
        const callId = joinedRef.current;
        if (!callId || !userId || userId === optsRef.current.identity.userId)
            return;
        send({ service: 'call', action, callId, userId });
    }, [send]);
    const muteParticipant = (0, react_1.useCallback)((userId) => moderate('mute-participant', userId), [moderate]);
    const removeParticipant = (0, react_1.useCallback)((userId) => moderate('remove-participant', userId), [moderate]);
    const transferHost = (0, react_1.useCallback)((userId) => moderate('transfer-host', userId), [moderate]);
    // Tab close: tell PA this participant is gone (keepalive; no async headers).
    (0, react_1.useEffect)(() => {
        if (typeof window === 'undefined')
            return;
        const onUnload = () => {
            const callId = joinedRef.current;
            const f = fetchRef.current;
            if (!callId || !f)
                return;
            const lobby = callRef.current?.documentId ?? optsRef.current.documentId;
            void f(`${optsRef.current.platformApi.baseUrl.replace(/\/$/, '')}/api/video/sessions/${encodeURIComponent(callId)}/end`, {
                method: 'POST',
                keepalive: true,
                headers: authRef.current,
                body: JSON.stringify({ lobbyName: lobby, documentId: lobby, participantId: lvsRef.current.participantId, userId: optsRef.current.identity.userId }),
            }).catch(() => undefined);
        };
        window.addEventListener('beforeunload', onUnload);
        return () => window.removeEventListener('beforeunload', onUnload);
    }, []);
    const invite = (0, react_1.useCallback)((userIds, message) => {
        // Ringing someone again clears their last outcome.
        const cid = joinedRef.current;
        if (cid)
            setOutcomes((o) => {
                let next = o;
                for (const u of userIds)
                    if (next[`${cid}|${u}`]) {
                        if (next === o)
                            next = { ...o };
                        delete next[`${cid}|${u}`];
                    }
                return next;
            });
        const frame = inviteFrame(userIds.filter((u) => u && u !== optsRef.current.identity.userId), { message });
        if (frame && frame.targetUserIds.length)
            send(frame);
    }, [inviteFrame, send]);
    const ringAgain = (0, react_1.useCallback)((userId) => invite([userId]), [invite]);
    const setDocuments = (0, react_1.useCallback)(async (documentIds, documentTitles) => {
        const callId = joinedRef.current;
        const c = callRef.current;
        if (!callId || !c)
            return;
        const ids = [c.documentId, ...documentIds.filter((d) => d !== c.documentId)];
        try {
            await api(`/api/video/sessions/${encodeURIComponent(callId)}`, { method: 'PATCH', body: { documentIds: ids } });
        }
        catch { /* the live meta still updates; the record catches up on the next edit */ }
        setMeta((m) => (m ? { ...m, documentIds: ids, ...(documentTitles ? { documentTitles: { ...(m.documentTitles ?? {}), ...documentTitles } } : {}) } : m));
        send({ service: 'call', action: 'set-documents', callId, documentIds: ids, ...(documentTitles ? { documentTitles } : {}) });
    }, [api, send]);
    const setTitle = (0, react_1.useCallback)(async (title) => {
        const callId = joinedRef.current;
        const t = title.trim();
        if (!callId || !t)
            return;
        try {
            await api(`/api/video/sessions/${encodeURIComponent(callId)}`, { method: 'PATCH', body: { title: t } });
        }
        catch { /* as setDocuments */ }
        send({ service: 'call', action: 'set-title', callId, title: t });
    }, [api, send]);
    const present = (0, react_1.useCallback)((docId) => {
        const callId = joinedRef.current;
        if (!callId)
            return;
        send({ service: 'call', action: 'present', callId, documentId: docId, userId: optsRef.current.identity.userId });
    }, [send]);
    const setSelfAndAnnounce = (0, react_1.useCallback)((patch) => {
        const next = { ...selfRef.current, ...patch };
        selfRef.current = next;
        setSelf(next);
        announceSelf(true);
    }, [announceSelf]);
    const toggleMic = (0, react_1.useCallback)(() => {
        const on = !selfRef.current.audioOn;
        void optsRef.current.media?.setMicEnabled?.(on);
        setSelfAndAnnounce({ audioOn: on });
    }, [setSelfAndAnnounce]);
    muteSelfRef.current = () => {
        if (!selfRef.current.audioOn)
            return;
        void optsRef.current.media?.setMicEnabled?.(false);
        setSelfAndAnnounce({ audioOn: false });
    };
    const toggleCamera = (0, react_1.useCallback)(() => {
        const on = !selfRef.current.cameraOn;
        void optsRef.current.media?.setCameraEnabled?.(on);
        setSelfAndAnnounce({ cameraOn: on });
    }, [setSelfAndAnnounce]);
    const startScreenShare = (0, react_1.useCallback)(() => {
        void Promise.resolve(optsRef.current.media?.startScreenShare?.()).then(() => setSelfAndAnnounce({ screenSharing: true }), () => { });
    }, [setSelfAndAnnounce]);
    const stopScreenShare = (0, react_1.useCallback)(() => {
        void optsRef.current.media?.stopScreenShare?.();
        setSelfAndAnnounce({ screenSharing: false });
    }, [setSelfAndAnnounce]);
    // ---- derived state ------------------------------------------------------
    const joined = !!joinedCallId;
    const gatewayDown = connectionState !== undefined && connectionState !== 'connected';
    const phase = error ? 'error'
        : busy === 'starting' ? 'starting'
            : joined ? (gatewayDown || media?.connectionState === 'reconnecting' ? 'reconnecting'
                : media && !mediaConnected ? 'connecting' : 'active')
                : busy === 'joining' ? 'connecting'
                    : ended ? 'ended'
                        : 'idle';
    const participants = (0, react_1.useMemo)(() => {
        if (!call)
            return [];
        const o = opts;
        const byUser = new Map();
        const awareness = new Map((o.awareness?.participants ?? []).map((p) => [p.userId, p]));
        const members = new Map((media?.members ?? []).map((m) => [m.userId, m]));
        const nameOf = (uid) => rosterRef.current[uid]?.displayName ?? members.get(uid)?.displayName
            ?? awareness.get(uid)?.displayName ?? o.people?.[uid]?.displayName ?? uid;
        const avatarOf = (uid) => roster[uid]?.avatarUrl ?? awareness.get(uid)?.avatarUrl ?? o.people?.[uid]?.avatarUrl;
        const base = (uid, state) => {
            const aw = awareness.get(uid);
            const m = members.get(uid);
            const p = {
                userId: uid,
                clientId: roster[uid]?.clientId ?? '',
                displayName: nameOf(uid),
                state,
                audioOn: roster[uid]?.audioOn ?? m?.audioOn ?? true,
                cameraOn: roster[uid]?.cameraOn ?? m?.cameraOn ?? call.media !== 'audio',
                screenSharing: roster[uid]?.screenSharing ?? m?.screenSharing ?? false,
                presenting: call.presenting?.userId === uid,
                isHost: call.hostUserId === uid,
                isSelf: uid === selfId,
                mutedForMe: !!mutedForMe[uid],
            };
            const avatar = avatarOf(uid);
            if (avatar)
                p.avatarUrl = avatar;
            if (aw?.color)
                p.color = aw.color;
            if (m)
                p.media = m;
            if (aw && (aw.documentId === undefined || aw.documentId === o.documentId)) {
                p.location = { documentId: o.documentId, sectionId: aw.currentSectionId ?? null, sectionTitle: aw.currentSectionTitle ?? null };
            }
            return p;
        };
        // Invites first (ringing / missed / declined / accepted).
        for (const [uid, inv] of Object.entries(call.invites ?? {})) {
            if (uid === selfId)
                continue;
            if (inv.state === 'removed')
                continue;
            const row = inv.state === 'accepted'
                ? base(uid, roster[uid] ? roster[uid].status : 'in-call')
                : base(uid, inv.state);
            row.inviteState = inv.state;
            byUser.set(uid, row);
        }
        // Then everyone the roster has seen (joined without an invite, host, …).
        for (const [uid, r] of Object.entries(roster)) {
            const row = base(uid, r.status);
            const inv = call.invites?.[uid];
            if (inv)
                row.inviteState = inv.state;
            byUser.set(uid, row);
        }
        // The host, when they are someone else and we have not heard from them.
        if (call.hostUserId && call.hostUserId !== selfId && !byUser.has(call.hostUserId) && joined) {
            byUser.set(call.hostUserId, base(call.hostUserId, 'in-call'));
        }
        for (const uid of members.keys()) {
            if (uid !== selfId && !byUser.has(uid))
                byUser.set(uid, base(uid, 'in-call'));
        }
        const list = Array.from(byUser.values()).sort((a, b) => (INVITE_ORDER[a.state] - INVITE_ORDER[b.state]) || Number(b.isHost) - Number(a.isHost) || a.displayName.localeCompare(b.displayName));
        if (joined) {
            const me = base(selfId, 'in-call');
            me.displayName = identity.displayName;
            if (identity.avatarUrl)
                me.avatarUrl = identity.avatarUrl;
            me.audioOn = self.audioOn;
            me.cameraOn = self.cameraOn;
            me.screenSharing = self.screenSharing;
            list.unshift(me);
        }
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [call, roster, mutedForMe, media?.members, opts.awareness?.participants, opts.people, joined, self, selfId, identity.displayName, identity.avatarUrl]);
    const inCallCount = joined
        ? participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').length
        : discovered && discovered.callId === (call?.callId ?? discovered.callId)
            ? (discovered.participantUserIds.length > 0 ? discovered.participantUserIds.length : discovered.participantCount)
            : (session?.participantCount ?? 0);
    const inCallUserIds = joined
        ? participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').map((p) => p.userId)
        : (discovered?.participantUserIds ?? []);
    const followingOut = (0, react_1.useMemo)(() => {
        if (!following)
            return null;
        const p = participants.find((x) => x.userId === following);
        let location = p?.location ?? null;
        if (!location && call?.presenting?.userId === following) {
            location = { documentId: call.presenting.documentId, sectionId: null, sectionTitle: null };
        }
        return { userId: following, location };
    }, [following, participants, call?.presenting]);
    const hostDocForLink = call?.documentId ?? documentId;
    const linkCallId = joinedCallId ?? call?.callId ?? null;
    const origin = opts.linkBase ?? (typeof window !== 'undefined' && window.location ? window.location.origin : '');
    const inviteLink = linkCallId ? `${origin}/documents/${encodeURIComponent(hostDocForLink)}?call=${encodeURIComponent(linkCallId)}` : '';
    return {
        call,
        phase,
        joined,
        isHost: !!call && call.hostUserId === selfId,
        // `now` only drives the once-a-second re-render; read the clock here so a
        // fresh startedAt never shows as negative time.
        elapsedMs: startedAt ? Math.max(0, Math.max(now, Date.now()) - startedAt) : null,
        error,
        ended: phase === 'ended' ? ended : null,
        participants,
        inCallCount,
        inCallUserIds,
        activeSpeakerId: media?.activeSpeakerUserId ?? null,
        self,
        start,
        join,
        leave,
        endForEveryone,
        invite,
        ringAgain,
        setDocuments,
        setTitle,
        present,
        following: followingOut,
        follow,
        toggleMic,
        toggleCamera,
        startScreenShare,
        stopScreenShare,
        lvs,
        inviteLink,
        refresh,
        muteParticipant,
        removeParticipant,
        transferHost,
        setMutedForMe,
        moderation,
    };
}
//# sourceMappingURL=useDocumentCall.js.map