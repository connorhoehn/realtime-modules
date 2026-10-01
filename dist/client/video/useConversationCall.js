"use strict";
// useConversationCall — the call a conversation (a DM or a room) has, or could
// have. One instance per conversation surface.
//
// Ported from realtime-examples' app code (useHangoutMachine's phases,
// useVideoCall's platform-api session, the ring / accept / leave frames of
// HangoutOverlay + HangoutDomainProvider, and useIncomingCalls) so a second
// app gets the same call against the same gateway and platform-api without
// copying 5k lines. docs/design/conversation-call-port.md.
//
// Three layers, all owned here:
//   signalling  the gateway's `call` service (invite / accepted / declined /
//               cancelled / ended / user-status / participant-state / status).
//               Every frame this hook sends is TARGETED — at the people rung,
//               the people in the call, or yourself. An untargeted call frame
//               is broadcast to every connected client by the server, which a
//               multi-tenant host must never do.
//   session     platform-api: POST /api/video/sessions (findOrCreate on the
//               lobby) → /:id/join → participant token; /:id/end on leave.
//               `getIdToken` is called per request; nothing reads env.
//   media       useLVSHangout with the participant token (the LVSProvider
//               above supplies the base URL; the token is overridden).
//
// The lobby name is used verbatim: a tenant-prefixed `acme:dm:a:b` is the
// host's choice and nothing here rewrites it.
//
// What the host still owns: the incoming-call toast (useIncomingConversationCalls
// feeds it), recordings, captions, reactions and effects UI.
Object.defineProperty(exports, "__esModule", { value: true });
exports.callingLabel = callingLabel;
exports.useConversationCall = useConversationCall;
const react_1 = require("react");
const documentCallGateway_1 = require("./documentCallGateway");
const LVSProvider_1 = require("./LVSProvider");
const useLVSHangout_1 = require("./useLVSHangout");
const useMediaDevices_1 = require("./useMediaDevices");
const useDevicePreferences_1 = require("./useDevicePreferences");
const useIncomingConversationCalls_1 = require("./useIncomingConversationCalls");
const conversationLobby_1 = require("./conversationLobby");
const str = (v) => (typeof v === 'string' && v ? v : undefined);
const mintCallId = () => `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** "Alice", "Alice & Bob", "Alice, Bob & 2 others". */
function callingLabel(names) {
    const n = names.filter(Boolean);
    if (n.length === 0)
        return '';
    if (n.length === 1)
        return n[0];
    if (n.length === 2)
        return `${n[0]} & ${n[1]}`;
    if (n.length === 3)
        return `${n[0]}, ${n[1]} & ${n[2]}`;
    return `${n[0]}, ${n[1]} & ${n.length - 2} others`;
}
function useConversationCall(opts) {
    const gw = (0, documentCallGateway_1.useDocumentCallGateway)(opts.gateway);
    const gwRef = (0, react_1.useRef)(gw);
    gwRef.current = gw;
    const optsRef = (0, react_1.useRef)(opts);
    optsRef.current = opts;
    const { lobbyName } = opts;
    const selfIdRef = (0, react_1.useRef)(opts.self.userId);
    selfIdRef.current = opts.self.userId;
    const channel = opts.channel === undefined ? (0, conversationLobby_1.channelForLobby)(lobbyName) : opts.channel;
    const channelRef = (0, react_1.useRef)(channel);
    channelRef.current = channel;
    const fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    const fetchRef = (0, react_1.useRef)(fetchImpl);
    fetchRef.current = fetchImpl;
    const endedHoldMs = opts.endedHoldMs ?? 4_000;
    const ringTimeoutMs = opts.ringTimeoutMs ?? 60_000;
    const acceptedJoinTimeoutMs = opts.acceptedJoinTimeoutMs ?? 30_000;
    const [prefs, setPrefs] = (0, useDevicePreferences_1.useDevicePreferences)(opts.deviceStorage, opts.devices);
    const prefsRef = (0, react_1.useRef)(prefs);
    prefsRef.current = prefs;
    const deviceList = (0, useMediaDevices_1.useMediaDevices)();
    const [active, setActiveState] = (0, react_1.useState)(null);
    const activeRef = (0, react_1.useRef)(null);
    const setActive = (0, react_1.useCallback)((next) => {
        const v = typeof next === 'function' ? next(activeRef.current) : next;
        activeRef.current = v;
        setActiveState(v);
    }, []);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const [ended, setEnded] = (0, react_1.useState)(null);
    const [incoming, setIncomingState] = (0, react_1.useState)(null);
    const incomingRef = (0, react_1.useRef)(null);
    const setIncoming = (0, react_1.useCallback)((v) => { incomingRef.current = v; setIncomingState(v); }, []);
    const [discovered, setDiscovered] = (0, react_1.useState)(null);
    const discoveredRef = (0, react_1.useRef)(discovered);
    discoveredRef.current = discovered;
    const [roster, setRosterState] = (0, react_1.useState)({});
    const rosterRef = (0, react_1.useRef)(roster);
    const setRoster = (0, react_1.useCallback)((fn) => {
        const v = fn(rosterRef.current);
        if (v === rosterRef.current)
            return;
        rosterRef.current = v;
        setRosterState(v);
    }, []);
    const [accepted, setAcceptedState] = (0, react_1.useState)([]);
    const acceptedRef = (0, react_1.useRef)([]);
    const [outcomes, setOutcomes] = (0, react_1.useState)({});
    const outcomesRef = (0, react_1.useRef)(outcomes);
    outcomesRef.current = outcomes;
    const [self, setSelfState] = (0, react_1.useState)({ audioOn: true, cameraOn: true, screenSharing: false });
    const selfRef = (0, react_1.useRef)(self);
    const setSelf = (0, react_1.useCallback)((patch) => {
        selfRef.current = { ...selfRef.current, ...patch };
        setSelfState(selfRef.current);
    }, []);
    const [now, setNow] = (0, react_1.useState)(() => Date.now());
    const mountedAt = (0, react_1.useRef)(Date.now());
    // ---- transport helpers ---------------------------------------------------
    const send = (0, react_1.useCallback)((msg) => (0, documentCallGateway_1.gatewaySend)(gwRef.current, msg), []);
    const authHeaders = (0, react_1.useCallback)(async () => {
        const token = await optsRef.current.platformApi.getIdToken();
        return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    }, []);
    const lastHeaders = (0, react_1.useRef)({});
    const api = (0, react_1.useCallback)(async (path, body) => {
        const f = fetchRef.current;
        if (!f)
            throw new Error('fetch is not available');
        const headers = await authHeaders();
        lastHeaders.current = headers;
        const res = await f(`${optsRef.current.platformApi.baseUrl.replace(/\/$/, '')}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const j = json;
            const err = new Error(j.error || `HTTP ${res.status}`);
            err.status = res.status;
            if (j.code)
                err.code = j.code;
            throw err;
        }
        return json;
    }, [authHeaders]);
    /** Everyone else in (or rung into) the active call, by userId. */
    const peerIds = (0, react_1.useCallback)(() => {
        const a = activeRef.current;
        const ids = new Set();
        if (a) {
            if (a.host && a.host !== selfIdRef.current)
                ids.add(a.host);
            for (const t of a.targets)
                ids.add(t.userId);
        }
        for (const uid of Object.keys(rosterRef.current))
            ids.add(uid);
        for (const uid of acceptedRef.current)
            ids.add(uid);
        ids.delete(selfIdRef.current);
        return Array.from(ids);
    }, []);
    const eventBase = (0, react_1.useCallback)((callId) => ({
        callId,
        lobbyName: optsRef.current.lobbyName,
        channel: channelRef.current ?? null,
        peerUserIds: peerIds(),
    }), [peerIds]);
    // ---- media -----------------------------------------------------------------
    const useMedia = opts.useMedia ?? useLVSHangout_1.useLVSHangout;
    const lvsCtx = (0, LVSProvider_1.useSafeLVSContext)();
    const stageTokenRef = (0, react_1.useRef)(null);
    stageTokenRef.current = active?.stageToken ?? null;
    const getAuthToken = (0, react_1.useCallback)(() => stageTokenRef.current ?? '', []);
    const media = useMedia({
        stageToken: active?.stageToken ?? null,
        participantId: active?.participantId ?? null,
        userId: opts.self.displayName,
        ...(active ? { media: active.media } : {}),
        ...((opts.lvsBaseUrl ?? lvsCtx?.baseUrl) !== undefined ? { baseUrl: opts.lvsBaseUrl ?? lvsCtx?.baseUrl } : {}),
        getAuthToken,
    });
    const mediaRef = (0, react_1.useRef)(media);
    mediaRef.current = media;
    const remoteMedia = media.participants.filter((p) => !p.isLocal);
    const remoteCountRef = (0, react_1.useRef)(0);
    remoteCountRef.current = remoteMedia.length;
    // ---- announcements -----------------------------------------------------------
    const announceSelf = (0, react_1.useCallback)(() => {
        const a = activeRef.current;
        if (!a || !a.stageToken)
            return;
        const targets = peerIds();
        if (targets.length === 0)
            return; // never broadcast
        const o = optsRef.current;
        send({
            service: 'call',
            action: 'participant-state',
            callId: a.callId,
            lobbyName: o.lobbyName,
            callerId: o.self.userId,
            userId: o.self.userId,
            displayName: o.self.displayName,
            ...(o.self.avatarUrl ? { avatarUrl: o.self.avatarUrl } : {}),
            ...(a.participantId ? { participantId: a.participantId } : {}),
            audioOn: selfRef.current.audioOn,
            cameraOn: selfRef.current.cameraOn,
            screenSharing: selfRef.current.screenSharing,
            status: 'in-call',
            targetUserIds: targets,
        });
    }, [peerIds, send]);
    // ---- teardown ----------------------------------------------------------------
    const endPlatformSession = (0, react_1.useCallback)((a, keepalive = false) => {
        if (!a.sessionId)
            return;
        const f = fetchRef.current;
        if (!f)
            return;
        const o = optsRef.current;
        const body = JSON.stringify({ lobbyName: o.lobbyName, documentId: o.lobbyName, participantId: a.participantId, userId: o.self.userId });
        const url = `${o.platformApi.baseUrl.replace(/\/$/, '')}/api/video/sessions/${encodeURIComponent(a.sessionId)}/end`;
        if (keepalive) {
            // No awaiting headers on the way out: reuse the last ones.
            void f(url, { method: 'POST', keepalive: true, headers: lastHeaders.current, body }).catch(() => undefined);
            return;
        }
        void authHeaders().then((headers) => f(url, { method: 'POST', headers, body })).catch(() => undefined);
    }, [authHeaders]);
    /** The call is over for you: stop media, end the PA session, report, reset. */
    const teardown = (0, react_1.useCallback)((reason) => {
        const a = activeRef.current;
        if (!a)
            return;
        try {
            mediaRef.current.leave();
        }
        catch { /* idempotent */ }
        endPlatformSession(a);
        const at = Date.now();
        const durationMs = a.startedAt ? at - a.startedAt : null;
        const base = eventBase(a.callId);
        if (a.startedAt)
            optsRef.current.onCallEnded?.({ ...base, reason, durationMs });
        else if (a.role === 'caller' && reason === 'no-answer')
            optsRef.current.onCallMissed?.({ ...base, direction: 'outgoing' });
        setActive(null);
        setBusy(null);
        setError(null);
        setRoster(() => ({}));
        acceptedRef.current = [];
        setAcceptedState([]);
        setOutcomes({});
        setSelf({ screenSharing: false });
        setEnded({ at, reason, durationMs });
    }, [endPlatformSession, eventBase, setActive, setRoster, setSelf]);
    /** Tell the others (and your other tabs) you are gone, then tear down. */
    const hangUp = (0, react_1.useCallback)((reason) => {
        const a = activeRef.current;
        if (!a)
            return;
        const o = optsRef.current;
        const peers = peerIds();
        const nobodyAnswered = acceptedRef.current.length === 0 && Object.keys(rosterRef.current).length === 0 && remoteCountRef.current === 0;
        if (a.role === 'caller' && a.targets.length > 0 && nobodyAnswered) {
            // Stop their ringing: `cancelled` is "I gave up".
            send({ service: 'call', action: 'cancelled', callId: a.callId, callerId: o.self.userId, lobbyName: o.lobbyName, targetUserIds: a.targets.map((t) => t.userId) });
        }
        if (peers.length > 0) {
            send({ service: 'call', action: 'user-status', callId: a.callId, callerId: o.self.userId, userId: o.self.userId, lobbyName: o.lobbyName, status: 'left', reason: 'hung-up', targetUserIds: peers });
        }
        // Participant-grain cleanup on the server (it drops only this client);
        // targeted at yourself so it never reaches the peers.
        send({ service: 'call', action: 'ended', callId: a.callId, callerId: o.self.userId, lobbyName: o.lobbyName, targetUserIds: [o.self.userId] });
        teardown(reason);
    }, [peerIds, send, teardown]);
    // ---- joining -------------------------------------------------------------------
    const enter = (0, react_1.useCallback)(async (a) => {
        const o = optsRef.current;
        setActive({ ...a, sessionId: null, stageToken: null, participantId: null });
        setBusy(a.role === 'caller' ? 'creating' : 'joining');
        setError(null);
        setEnded(null);
        try {
            const recording = o.recordingProfile
                ? { recordingConfiguration: { enabled: o.recordingProfile !== 'none', recordingProfile: o.recordingProfile } }
                : {};
            const created = await api('/api/video/sessions', {
                lobbyName: o.lobbyName,
                documentId: o.lobbyName, // platform-api's back-compat alias
                displayName: o.self.displayName,
                findOrCreate: true,
                ...recording,
            });
            const sessionId = str(created.sessionId);
            if (!sessionId)
                throw new Error('No session id from the server');
            if (activeRef.current?.callId !== a.callId)
                return false; // hung up meanwhile
            setActive((cur) => (cur && cur.callId === a.callId ? { ...cur, sessionId } : cur));
            const joined = await api(`/api/video/sessions/${encodeURIComponent(sessionId)}/join`, {
                lobbyName: o.lobbyName,
                documentId: o.lobbyName,
                displayName: o.self.displayName,
            });
            if (activeRef.current?.callId !== a.callId) {
                endPlatformSession({ ...a, sessionId, participantId: str(joined.participantId) ?? null });
                return false;
            }
            setActive((cur) => (cur && cur.callId === a.callId
                ? { ...cur, sessionId, stageToken: str(joined.token) ?? null, participantId: str(joined.participantId) ?? null }
                : cur));
            setBusy(null);
            return true;
        }
        catch (err) {
            const e = err;
            const gone = e.status === 404 || e.status === 410;
            setError({
                message: gone ? 'This call has ended.' : (e.message || 'Could not join the call'),
                ...(e.status !== undefined ? { status: e.status } : {}),
                ...(e.code ? { code: e.code } : {}),
            });
            setBusy(null);
            return false;
        }
    }, [api, endPlatformSession, setActive]);
    const joinMedia = (0, react_1.useCallback)((audioOnly) => (0, useDevicePreferences_1.deviceConstraints)(prefsRef.current, { video: !audioOnly }), []);
    const start = (0, react_1.useCallback)(async (targets, o2) => {
        if (activeRef.current)
            return;
        const o = optsRef.current;
        const audioOnly = o2?.audioOnly === true;
        const ring = targets
            .filter((t) => t.userId && t.userId !== o.self.userId)
            .map((t) => ({ userId: t.userId, displayName: t.displayName || t.userId }));
        const callId = mintCallId();
        setSelf({ audioOn: true, cameraOn: !audioOnly, screenSharing: false });
        setOutcomes({});
        const ok = await enter({
            callId, role: 'caller', host: o.self.userId, audioOnly, targets: ring,
            sessionId: null, stageToken: null, participantId: null, startedAt: null, media: joinMedia(audioOnly),
        });
        if (!ok || ring.length === 0)
            return;
        // Ring while media connects, not after: the callee's phone should not wait on our WHIP.
        send({
            service: 'call',
            action: 'invite',
            callId,
            lobbyName: o.lobbyName,
            callerId: o.self.userId,
            callerName: o.self.displayName,
            targetUserIds: ring.map((t) => t.userId),
            ...(audioOnly ? { audioOnly: true } : {}),
            ...(channelRef.current ? { channel: channelRef.current } : {}),
        });
    }, [enter, joinMedia, send, setSelf]);
    const accept = (0, react_1.useCallback)(async (ringArg) => {
        const ring = ringArg ?? incomingRef.current;
        if (!ring)
            return;
        const o = optsRef.current;
        if (activeRef.current?.callId === ring.callId)
            return;
        if (activeRef.current)
            hangUp('switched');
        setIncoming(null);
        (0, useIncomingConversationCalls_1.announceRingSettled)({ callId: ring.callId, how: 'accepted' });
        send({
            service: 'call',
            action: 'accepted',
            callId: ring.callId,
            callerId: o.self.userId,
            userId: o.self.userId,
            displayName: o.self.displayName,
            targetUserIds: [ring.callerId],
            lobbyName: ring.lobbyName || o.lobbyName,
        });
        setSelf({ audioOn: true, cameraOn: !ring.audioOnly, screenSharing: false });
        // The caller is in the call they rang you into.
        setRoster((r) => ({ ...r, [ring.callerId]: { ...(r[ring.callerId] ?? {}), displayName: ring.callerName, status: 'in-call' } }));
        const startedAt = Date.now();
        const ok = await enter({
            callId: ring.callId, role: 'joiner', host: ring.callerId, audioOnly: ring.audioOnly, targets: [],
            sessionId: null, stageToken: null, participantId: null, startedAt, media: joinMedia(ring.audioOnly),
        });
        if (ok)
            optsRef.current.onCallStarted?.({ ...eventBase(ring.callId), startedAt });
    }, [enter, eventBase, hangUp, joinMedia, send, setIncoming, setRoster, setSelf]);
    const decline = (0, react_1.useCallback)((reason) => {
        const ring = incomingRef.current;
        if (!ring)
            return;
        setIncoming(null);
        (0, useIncomingConversationCalls_1.announceRingSettled)({ callId: ring.callId, how: 'declined' });
        if (!ring.targeted)
            return;
        send({
            service: 'call',
            action: 'declined',
            callId: ring.callId,
            targetUserIds: [ring.callerId],
            callerId: optsRef.current.self.userId,
            lobbyName: ring.lobbyName || optsRef.current.lobbyName,
            ...(reason ? { reason } : {}),
        });
    }, [send, setIncoming]);
    const leave = (0, react_1.useCallback)(async () => {
        if (!activeRef.current) {
            setEnded(null);
            return;
        }
        hangUp('left');
    }, [hangUp]);
    const rejoin = (0, react_1.useCallback)(async () => {
        const a = activeRef.current;
        if (a) {
            // Lost the call: a fresh session in the same call.
            try {
                mediaRef.current.leave();
            }
            catch { /* */ }
            await enter({ ...a, sessionId: null, stageToken: null, participantId: null });
            return;
        }
        const d = discoveredRef.current;
        if (!d)
            return;
        const o = optsRef.current;
        const others = d.userIds.filter((u) => u !== o.self.userId);
        setSelf({ audioOn: true, cameraOn: true, screenSharing: false });
        setRoster(() => Object.fromEntries(others.map((u) => [u, { status: 'in-call' }])));
        const startedAt = Date.now();
        // Registers you with the call on the server (an accept of the live call).
        if (others.length > 0) {
            send({ service: 'call', action: 'accepted', callId: d.callId, callerId: o.self.userId, userId: o.self.userId, displayName: o.self.displayName, targetUserIds: others, lobbyName: o.lobbyName });
        }
        const ok = await enter({
            callId: d.callId, role: 'joiner', host: others[0] ?? '', audioOnly: false, targets: [],
            sessionId: null, stageToken: null, participantId: null, startedAt, media: joinMedia(false),
        });
        if (ok) {
            setDiscovered(null);
            optsRef.current.onCallStarted?.({ ...eventBase(d.callId), startedAt });
        }
    }, [enter, eventBase, joinMedia, send, setRoster, setSelf]);
    // ---- self controls -----------------------------------------------------------------
    const cameraPublished = (0, react_1.useRef)(false);
    const toggleMic = (0, react_1.useCallback)(() => {
        const on = !selfRef.current.audioOn;
        try {
            mediaRef.current.toggleMute(!on);
        }
        catch { /* */ }
        setSelf({ audioOn: on });
        announceSelf();
    }, [announceSelf, setSelf]);
    const toggleCamera = (0, react_1.useCallback)(() => {
        const on = !selfRef.current.cameraOn;
        const m = mediaRef.current;
        const a = activeRef.current;
        // An audio-only join has no video sender: turning the camera on re-publishes.
        const p = on && a?.audioOnly && !cameraPublished.current
            ? m.enableCamera().then(() => { cameraPublished.current = true; })
            : m.setCameraEnabled(on);
        void Promise.resolve(p).catch(() => undefined);
        setSelf({ cameraOn: on });
        announceSelf();
    }, [announceSelf, setSelf]);
    const toggleScreenShare = (0, react_1.useCallback)(() => {
        const m = mediaRef.current;
        if (selfRef.current.screenSharing) {
            try {
                m.stopScreenShare();
            }
            catch { /* */ }
            setSelf({ screenSharing: false });
            announceSelf();
            return;
        }
        void Promise.resolve(m.startScreenShare()).then(() => { setSelf({ screenSharing: true }); announceSelf(); }, () => { });
    }, [announceSelf, setSelf]);
    // The transport's own view of screen share (the browser's "Stop sharing" bar).
    (0, react_1.useEffect)(() => {
        if (!media.isScreenSharing && selfRef.current.screenSharing && active?.stageToken) {
            setSelf({ screenSharing: false });
            announceSelf();
        }
    }, [media.isScreenSharing, active?.stageToken, announceSelf, setSelf]);
    // ---- inbound frames ------------------------------------------------------------
    const markAccepted = (0, react_1.useCallback)((uid) => {
        if (acceptedRef.current.includes(uid))
            return;
        acceptedRef.current = [...acceptedRef.current, uid];
        setAcceptedState(acceptedRef.current);
        const a = activeRef.current;
        if (a && !a.startedAt) {
            const startedAt = Date.now();
            setActive({ ...a, startedAt });
            optsRef.current.onCallStarted?.({ ...eventBase(a.callId), startedAt });
        }
    }, [eventBase, setActive]);
    const onMessage = gw?.onMessage;
    (0, react_1.useEffect)(() => {
        if (!onMessage)
            return;
        return onMessage((msg) => {
            const f = (0, documentCallGateway_1.asCallFrame)(msg);
            if (!f)
                return;
            const d = f.data;
            const o = optsRef.current;
            const me = o.self.userId;
            const callId = str(d.callId);
            const a = activeRef.current;
            const inThisCall = !!a && !!callId && callId === a.callId;
            const ring = incomingRef.current;
            switch (f.action) {
                case 'active-call': {
                    if (d.lobbyName !== o.lobbyName)
                        return;
                    if (d.active === true && callId && callId !== a?.callId) {
                        const ids = Array.isArray(d.participantUserIds)
                            ? Array.from(new Set(d.participantUserIds.filter((u) => typeof u === 'string' && !!u)))
                            : [];
                        setDiscovered({ callId, userIds: ids });
                    }
                    else if (d.active !== true) {
                        setDiscovered(null);
                    }
                    return;
                }
                case 'invite': {
                    if (d.lobbyName !== o.lobbyName || d.admit === true)
                        return;
                    const parsed = (0, useIncomingConversationCalls_1.parseConversationInvite)(d, me);
                    if (!parsed || parsed.callId === a?.callId)
                        return;
                    if (ring?.callId === parsed.callId)
                        return;
                    setIncoming(parsed);
                    return;
                }
                case 'accepted': {
                    const uid = str(d.userId) ?? str(d.callerId);
                    if (!uid || !callId)
                        return;
                    if (uid === me) {
                        // Answered on another tab of mine.
                        if (ring?.callId === callId)
                            setIncoming(null);
                        return;
                    }
                    if (!inThisCall)
                        return;
                    setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), ...(str(d.displayName) ? { displayName: str(d.displayName) } : {}), status: 'in-call' } }));
                    markAccepted(uid);
                    announceSelf();
                    return;
                }
                case 'declined': {
                    const uid = str(d.callerId) ?? str(d.userId);
                    if (!inThisCall || !uid || uid === me || a.role !== 'caller')
                        return;
                    const next = { ...outcomesRef.current, [uid]: 'declined' };
                    outcomesRef.current = next;
                    setOutcomes(next);
                    const everyoneSaidNo = a.targets.length > 0 && a.targets.every((t) => next[t.userId] === 'declined');
                    if (everyoneSaidNo && acceptedRef.current.length === 0 && remoteCountRef.current === 0)
                        hangUp('declined');
                    return;
                }
                case 'cancelled':
                case 'ended': {
                    if (ring && callId === ring.callId) {
                        setIncoming(null);
                        if (f.action === 'cancelled' || str(d.reason) === 'no-answer') {
                            o.onCallMissed?.({ ...eventBase(ring.callId), peerUserIds: [ring.callerId], direction: 'incoming' });
                        }
                        return;
                    }
                    if (!a || f.action === 'cancelled')
                        return;
                    const reason = str(d.reason);
                    // Our own hang-up echoing back from another tab carries no reason.
                    if (str(d.callerId) === me && !reason)
                        return;
                    const lobbyMatch = d.lobbyName === o.lobbyName;
                    const twoParty = peerIds().length <= 1;
                    // A server-synthetic end (it has a reason) of a two-party call may
                    // name the lobby only; a stale one right after mount is the dying
                    // broadcast of the previous call in the same DM.
                    const lobbyOnly = !inThisCall && lobbyMatch && !!reason && twoParty && Date.now() - mountedAt.current > 2000;
                    if (!inThisCall && !lobbyOnly)
                        return;
                    teardown(reason ?? 'ended');
                    return;
                }
                case 'user-status': {
                    const uid = str(d.userId) ?? str(d.callerId);
                    if (!a || !uid || uid === me)
                        return;
                    if (!inThisCall && !(d.lobbyName === o.lobbyName && !callId))
                        return;
                    const status = str(d.status);
                    if (status === 'busy') {
                        const next = { ...outcomesRef.current, [uid]: 'busy' };
                        outcomesRef.current = next;
                        setOutcomes(next);
                        return;
                    }
                    // A `left` that carries `rejoinGraceMs` is the server saying their
                    // socket dropped and it is holding the seat: they are reconnecting,
                    // not gone. Tearing down on it ended every two-party call at the
                    // first socket blip on the side that stayed; if they do not come
                    // back the server ends the call (`ended`, rejoin-grace-expired).
                    const graceHeld = status === 'left' && typeof d.rejoinGraceMs === 'number' && d.rejoinGraceMs > 0;
                    if (status === 'reconnecting' || graceHeld || (status === 'left' && str(d.reason) === 'unload')) {
                        setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), status: 'reconnecting' } }));
                        return;
                    }
                    if (status === 'left') {
                        const hadPeer = !!rosterRef.current[uid] || acceptedRef.current.includes(uid);
                        setRoster((r) => {
                            if (!r[uid])
                                return r;
                            const next = { ...r };
                            delete next[uid];
                            return next;
                        });
                        acceptedRef.current = acceptedRef.current.filter((u) => u !== uid);
                        setAcceptedState(acceptedRef.current);
                        // The last other person hung up: a call with only you on it is over.
                        const othersLeft = Object.keys(rosterRef.current).length;
                        if (hadPeer && othersLeft === 0 && activeRef.current?.startedAt)
                            teardown('peer-left');
                        return;
                    }
                    if (status === 'in-call' || d.inCall === true) {
                        setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), status: 'in-call' } }));
                    }
                    return;
                }
                case 'participant-state': {
                    const uid = str(d.userId) ?? str(d.callerId);
                    if (!a || !uid || uid === me || !inThisCall)
                        return;
                    if (str(d.status) === 'left')
                        return;
                    const wasAbsent = !rosterRef.current[uid];
                    setRoster((r) => {
                        const prev = r[uid] ?? { status: 'in-call' };
                        const next = { ...prev, status: str(d.status) === 'reconnecting' ? 'reconnecting' : 'in-call' };
                        if (str(d.displayName))
                            next.displayName = str(d.displayName);
                        if (str(d.avatarUrl))
                            next.avatarUrl = str(d.avatarUrl);
                        if (str(d.participantId))
                            next.participantId = str(d.participantId);
                        if (typeof d.audioOn === 'boolean')
                            next.audioOn = d.audioOn;
                        if (typeof d.cameraOn === 'boolean')
                            next.cameraOn = d.cameraOn;
                        if (typeof d.screenSharing === 'boolean')
                            next.screenSharing = d.screenSharing;
                        return { ...r, [uid]: next };
                    });
                    if (a.role === 'caller')
                        markAccepted(uid);
                    // A newcomer does not know our state yet.
                    if (wasAbsent)
                        announceSelf();
                    return;
                }
                default:
            }
        });
    }, [onMessage, announceSelf, eventBase, hangUp, markAccepted, peerIds, setIncoming, setRoster, teardown]);
    // Rings answered by another hook in this page (the app-wide toast).
    (0, react_1.useEffect)(() => (0, useIncomingConversationCalls_1.onRingSettled)(({ callId }) => {
        if (incomingRef.current?.callId === callId)
            setIncoming(null);
    }), [setIncoming]);
    // ---- discovery + reconnect -------------------------------------------------
    const discover = opts.discover !== false;
    (0, react_1.useEffect)(() => {
        setDiscovered(null);
        setIncoming(null);
        mountedAt.current = Date.now();
        if (discover)
            send({ service: 'call', action: 'status', lobbyName });
    }, [lobbyName, discover, send, setIncoming]);
    const epoch = gw?.sessionEpoch;
    const connectionState = gw?.connectionState;
    const lastEpoch = (0, react_1.useRef)(epoch);
    const wasConnected = (0, react_1.useRef)(connectionState === undefined || connectionState === 'connected');
    (0, react_1.useEffect)(() => {
        const isConnected = connectionState === undefined || connectionState === 'connected';
        const epochBumped = epoch !== undefined && lastEpoch.current !== undefined && epoch !== lastEpoch.current;
        const cameBack = isConnected && !wasConnected.current;
        lastEpoch.current = epoch;
        wasConnected.current = isConnected;
        if (!(epochBumped || cameBack))
            return;
        if (discover)
            send({ service: 'call', action: 'status', lobbyName: optsRef.current.lobbyName });
        announceSelf();
    }, [epoch, connectionState, discover, send, announceSelf]);
    // ---- media joined: say so, apply the join state -----------------------------------
    const mediaUp = !!active?.stageToken && media.isJoined;
    (0, react_1.useEffect)(() => {
        if (!mediaUp)
            return;
        cameraPublished.current = !activeRef.current?.audioOnly;
        if (!selfRef.current.audioOn) {
            try {
                mediaRef.current.toggleMute(true);
            }
            catch { /* */ }
        }
        announceSelf();
    }, [mediaUp, announceSelf]);
    // A remote tile arriving is an answer too (a callee who skipped `accepted`).
    (0, react_1.useEffect)(() => {
        const a = activeRef.current;
        if (!a || a.role !== 'caller' || a.startedAt || remoteMedia.length === 0)
            return;
        const who = a.targets[0]?.userId;
        if (who)
            markAccepted(who);
    }, [remoteMedia.length, markAccepted]);
    // ---- ring timeouts ------------------------------------------------------------
    const ringing = !!active && active.role === 'caller' && active.targets.length > 0 && remoteMedia.length === 0;
    const anyAccepted = accepted.length > 0;
    const hasRoster = Object.keys(roster).some((u) => roster[u].participantId);
    (0, react_1.useEffect)(() => {
        if (!ringing || !active?.stageToken || hasRoster)
            return;
        const t = setTimeout(() => hangUp('no-answer'), anyAccepted ? acceptedJoinTimeoutMs : ringTimeoutMs);
        return () => clearTimeout(t);
    }, [ringing, active?.stageToken, hasRoster, anyAccepted, acceptedJoinTimeoutMs, ringTimeoutMs, hangUp]);
    // ---- clocks ---------------------------------------------------------------
    const startedAt = active?.startedAt ?? null;
    (0, react_1.useEffect)(() => {
        if (!startedAt)
            return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [startedAt]);
    (0, react_1.useEffect)(() => {
        if (!ended)
            return;
        const t = setTimeout(() => setEnded(null), endedHoldMs);
        return () => clearTimeout(t);
    }, [ended, endedHoldMs]);
    // ---- leaving the page ---------------------------------------------------------
    (0, react_1.useEffect)(() => {
        if (typeof window === 'undefined')
            return;
        const onUnload = () => {
            const a = activeRef.current;
            if (!a)
                return;
            const o = optsRef.current;
            const peers = peerIds();
            // 'unload', not 'hung-up': they may be refreshing, so the others show
            // reconnecting and the server's rejoin grace decides.
            if (peers.length > 0) {
                (0, documentCallGateway_1.gatewaySend)(gwRef.current, { service: 'call', action: 'user-status', callId: a.callId, callerId: o.self.userId, userId: o.self.userId, lobbyName: o.lobbyName, status: 'left', reason: 'unload', targetUserIds: peers });
            }
            endPlatformSession(a, true);
        };
        window.addEventListener('beforeunload', onUnload);
        window.addEventListener('pagehide', onUnload);
        return () => {
            window.removeEventListener('beforeunload', onUnload);
            window.removeEventListener('pagehide', onUnload);
        };
    }, [peerIds, endPlatformSession]);
    // Unmounting the surface hangs up: mount the hook where the call should live.
    const hangUpRef = (0, react_1.useRef)(hangUp);
    hangUpRef.current = hangUp;
    (0, react_1.useEffect)(() => () => { if (activeRef.current)
        hangUpRef.current('left'); }, []);
    // ---- derived -----------------------------------------------------------------
    const gatewayDown = connectionState !== undefined && connectionState !== 'connected';
    const mediaFailed = !!active?.stageToken && (!!media.error || media.connectionState === 'failed');
    const callerRinging = ringing && accepted.length === 0 && !Object.values(roster).some((r) => r.status === 'in-call');
    let phase;
    if (error || mediaFailed)
        phase = 'failed';
    else if (active) {
        if (busy || !active.stageToken)
            phase = 'connecting';
        else if (gatewayDown || media.connectionState === 'reconnecting')
            phase = 'reconnecting';
        else if (callerRinging)
            phase = 'calling';
        else if (media.isJoined)
            phase = 'live';
        else
            phase = 'connecting';
    }
    else if (incoming)
        phase = 'ringing';
    else if (ended)
        phase = 'ended';
    else
        phase = 'idle';
    const participants = (0, react_1.useMemo)(() => {
        const o = opts;
        const out = [];
        if (active) {
            const local = media.participants.find((p) => p.isLocal);
            out.push({
                id: active.participantId ?? o.self.userId,
                userId: o.self.userId,
                displayName: o.self.displayName,
                ...(o.self.avatarUrl ? { avatarUrl: o.self.avatarUrl } : {}),
                isLocal: true,
                state: 'in-call',
                audioOn: self.audioOn,
                cameraOn: self.cameraOn,
                screenSharing: self.screenSharing,
                participantId: active.participantId,
                stream: local?.streams[0] ?? null,
                screenStream: local?.screenStream ?? null,
            });
        }
        const targetName = (uid) => active?.targets.find((t) => t.userId === uid)?.displayName;
        const byPid = new Map();
        for (const [uid, r] of Object.entries(roster))
            if (r.participantId)
                byPid.set(r.participantId, uid);
        // The SFU stamps each producer with the stage token's `sub`: when that is
        // someone this call already knows (roster, accepted, invited, discovered),
        // the tile is them — no broadcast needed. A room call rings nobody and
        // broadcasts to nobody, so this is how its tiles find their people.
        const known = new Set([...Object.keys(roster), ...accepted, ...(active?.targets ?? []).map((t) => t.userId), ...(discovered?.userIds ?? [])]);
        for (const m of remoteMedia) {
            if (!byPid.has(m.participantId) && m.appUserId && known.has(m.appUserId))
                byPid.set(m.participantId, m.appUserId);
        }
        const unmatchedMedia = remoteMedia.filter((m) => !byPid.has(m.participantId));
        const unmatchedPeople = Object.keys(roster).filter((u) => !roster[u].participantId)
            .concat(accepted.filter((u) => !roster[u]));
        // One unknown tile and one person without one: that is them.
        if (unmatchedMedia.length === 1 && unmatchedPeople.length === 1)
            byPid.set(unmatchedMedia[0].participantId, unmatchedPeople[0]);
        const seen = new Set([o.self.userId]);
        for (const m of remoteMedia) {
            const uid = byPid.get(m.participantId) ?? m.participantId;
            const r = roster[uid];
            seen.add(uid);
            out.push({
                id: m.participantId,
                userId: uid,
                displayName: r?.displayName ?? targetName(uid) ?? m.displayName ?? uid,
                ...(r?.avatarUrl ? { avatarUrl: r.avatarUrl } : {}),
                isLocal: false,
                state: r?.status ?? 'in-call',
                audioOn: r?.audioOn ?? m.hasAudio,
                cameraOn: r?.cameraOn ?? m.hasVideo,
                screenSharing: r?.screenSharing ?? !!m.screenStream,
                participantId: m.participantId,
                stream: m.streams[0] ?? null,
                screenStream: m.screenStream ?? null,
            });
        }
        const person = (uid, state, r) => ({
            id: uid,
            userId: uid,
            displayName: r?.displayName ?? targetName(uid) ?? (incoming?.callerId === uid ? incoming.callerName : uid),
            ...(r?.avatarUrl ? { avatarUrl: r.avatarUrl } : {}),
            isLocal: false,
            state,
            audioOn: r?.audioOn ?? true,
            cameraOn: r?.cameraOn ?? false,
            screenSharing: r?.screenSharing ?? false,
            participantId: r?.participantId ?? null,
            stream: null,
            screenStream: null,
        });
        // In the call by signalling, media not here yet.
        for (const [uid, r] of Object.entries(roster)) {
            if (seen.has(uid))
                continue;
            seen.add(uid);
            out.push(person(uid, r.status, r));
        }
        for (const uid of accepted) {
            if (seen.has(uid))
                continue;
            seen.add(uid);
            out.push(person(uid, 'in-call'));
        }
        if (!active && discovered) {
            for (const uid of discovered.userIds) {
                if (seen.has(uid))
                    continue;
                seen.add(uid);
                out.push(person(uid, 'in-call'));
            }
        }
        // Invitees not in the call.
        for (const t of active?.targets ?? []) {
            if (seen.has(t.userId))
                continue;
            out.push(person(t.userId, outcomes[t.userId] ?? 'ringing'));
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, media.participants, roster, accepted, outcomes, discovered, incoming, self, opts.self.userId, opts.self.displayName, opts.self.avatarUrl]);
    const participantCount = participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').length;
    const call = (0, react_1.useMemo)(() => {
        if (active) {
            return {
                callId: active.callId,
                lobbyName,
                channel: channel ?? null,
                startedAt: active.startedAt,
                host: active.host || null,
                participants,
                participantCount,
                audioOnly: active.audioOnly,
            };
        }
        if (discovered) {
            return {
                callId: discovered.callId,
                lobbyName,
                channel: channel ?? null,
                startedAt: null,
                host: null,
                participants,
                participantCount,
                audioOnly: false,
            };
        }
        return null;
    }, [active, discovered, lobbyName, channel, participants, participantCount]);
    const callingTo = phase === 'calling'
        ? callingLabel((active?.targets ?? []).filter((t) => outcomes[t.userId] !== 'declined').map((t) => t.displayName)) || null
        : null;
    const devices = (0, react_1.useMemo)(() => ({ prefs, set: setPrefs, list: deviceList }), [prefs, setPrefs, deviceList]);
    return {
        phase,
        call,
        incoming,
        error,
        ended: phase === 'ended' ? ended : null,
        callingTo,
        self,
        start,
        accept,
        decline,
        leave,
        rejoin,
        toggleMic,
        toggleCamera,
        toggleScreenShare,
        media,
        devices,
        // `now` drives the once-a-second re-render; read the clock here so a fresh
        // start never shows negative time.
        elapsedMs: startedAt ? Math.max(0, Math.max(now, Date.now()) - startedAt) : null,
        activeSpeakerId: null,
    };
}
//# sourceMappingURL=useConversationCall.js.map