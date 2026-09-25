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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayMessage } from '../types';
import {
  asCallFrame,
  gatewaySend,
  useDocumentCallGateway,
  type DocumentCallGateway,
} from './documentCallGateway';
import type {
  AudioVideoSettings,
  DocumentCallAwarenessParticipant,
  DocumentCallInvite,
  DocumentCallMediaMember,
  DocumentCallMeta,
  DocumentCallParticipant,
  DocumentCallSession,
} from './documentCallTypes';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The consumer's LVS session, reported back to the hook. All optional. */
export interface DocumentCallMediaBinding {
  /** e.g. useLVSHangoutShared().connectionState. */
  connectionState?: string;
  members?: DocumentCallMediaMember[];
  activeSpeakerUserId?: string | null;
  setMicEnabled?(on: boolean): void | Promise<void>;
  setCameraEnabled?(on: boolean): void | Promise<void>;
  startScreenShare?(): void | Promise<void>;
  stopScreenShare?(): void | Promise<void>;
}

export interface UseDocumentCallOptions {
  /** The document this page shows. */
  documentId: string;
  /** From useGateway() / the app socket. Defaults to the surrounding GatewayContext. */
  gateway?: DocumentCallGateway | null;
  platformApi: { baseUrl: string; getAuthHeaders(): Promise<Record<string, string>> | Record<string, string> };
  identity: { userId: string; displayName: string; avatarUrl?: string };
  /** The page's Y awareness, for follow locations. */
  awareness?: { participants: DocumentCallAwarenessParticipant[] };
  /** From useAudioVideoSettings; carried for the consumer's media layer. */
  settings?: AudioVideoSettings;
  /** A call to resolve even when this document is not its host (invite link `?call=`). */
  callId?: string | null;
  /** The consumer's LVS session (see DocumentCallMediaBinding). */
  media?: DocumentCallMediaBinding | null;
  /** The person you follow now presents `documentId` — go there. */
  onNavigate?(documentId: string): void;
  /** Y.Doc meta writer for `activeCallSessionId` (useVideoCall's contract). */
  updateDocumentMeta?(partial: { activeCallSessionId: string }): void;
  /** Names/avatars for invitees who are not in the call yet. */
  people?: Record<string, { displayName: string; avatarUrl?: string }>;
  /** Origin for `inviteLink`. Default window.location.origin. */
  linkBase?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Where the follow target lives. Default sessionStorage (per tab); null = memory. */
  followStorage?: StorageLike | null;
  /** How long a `left` person stays in the list. Default 30 s. */
  leftLingerMs?: number;
  /** How long `ended` shows before the phase returns to idle. Default 10 s. */
  endedHoldMs?: number;
}

export type DocumentCallPhase = 'idle' | 'starting' | 'connecting' | 'active' | 'reconnecting' | 'ended' | 'error';

export interface DocumentCallStartInput {
  title: string;
  media: 'video' | 'audio';
  documentIds: string[];
  /** id → title for the review list, so the invite and joiners can label rows. */
  documentTitles?: Record<string, string>;
  targetUserIds: string[];
  message?: string;
  ring: boolean;
  micOn: boolean;
  cameraOn: boolean;
}

export type DocumentCall = DocumentCallSession & DocumentCallMeta;

export interface UseDocumentCallResult {
  /** The call this document is part of, joined or not. */
  call: DocumentCall | null;
  phase: DocumentCallPhase;
  joined: boolean;
  isHost: boolean;
  elapsedMs: number | null;
  error: { message: string; retry(): void } | null;
  /** How the last call ended, while phase is 'ended'. */
  ended: { at: number; durationMs: number | null; reason: string } | null;
  participants: DocumentCallParticipant[];
  /** People in the call now (in-call + reconnecting) — "4 people". */
  inCallCount: number;
  activeSpeakerId: string | null;
  self: { audioOn: boolean; cameraOn: boolean; screenSharing: boolean };
  start(input: DocumentCallStartInput): Promise<void>;
  join(callId: string, media: { micOn: boolean; cameraOn: boolean }): Promise<void>;
  leave(): Promise<void>;
  endForEveryone(): Promise<void>;
  invite(userIds: string[], message?: string): void;
  ringAgain(userId: string): void;
  setDocuments(documentIds: string[], documentTitles?: Record<string, string>): Promise<void>;
  setTitle(title: string): Promise<void>;
  present(documentId: string | null): void;
  following: { userId: string; location: DocumentCallParticipant['location'] | null } | null;
  follow(userId: string | null): void;
  toggleMic(): void;
  toggleCamera(): void;
  startScreenShare(): void;
  stopScreenShare(): void;
  /** For LVSHangoutSessionProvider. */
  lvs: { stageToken: string | null; participantId: string | null; sessionId: string | null };
  inviteLink: string;
  /** Re-read the record and live state (after a navigation, say). */
  refresh(): void;
}

const FOLLOW_KEY = (callId: string) => `doc-call:follow:${callId}`;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function defaultFollowStorage(): StorageLike | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

/** A platform-api video-session row → DocumentCallSession (lenient: rows from
 *  before `kind` existed still parse, as the host document's call). */
export function toDocumentCallSession(row: Record<string, unknown>): DocumentCallSession | null {
  const sessionId = str(row.sessionId);
  if (!sessionId) return null;
  const documentId = str(row.documentId) ?? str(row.lobbyName) ?? '';
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt
    : Date.parse(str(row.createdAt) ?? str(row.startedAt) ?? '') || 0;
  const endedRaw = row.endedAt;
  const endedAt = typeof endedRaw === 'number' ? endedRaw : (typeof endedRaw === 'string' ? Date.parse(endedRaw) || undefined : undefined);
  const rec = row.recording ?? row.recordingDecision;
  const out: DocumentCallSession = {
    sessionId,
    lobbyName: str(row.lobbyName) ?? documentId,
    kind: 'document-review',
    documentId,
    title: str(row.title) ?? '',
    documentIds: Array.isArray(row.documentIds) ? (row.documentIds as unknown[]).filter((d): d is string => typeof d === 'string') : (documentId ? [documentId] : []),
    hostUserId: str(row.hostUserId) ?? str(row.startedBy) ?? str(row.createdBy) ?? '',
    media: row.media === 'audio' ? 'audio' : 'video',
    createdBy: str(row.createdBy) ?? str(row.startedBy) ?? '',
    createdAt,
    recordingDecision: rec && typeof rec === 'object' && typeof (rec as { enabled?: unknown }).enabled === 'boolean'
      ? { enabled: (rec as { enabled: boolean }).enabled, reason: String((rec as { reason?: unknown }).reason ?? '') }
      : null,
  };
  if (endedAt) out.endedAt = endedAt;
  if (typeof row.participantCount === 'number') out.participantCount = row.participantCount;
  return out;
}

function isLive(s: DocumentCallSession, row: Record<string, unknown>): boolean {
  if (s.endedAt) return false;
  return row.status === undefined || row.status === 'active';
}

/** Session + meta → one call object. Meta (live) wins over the record. */
export function mergeDocumentCall(session: DocumentCallSession | null, meta: DocumentCallMeta | null): DocumentCall | null {
  if (!session && !meta) return null;
  if (session && meta && session.sessionId !== meta.callId) meta = null;
  const callId = meta?.callId ?? session!.sessionId;
  const base: DocumentCallSession = session ?? {
    sessionId: callId,
    lobbyName: meta!.documentId,
    kind: 'document-review',
    documentId: meta!.documentId,
    title: meta!.title,
    documentIds: meta!.documentIds,
    hostUserId: meta!.hostUserId,
    media: meta!.media,
    createdBy: meta!.hostUserId,
    createdAt: meta!.startedAt,
    recordingDecision: null,
  };
  const m: DocumentCallMeta = meta ?? {
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

interface RosterEntry {
  clientId: string;
  displayName?: string;
  avatarUrl?: string;
  audioOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  status: 'in-call' | 'left' | 'reconnecting';
  at: number;
}

const INVITE_ORDER: Record<string, number> = { 'in-call': 0, reconnecting: 1, ringing: 2, missed: 3, declined: 4, left: 5 };

export function useDocumentCall(opts: UseDocumentCallOptions): UseDocumentCallResult {
  const gw = useDocumentCallGateway(opts.gateway);
  const gwRef = useRef(gw);
  gwRef.current = gw;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { documentId, identity } = opts;
  const selfId = identity.userId;
  const fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const followStorage = opts.followStorage === undefined ? defaultFollowStorage() : opts.followStorage;
  const leftLingerMs = opts.leftLingerMs ?? 30_000;
  const endedHoldMs = opts.endedHoldMs ?? 10_000;

  const [session, setSession] = useState<DocumentCallSession | null>(null);
  const [meta, setMeta] = useState<DocumentCallMeta | null>(null);
  const [discovered, setDiscovered] = useState<{ callId: string; participantCount: number; participantUserIds: string[] } | null>(null);
  const [joinedCallId, setJoinedCallId] = useState<string | null>(null);
  const joinedRef = useRef<string | null>(null);
  joinedRef.current = joinedCallId;
  const [lvs, setLvs] = useState<{ stageToken: string | null; participantId: string | null; sessionId: string | null }>(
    { stageToken: null, participantId: null, sessionId: null },
  );
  const lvsRef = useRef(lvs);
  lvsRef.current = lvs;
  const [busy, setBusy] = useState<'starting' | 'joining' | null>(null);
  const [error, setError] = useState<{ message: string; retry(): void } | null>(null);
  const [ended, setEnded] = useState<{ at: number; durationMs: number | null; reason: string } | null>(null);
  const [self, setSelf] = useState({ audioOn: true, cameraOn: true, screenSharing: false });
  const selfRef = useRef(self);
  selfRef.current = self;
  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const [following, setFollowing] = useState<string | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;
  const [now, setNow] = useState(() => Date.now());
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const authRef = useRef<Record<string, string>>({});

  const call = useMemo(() => mergeDocumentCall(session, meta), [session, meta]);
  const callRef = useRef(call);
  callRef.current = call;

  // ---- transport helpers ---------------------------------------------
  const send = useCallback((msg: Record<string, unknown>) => gatewaySend(gwRef.current, msg), []);

  const api = useCallback(async (path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}) => {
    const f = fetchRef.current;
    if (!f) throw new Error('fetch is not available');
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
      const err = new Error((body as { error?: string }).error || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return body as Record<string, unknown>;
  }, []);

  const writeActiveCall = useCallback((sessionId: string) => {
    optsRef.current.updateDocumentMeta?.({ activeCallSessionId: sessionId });
    send({ service: 'crdt', action: 'updateDocumentMeta', documentId: optsRef.current.documentId, meta: { activeCallSessionId: sessionId } });
  }, [send]);

  const selfStateFrame = useCallback((status: 'in-call' | 'left' = 'in-call') => {
    const c = callRef.current;
    const callId = joinedRef.current;
    if (!callId) return null;
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
    };
  }, []);

  const lastAnnounce = useRef(0);
  const announceSelf = useCallback((force = false) => {
    const t = Date.now();
    if (!force && t - lastAnnounce.current < 1000) return;
    lastAnnounce.current = t;
    const f = selfStateFrame();
    if (f) send(f);
  }, [selfStateFrame, send]);

  // ---- discovery -------------------------------------------------------
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let found: DocumentCallSession | null = null;
        const wanted = opts.callId ?? joinedRef.current;
        if (wanted) {
          try {
            const body = await api(`/api/video/sessions/${encodeURIComponent(wanted)}`);
            const row = ((body.session as Record<string, unknown>) ?? body);
            const s = toDocumentCallSession(row);
            if (s && isLive(s, row)) found = s;
          } catch { /* fall back to the document listing */ }
        }
        if (!found) {
          const body = await api(`/api/video/sessions/document/${encodeURIComponent(documentId)}`);
          const rows = Array.isArray(body.sessions) ? (body.sessions as Record<string, unknown>[]) : [];
          const live = rows
            .map((r) => ({ r, s: toDocumentCallSession(r) }))
            .filter((x): x is { r: Record<string, unknown>; s: DocumentCallSession } => !!x.s && isLive(x.s, x.r))
            .filter((x) => x.r.kind === undefined || x.r.kind === 'document-review')
            .sort((a, b) => b.s.createdAt - a.s.createdAt);
          found = live[0]?.s ?? null;
        }
        if (!cancelled) {
          // Never drop the record of the call we are in over a flaky read.
          if (found || !joinedRef.current) setSession(found);
        }
      } catch { /* no PA, no record — gateway discovery below still works */ }
    })();
    send({ service: 'call', action: 'status', lobbyName: documentId });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, opts.callId, refreshTick, api, send]);

  // ---- follow target (per tab) ----------------------------------------
  const callIdForFollow = joinedCallId ?? call?.callId ?? null;
  useEffect(() => {
    if (!callIdForFollow) { setFollowing(null); return; }
    try { setFollowing(followStorage?.getItem(FOLLOW_KEY(callIdForFollow)) || null); } catch { setFollowing(null); }
  }, [callIdForFollow, followStorage]);

  const follow = useCallback((userId: string | null) => {
    const callId = joinedRef.current ?? callRef.current?.callId;
    setFollowing(userId);
    if (!callId || !followStorage) return;
    try {
      if (userId) followStorage.setItem(FOLLOW_KEY(callId), userId);
      else followStorage.removeItem(FOLLOW_KEY(callId));
    } catch { /* per-tab convenience */ }
  }, [followStorage]);

  // ---- inbound frames ---------------------------------------------------
  const onMessage = gw?.onMessage;
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: GatewayMessage) => {
      const f = asCallFrame(msg);
      if (!f) return;
      const d = f.data;
      const callId = str(d.callId);
      const known = (id: string | undefined) =>
        !!id && (id === joinedRef.current || id === callRef.current?.callId || id === sessionRef.current?.sessionId);

      if (f.action === 'active-call') {
        if (d.lobbyName !== optsRef.current.documentId) return;
        if (d.active === true && callId) {
          setDiscovered({
            callId,
            participantCount: typeof d.participantCount === 'number' ? d.participantCount : 0,
            participantUserIds: Array.isArray(d.participantUserIds) ? (d.participantUserIds as string[]) : [],
          });
          if (!sessionRef.current || sessionRef.current.sessionId !== callId) refresh();
        } else {
          setDiscovered(null);
        }
        return;
      }
      if (f.action === 'call-meta') {
        const m = d as unknown as DocumentCallMeta;
        if (!callId || !(known(callId) || (Array.isArray(m.documentIds) && m.documentIds.includes(optsRef.current.documentId)))) return;
        setMeta({ ...m, invites: m.invites ?? {}, presenting: m.presenting ?? null });
        return;
      }
      if (!known(callId)) return;

      if (f.action === 'participant-state' || f.action === 'user-status') {
        const uid = str(d.userId) ?? str(d.callerId);
        if (!uid || uid === optsRef.current.identity.userId) return;
        const status = (str(d.status) ?? 'in-call') as RosterEntry['status'];
        const wasAbsent = !rosterRef.current[uid] || rosterRef.current[uid].status === 'left';
        setRoster((r) => {
          const prev = r[uid];
          const next: RosterEntry = {
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
        if (wasAbsent && status !== 'left' && joinedRef.current) announceSelf(true);
        return;
      }
      if (f.action === 'accepted') {
        if (joinedRef.current) announceSelf(true);
        return;
      }
      if (f.action === 'invite-expired' || f.action === 'declined') {
        const uid = str(d.userId);
        if (!uid) return;
        const state = f.action === 'declined' ? 'declined' : 'missed';
        setMeta((m) => {
          if (!m || !m.invites[uid]) return m;
          return { ...m, invites: { ...m.invites, [uid]: { ...m.invites[uid], state } as DocumentCallInvite } };
        });
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
  }, [onMessage, refresh, announceSelf]);

  // ---- reconnect: re-announce on a new gateway session -----------------
  const epoch = gw?.sessionEpoch;
  const connectionState = gw?.connectionState;
  const lastEpoch = useRef<number | undefined>(epoch);
  const wasConnected = useRef(connectionState === 'connected');
  useEffect(() => {
    const isConnected = connectionState === undefined || connectionState === 'connected';
    const epochBumped = epoch !== undefined && lastEpoch.current !== undefined && epoch !== lastEpoch.current;
    const cameBack = isConnected && !wasConnected.current;
    lastEpoch.current = epoch;
    wasConnected.current = isConnected;
    if (!(epochBumped || cameBack)) return;
    const callId = joinedRef.current;
    const lobby = callRef.current?.documentId ?? optsRef.current.documentId;
    send({ service: 'call', action: 'status', lobbyName: lobby });
    if (!callId) return;
    send({ service: 'call', action: 'meta', callId });
    announceSelf(true);
  }, [epoch, connectionState, send, announceSelf]);

  // ---- clocks ------------------------------------------------------------
  const startedAt = call?.startedAt ?? null;
  useEffect(() => {
    if (!startedAt && !Object.values(roster).some((r) => r.status === 'left')) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, roster]);

  // `left` people drop out of the list after a while.
  useEffect(() => {
    const stale = Object.entries(roster).filter(([, r]) => r.status === 'left' && now - r.at > leftLingerMs);
    if (stale.length) setRoster((r) => {
      const next = { ...r };
      for (const [uid] of stale) delete next[uid];
      return next;
    });
  }, [now, roster, leftLingerMs]);

  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setEnded(null), endedHoldMs);
    return () => clearTimeout(t);
  }, [ended, endedHoldMs]);

  // ---- follow the presenter --------------------------------------------
  const presenting = call?.presenting ?? null;
  const prevPresenting = useRef(presenting);
  useEffect(() => {
    const prev = prevPresenting.current;
    prevPresenting.current = presenting;
    if (!joinedRef.current) return;
    const f = followingRef.current;
    if (!f || !presenting) return;
    // The host took over from the person you were following: follow them.
    if (prev && prev.userId === f && presenting.userId !== f) {
      follow(presenting.userId);
    } else if (presenting.userId !== f) {
      return;
    }
    if (presenting.documentId !== optsRef.current.documentId) optsRef.current.onNavigate?.(presenting.documentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting?.userId, presenting?.documentId, presenting?.since]);

  // Starting to follow someone who is presenting elsewhere takes you there.
  useEffect(() => {
    const p = callRef.current?.presenting;
    if (!following || !joinedRef.current || !p) return;
    if (p.userId === following && p.documentId !== optsRef.current.documentId) optsRef.current.onNavigate?.(p.documentId);
  }, [following]);

  // ---- media binding -------------------------------------------------------
  const media = opts.media ?? null;
  const mediaConnected = media?.connectionState === 'connected';
  // Apply the chosen join state once the media session is up.
  useEffect(() => {
    if (!mediaConnected || !joinedCallId) return;
    void media?.setMicEnabled?.(selfRef.current.audioOn);
    void media?.setCameraEnabled?.(selfRef.current.cameraOn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaConnected, joinedCallId]);

  // ---- actions ---------------------------------------------------------------
  const enterCall = useCallback(async (callId: string, lobbyName: string, m: { micOn: boolean; cameraOn: boolean }) => {
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
  }, [api]);

  const inviteFrame = useCallback((userIds: string[], extra: { message?: string; ring?: boolean } = {}) => {
    const c = callRef.current;
    const callId = joinedRef.current;
    if (!c || !callId) return null;
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

  const start = useCallback(async (input: DocumentCallStartInput) => {
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
      if (!sessionId) throw new Error('No session id from the server');
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
          ? created.recording as { enabled: boolean; reason: string } : null,
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
      if (callRef.current && input.documentTitles) callRef.current.documentTitles = input.documentTitles;
      const frame = inviteFrame(input.targetUserIds.filter((u) => u !== o.identity.userId), { message: input.message, ring: input.ring });
      if (frame) send(frame);
      announceSelf(true);
      writeActiveCall(sessionId);
    } catch (err) {
      const message = (err as Error).message || 'Could not start the call';
      setError({ message, retry: () => { void start(input); } });
    } finally {
      setBusy(null);
    }
  }, [api, enterCall, inviteFrame, send, announceSelf, writeActiveCall]);

  const join = useCallback(async (callId: string, m: { micOn: boolean; cameraOn: boolean }) => {
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
        ...(host ? { callerId: host, targetUserIds: [host] } : {}),
        userId: o.identity.userId,
        displayName: o.identity.displayName,
      });
      announceSelf(true);
      send({ service: 'call', action: 'meta', callId });
      if (!c) refresh();
    } catch (err) {
      const message = (err as Error).message || 'Could not join the call';
      setError({ message, retry: () => { void join(callId, m); } });
    } finally {
      setBusy(null);
    }
  }, [discovered, enterCall, send, announceSelf, refresh]);

  const leaveInternal = useCallback(async (forEveryone: boolean) => {
    const callId = joinedRef.current;
    if (!callId) return;
    const c = callRef.current;
    const o = optsRef.current;
    const lobby = c?.documentId ?? o.documentId;
    send({
      service: 'call',
      action: 'ended',
      callId,
      lobbyName: lobby,
      ...(c?.hostUserId ? { callerId: c.hostUserId } : {}),
      userId: o.identity.userId,
      ...(forEveryone ? { forEveryone: true } : {}),
    });
    const startedAt0 = c?.startedAt ?? null;
    const participantId = lvsRef.current.participantId;
    setJoinedCallId(null);
    joinedRef.current = null;
    setLvs({ stageToken: null, participantId: null, sessionId: null });
    setRoster({});
    setEnded({ at: Date.now(), durationMs: startedAt0 ? Date.now() - startedAt0 : null, reason: forEveryone ? 'ended-for-everyone' : 'left' });
    let callOver = forEveryone;
    try {
      const r = await api(`/api/video/sessions/${encodeURIComponent(callId)}/end`, {
        method: 'POST',
        body: { lobbyName: lobby, documentId: lobby, participantId, userId: o.identity.userId },
      });
      if (r.ended === true) callOver = true;
    } catch { /* the stale-session reaper ends it */ }
    if (callOver) {
      writeActiveCall('');
      setSession(null);
      setMeta(null);
    }
  }, [api, send, writeActiveCall]);

  const leave = useCallback(() => leaveInternal(false), [leaveInternal]);
  const endForEveryone = useCallback(() => leaveInternal(true), [leaveInternal]);

  // Tab close: tell PA this participant is gone (keepalive; no async headers).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onUnload = () => {
      const callId = joinedRef.current;
      const f = fetchRef.current;
      if (!callId || !f) return;
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

  const invite = useCallback((userIds: string[], message?: string) => {
    const frame = inviteFrame(userIds.filter((u) => u && u !== optsRef.current.identity.userId), { message });
    if (frame && (frame.targetUserIds as string[]).length) send(frame);
  }, [inviteFrame, send]);

  const ringAgain = useCallback((userId: string) => invite([userId]), [invite]);

  const setDocuments = useCallback(async (documentIds: string[], documentTitles?: Record<string, string>) => {
    const callId = joinedRef.current;
    const c = callRef.current;
    if (!callId || !c) return;
    const ids = [c.documentId, ...documentIds.filter((d) => d !== c.documentId)];
    try { await api(`/api/video/sessions/${encodeURIComponent(callId)}`, { method: 'PATCH', body: { documentIds: ids } }); }
    catch { /* the live meta still updates; the record catches up on the next edit */ }
    setMeta((m) => (m ? { ...m, documentIds: ids, ...(documentTitles ? { documentTitles: { ...(m.documentTitles ?? {}), ...documentTitles } } : {}) } : m));
    send({ service: 'call', action: 'set-documents', callId, documentIds: ids, ...(documentTitles ? { documentTitles } : {}) });
  }, [api, send]);

  const setTitle = useCallback(async (title: string) => {
    const callId = joinedRef.current;
    const t = title.trim();
    if (!callId || !t) return;
    try { await api(`/api/video/sessions/${encodeURIComponent(callId)}`, { method: 'PATCH', body: { title: t } }); }
    catch { /* as setDocuments */ }
    send({ service: 'call', action: 'set-title', callId, title: t });
  }, [api, send]);

  const present = useCallback((docId: string | null) => {
    const callId = joinedRef.current;
    if (!callId) return;
    send({ service: 'call', action: 'present', callId, documentId: docId, userId: optsRef.current.identity.userId });
  }, [send]);

  const setSelfAndAnnounce = useCallback((patch: Partial<typeof self>) => {
    const next = { ...selfRef.current, ...patch };
    selfRef.current = next;
    setSelf(next);
    announceSelf(true);
  }, [announceSelf]);

  const toggleMic = useCallback(() => {
    const on = !selfRef.current.audioOn;
    void optsRef.current.media?.setMicEnabled?.(on);
    setSelfAndAnnounce({ audioOn: on });
  }, [setSelfAndAnnounce]);

  const toggleCamera = useCallback(() => {
    const on = !selfRef.current.cameraOn;
    void optsRef.current.media?.setCameraEnabled?.(on);
    setSelfAndAnnounce({ cameraOn: on });
  }, [setSelfAndAnnounce]);

  const startScreenShare = useCallback(() => {
    void Promise.resolve(optsRef.current.media?.startScreenShare?.()).then(
      () => setSelfAndAnnounce({ screenSharing: true }),
      () => { /* picker cancelled */ },
    );
  }, [setSelfAndAnnounce]);

  const stopScreenShare = useCallback(() => {
    void optsRef.current.media?.stopScreenShare?.();
    setSelfAndAnnounce({ screenSharing: false });
  }, [setSelfAndAnnounce]);

  // ---- derived state ------------------------------------------------------
  const joined = !!joinedCallId;
  const gatewayDown = connectionState !== undefined && connectionState !== 'connected';
  const phase: DocumentCallPhase = error ? 'error'
    : busy === 'starting' ? 'starting'
    : joined ? (gatewayDown || media?.connectionState === 'reconnecting' ? 'reconnecting'
      : media && !mediaConnected ? 'connecting' : 'active')
    : busy === 'joining' ? 'connecting'
    : ended ? 'ended'
    : 'idle';

  const participants = useMemo<DocumentCallParticipant[]>(() => {
    if (!call) return [];
    const o = opts;
    const byUser = new Map<string, DocumentCallParticipant>();
    const awareness = new Map((o.awareness?.participants ?? []).map((p) => [p.userId, p]));
    const members = new Map((media?.members ?? []).map((m) => [m.userId, m]));
    const nameOf = (uid: string) =>
      rosterRef.current[uid]?.displayName ?? (members.get(uid)?.displayName as string | undefined)
      ?? awareness.get(uid)?.displayName ?? o.people?.[uid]?.displayName ?? uid;
    const avatarOf = (uid: string) =>
      roster[uid]?.avatarUrl ?? awareness.get(uid)?.avatarUrl ?? o.people?.[uid]?.avatarUrl;
    const base = (uid: string, state: DocumentCallParticipant['state']): DocumentCallParticipant => {
      const aw = awareness.get(uid);
      const m = members.get(uid);
      const p: DocumentCallParticipant = {
        userId: uid,
        clientId: roster[uid]?.clientId ?? '',
        displayName: nameOf(uid),
        state,
        audioOn: roster[uid]?.audioOn ?? (m?.audioOn as boolean | undefined) ?? true,
        cameraOn: roster[uid]?.cameraOn ?? (m?.cameraOn as boolean | undefined) ?? call.media !== 'audio',
        screenSharing: roster[uid]?.screenSharing ?? (m?.screenSharing as boolean | undefined) ?? false,
        presenting: call.presenting?.userId === uid,
        isHost: call.hostUserId === uid,
        isSelf: uid === selfId,
      };
      const avatar = avatarOf(uid);
      if (avatar) p.avatarUrl = avatar;
      if (aw?.color) p.color = aw.color;
      if (m) p.media = m;
      if (aw && (aw.documentId === undefined || aw.documentId === o.documentId)) {
        p.location = { documentId: o.documentId, sectionId: aw.currentSectionId ?? null, sectionTitle: aw.currentSectionTitle ?? null };
      }
      return p;
    };
    // Invites first (ringing / missed / declined / accepted).
    for (const [uid, inv] of Object.entries(call.invites ?? {})) {
      if (uid === selfId) continue;
      if (inv.state === 'notified') continue;
      if (inv.state === 'accepted') {
        const r = roster[uid];
        byUser.set(uid, base(uid, r ? r.status : 'in-call'));
      } else {
        byUser.set(uid, base(uid, inv.state));
      }
    }
    // Then everyone the roster has seen (joined without an invite, host, …).
    for (const [uid, r] of Object.entries(roster)) {
      byUser.set(uid, base(uid, r.status));
    }
    // The host, when they are someone else and we have not heard from them.
    if (call.hostUserId && call.hostUserId !== selfId && !byUser.has(call.hostUserId) && joined) {
      byUser.set(call.hostUserId, base(call.hostUserId, 'in-call'));
    }
    for (const uid of members.keys()) {
      if (uid !== selfId && !byUser.has(uid)) byUser.set(uid, base(uid, 'in-call'));
    }
    const list = Array.from(byUser.values()).sort((a, b) =>
      (INVITE_ORDER[a.state] - INVITE_ORDER[b.state]) || Number(b.isHost) - Number(a.isHost) || a.displayName.localeCompare(b.displayName));
    if (joined) {
      const me = base(selfId, 'in-call');
      me.displayName = identity.displayName;
      if (identity.avatarUrl) me.avatarUrl = identity.avatarUrl;
      me.audioOn = self.audioOn;
      me.cameraOn = self.cameraOn;
      me.screenSharing = self.screenSharing;
      list.unshift(me);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, roster, media?.members, opts.awareness?.participants, opts.people, joined, self, selfId, identity.displayName, identity.avatarUrl]);

  const inCallCount = joined
    ? participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').length
    : Math.max(discovered?.participantCount ?? 0, session?.participantCount ?? 0);

  const followingOut = useMemo(() => {
    if (!following) return null;
    const p = participants.find((x) => x.userId === following);
    let location: DocumentCallParticipant['location'] | null = p?.location ?? null;
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
  };
}
