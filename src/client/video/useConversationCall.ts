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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayMessage } from '../types';
import { asCallFrame, gatewaySend, useDocumentCallGateway } from './documentCallGateway';
import { useSafeLVSContext } from './LVSProvider';
import { useLVSHangout, type UseLVSHangoutOptions, type UseLVSHangoutResult } from './useLVSHangout';
import { useMediaDevices, type UseMediaDevicesResult } from './useMediaDevices';
import { deviceConstraints, useDevicePreferences } from './useDevicePreferences';
import {
  announceRingSettled,
  onRingSettled,
  parseConversationInvite,
} from './useIncomingConversationCalls';
import { channelForLobby } from './conversationLobby';
import type {
  ConversationCall,
  ConversationCallDeclineReason,
  ConversationCallEvent,
  ConversationCallGateway,
  ConversationCallParticipant,
  ConversationCallPhase,
  DevicePreferences,
  IncomingConversationCall,
} from './conversationCallTypes';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface UseConversationCallOptions {
  /** Verbatim lobby name — never rewritten. Tenant prefixes are the caller's (`<tenant>:dm:<a>:<b>`). */
  lobbyName: string;
  /** The chat channel the call belongs to (for cards / discovery). Defaults to channelForLobby(lobbyName). */
  channel?: string | null;
  self: { userId: string; displayName: string; avatarUrl?: string };
  /** platform-api access — props, never env. `getIdToken` is called per request. */
  platformApi: { baseUrl: string; getIdToken: () => string | Promise<string> };
  /** The gateway socket the app already holds. Defaults to the surrounding GatewaySocketProvider. */
  gateway?: ConversationCallGateway | null;
  /** Initial device preferences; the hook keeps them (see `devices`). */
  devices?: DevicePreferences;
  /** Where device preferences persist. Default localStorage; null = memory only. */
  deviceStorage?: StorageLike | null;
  /** LVS base URL, when there is no <LVSProvider> above. */
  lvsBaseUrl?: string;
  /** platform-api recording profile for sessions this hook creates. Omitted = the server's default. */
  recordingProfile?: 'hangout' | 'broadcast' | 'dm' | 'none';
  /** Someone answered (caller side) or you joined (callee side). */
  onCallStarted?(e: ConversationCallEvent & { startedAt: number }): void;
  /** A call that had started is over for you. */
  onCallEnded?(e: ConversationCallEvent & { reason: string; durationMs: number | null }): void;
  /** Nobody answered your ring (`outgoing`), or a ring to you stopped unanswered (`incoming`). */
  onCallMissed?(e: ConversationCallEvent & { direction: 'outgoing' | 'incoming' }): void;
  /** How long you ring before giving up. Default 60 s. */
  ringTimeoutMs?: number;
  /** After an accept, how long to wait for their media. Default 30 s. */
  acceptedJoinTimeoutMs?: number;
  /** How long `ended` shows before the phase returns to idle. Default 4 s. */
  endedHoldMs?: number;
  /** Ask the gateway for a live call in this lobby on mount / reconnect (`status`). Default true. */
  discover?: boolean;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /**
   * The media hook. Default RM's useLVSHangout; a host on lvs-react passes its
   * useLVSHangout. Must be the same function on every render.
   */
  useMedia?: (opts: UseLVSHangoutOptions) => UseLVSHangoutResult;
}

export interface ConversationCallResult {
  phase: ConversationCallPhase;
  /** The call you are in — or, while idle, a live call in this lobby you could join (`rejoin()`). */
  call: ConversationCall | null;
  /** A ring for THIS lobby (the app-wide toast uses useIncomingConversationCalls). */
  incoming: IncomingConversationCall | null;
  error: { message: string; status?: number; code?: string } | null;
  /** How the last call ended, while phase is 'ended'. */
  ended: { at: number; reason: string; durationMs: number | null } | null;
  /** "Alice" / "Alice & Bob" while phase is 'calling'. */
  callingTo: string | null;
  /** Your own media state. */
  self: { audioOn: boolean; cameraOn: boolean; screenSharing: boolean };
  /** Ring these people into a new call in this lobby (none = an open call nobody is rung into). */
  start(targets: { userId: string; displayName?: string }[], opts?: { audioOnly?: boolean }): Promise<void>;
  /** Answer `incoming` (or a ring handed over from the app-wide toast). */
  accept(ring?: IncomingConversationCall): Promise<void>;
  decline(reason?: ConversationCallDeclineReason): void;
  /** Hang up (cancels the ring when nobody answered). While 'ended', dismisses. */
  leave(): Promise<void>;
  /** After a failure, join the same call again; while idle, join the live call in this lobby. */
  rejoin(): Promise<void>;
  toggleMic(): void;
  toggleCamera(): void;
  toggleScreenShare(): void;
  /** Members/streams, screen share, raw transport state. */
  media: UseLVSHangoutResult;
  devices: { prefs: DevicePreferences; set(next: DevicePreferences): void; list: UseMediaDevicesResult };
  elapsedMs: number | null;
  /**
   * The loudest participant's `id`, when the host reports one. This hook does
   * not analyse audio; ConversationCallDock (ui-components) does.
   */
  activeSpeakerId: string | null;
}

interface ActiveCall {
  callId: string;
  role: 'caller' | 'joiner';
  host: string;
  audioOnly: boolean;
  targets: { userId: string; displayName: string }[];
  sessionId: string | null;
  stageToken: string | null;
  participantId: string | null;
  startedAt: number | null;
  /** Rendered at join so a changed preference does not re-open the camera mid-call. */
  media: MediaStreamConstraints;
}

interface RosterEntry {
  displayName?: string;
  avatarUrl?: string;
  participantId?: string;
  audioOn?: boolean;
  cameraOn?: boolean;
  screenSharing?: boolean;
  status: 'in-call' | 'reconnecting';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const mintCallId = () => `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** "Alice", "Alice & Bob", "Alice, Bob & 2 others". */
export function callingLabel(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length === 0) return '';
  if (n.length === 1) return n[0]!;
  if (n.length === 2) return `${n[0]} & ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} & ${n[2]}`;
  return `${n[0]}, ${n[1]} & ${n.length - 2} others`;
}

export function useConversationCall(opts: UseConversationCallOptions): ConversationCallResult {
  const gw = useDocumentCallGateway(opts.gateway);
  const gwRef = useRef(gw);
  gwRef.current = gw;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { lobbyName } = opts;
  const selfIdRef = useRef(opts.self.userId);
  selfIdRef.current = opts.self.userId;
  const channel = opts.channel === undefined ? channelForLobby(lobbyName) : opts.channel;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const endedHoldMs = opts.endedHoldMs ?? 4_000;
  const ringTimeoutMs = opts.ringTimeoutMs ?? 60_000;
  const acceptedJoinTimeoutMs = opts.acceptedJoinTimeoutMs ?? 30_000;

  const [prefs, setPrefs] = useDevicePreferences(opts.deviceStorage, opts.devices);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const deviceList = useMediaDevices();

  const [active, setActiveState] = useState<ActiveCall | null>(null);
  const activeRef = useRef<ActiveCall | null>(null);
  const setActive = useCallback((next: ActiveCall | null | ((a: ActiveCall | null) => ActiveCall | null)) => {
    const v = typeof next === 'function' ? next(activeRef.current) : next;
    activeRef.current = v;
    setActiveState(v);
  }, []);
  const [busy, setBusy] = useState<'creating' | 'joining' | null>(null);
  const [error, setError] = useState<ConversationCallResult['error']>(null);
  const [ended, setEnded] = useState<ConversationCallResult['ended']>(null);
  const [incoming, setIncomingState] = useState<IncomingConversationCall | null>(null);
  const incomingRef = useRef<IncomingConversationCall | null>(null);
  const setIncoming = useCallback((v: IncomingConversationCall | null) => { incomingRef.current = v; setIncomingState(v); }, []);
  const [discovered, setDiscovered] = useState<{ callId: string; userIds: string[] } | null>(null);
  const discoveredRef = useRef(discovered);
  discoveredRef.current = discovered;
  const [roster, setRosterState] = useState<Record<string, RosterEntry>>({});
  const rosterRef = useRef(roster);
  const setRoster = useCallback((fn: (r: Record<string, RosterEntry>) => Record<string, RosterEntry>) => {
    const v = fn(rosterRef.current);
    if (v === rosterRef.current) return;
    rosterRef.current = v;
    setRosterState(v);
  }, []);
  const [accepted, setAcceptedState] = useState<string[]>([]);
  const acceptedRef = useRef<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, 'declined' | 'busy'>>({});
  const outcomesRef = useRef(outcomes);
  outcomesRef.current = outcomes;
  const [self, setSelfState] = useState({ audioOn: true, cameraOn: true, screenSharing: false });
  const selfRef = useRef(self);
  const setSelf = useCallback((patch: Partial<typeof self>) => {
    selfRef.current = { ...selfRef.current, ...patch };
    setSelfState(selfRef.current);
  }, []);
  const [now, setNow] = useState(() => Date.now());
  const mountedAt = useRef(Date.now());

  // ---- transport helpers ---------------------------------------------------
  const send = useCallback((msg: Record<string, unknown>) => gatewaySend(gwRef.current, msg), []);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await optsRef.current.platformApi.getIdToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }, []);
  const lastHeaders = useRef<Record<string, string>>({});

  const api = useCallback(async (path: string, body: unknown) => {
    const f = fetchRef.current;
    if (!f) throw new Error('fetch is not available');
    const headers = await authHeaders();
    lastHeaders.current = headers;
    const res = await f(`${optsRef.current.platformApi.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const j = json as { error?: string; code?: string };
      const err = new Error(j.error || `HTTP ${res.status}`) as Error & { status?: number; code?: string };
      err.status = res.status;
      if (j.code) err.code = j.code;
      throw err;
    }
    return json as Record<string, unknown>;
  }, [authHeaders]);

  /** Everyone else in (or rung into) the active call, by userId. */
  const peerIds = useCallback((): string[] => {
    const a = activeRef.current;
    const ids = new Set<string>();
    if (a) {
      if (a.host && a.host !== selfIdRef.current) ids.add(a.host);
      for (const t of a.targets) ids.add(t.userId);
    }
    for (const uid of Object.keys(rosterRef.current)) ids.add(uid);
    for (const uid of acceptedRef.current) ids.add(uid);
    ids.delete(selfIdRef.current);
    return Array.from(ids);
  }, []);

  const eventBase = useCallback((callId: string): ConversationCallEvent => ({
    callId,
    lobbyName: optsRef.current.lobbyName,
    channel: channelRef.current ?? null,
    peerUserIds: peerIds(),
  }), [peerIds]);

  // ---- media -----------------------------------------------------------------
  const useMedia = opts.useMedia ?? useLVSHangout;
  const lvsCtx = useSafeLVSContext();
  const stageTokenRef = useRef<string | null>(null);
  stageTokenRef.current = active?.stageToken ?? null;
  const getAuthToken = useCallback(() => stageTokenRef.current ?? '', []);
  const media = useMedia({
    stageToken: active?.stageToken ?? null,
    participantId: active?.participantId ?? null,
    userId: opts.self.displayName,
    ...(active ? { media: active.media } : {}),
    ...((opts.lvsBaseUrl ?? lvsCtx?.baseUrl) !== undefined ? { baseUrl: opts.lvsBaseUrl ?? lvsCtx?.baseUrl } : {}),
    getAuthToken,
  });
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const remoteMedia = media.participants.filter((p) => !p.isLocal);
  const remoteCountRef = useRef(0);
  remoteCountRef.current = remoteMedia.length;

  // ---- announcements -----------------------------------------------------------
  const announceSelf = useCallback(() => {
    const a = activeRef.current;
    if (!a || !a.stageToken) return;
    const targets = peerIds();
    if (targets.length === 0) return; // never broadcast
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
  const endPlatformSession = useCallback((a: ActiveCall, keepalive = false) => {
    if (!a.sessionId) return;
    const f = fetchRef.current;
    if (!f) return;
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
  const teardown = useCallback((reason: string) => {
    const a = activeRef.current;
    if (!a) return;
    try { mediaRef.current.leave(); } catch { /* idempotent */ }
    endPlatformSession(a);
    const at = Date.now();
    const durationMs = a.startedAt ? at - a.startedAt : null;
    const base = eventBase(a.callId);
    if (a.startedAt) optsRef.current.onCallEnded?.({ ...base, reason, durationMs });
    else if (a.role === 'caller' && reason === 'no-answer') optsRef.current.onCallMissed?.({ ...base, direction: 'outgoing' });
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
  const hangUp = useCallback((reason: string) => {
    const a = activeRef.current;
    if (!a) return;
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
  const enter = useCallback(async (a: ActiveCall): Promise<boolean> => {
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
      if (!sessionId) throw new Error('No session id from the server');
      if (activeRef.current?.callId !== a.callId) return false; // hung up meanwhile
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
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
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

  const joinMedia = useCallback((audioOnly: boolean): MediaStreamConstraints => deviceConstraints(prefsRef.current, { video: !audioOnly }), []);

  const start = useCallback(async (targets: { userId: string; displayName?: string }[], o2?: { audioOnly?: boolean }) => {
    if (activeRef.current) return;
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
    if (!ok || ring.length === 0) return;
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

  const accept = useCallback(async (ringArg?: IncomingConversationCall) => {
    const ring = ringArg ?? incomingRef.current;
    if (!ring) return;
    const o = optsRef.current;
    if (activeRef.current?.callId === ring.callId) return;
    if (activeRef.current) hangUp('switched');
    setIncoming(null);
    announceRingSettled({ callId: ring.callId, how: 'accepted' });
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
    if (ok) optsRef.current.onCallStarted?.({ ...eventBase(ring.callId), startedAt });
  }, [enter, eventBase, hangUp, joinMedia, send, setIncoming, setRoster, setSelf]);

  const decline = useCallback((reason?: ConversationCallDeclineReason) => {
    const ring = incomingRef.current;
    if (!ring) return;
    setIncoming(null);
    announceRingSettled({ callId: ring.callId, how: 'declined' });
    if (!ring.targeted) return;
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

  const leave = useCallback(async () => {
    if (!activeRef.current) { setEnded(null); return; }
    hangUp('left');
  }, [hangUp]);

  const rejoin = useCallback(async () => {
    const a = activeRef.current;
    if (a) {
      // Lost the call: a fresh session in the same call.
      try { mediaRef.current.leave(); } catch { /* */ }
      await enter({ ...a, sessionId: null, stageToken: null, participantId: null });
      return;
    }
    const d = discoveredRef.current;
    if (!d) return;
    const o = optsRef.current;
    const others = d.userIds.filter((u) => u !== o.self.userId);
    setSelf({ audioOn: true, cameraOn: true, screenSharing: false });
    setRoster(() => Object.fromEntries(others.map((u) => [u, { status: 'in-call' as const }])));
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
  const cameraPublished = useRef(false);
  const toggleMic = useCallback(() => {
    const on = !selfRef.current.audioOn;
    try { mediaRef.current.toggleMute(!on); } catch { /* */ }
    setSelf({ audioOn: on });
    announceSelf();
  }, [announceSelf, setSelf]);

  const toggleCamera = useCallback(() => {
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

  const toggleScreenShare = useCallback(() => {
    const m = mediaRef.current;
    if (selfRef.current.screenSharing) {
      try { m.stopScreenShare(); } catch { /* */ }
      setSelf({ screenSharing: false });
      announceSelf();
      return;
    }
    void Promise.resolve(m.startScreenShare()).then(
      () => { setSelf({ screenSharing: true }); announceSelf(); },
      () => { /* picker cancelled */ },
    );
  }, [announceSelf, setSelf]);

  // The transport's own view of screen share (the browser's "Stop sharing" bar).
  useEffect(() => {
    if (!media.isScreenSharing && selfRef.current.screenSharing && active?.stageToken) {
      setSelf({ screenSharing: false });
      announceSelf();
    }
  }, [media.isScreenSharing, active?.stageToken, announceSelf, setSelf]);

  // ---- inbound frames ------------------------------------------------------------
  const markAccepted = useCallback((uid: string) => {
    if (acceptedRef.current.includes(uid)) return;
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
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: GatewayMessage) => {
      const f = asCallFrame(msg);
      if (!f) return;
      const d = f.data;
      const o = optsRef.current;
      const me = o.self.userId;
      const callId = str(d.callId);
      const a = activeRef.current;
      const inThisCall = !!a && !!callId && callId === a.callId;
      const ring = incomingRef.current;

      switch (f.action) {
        case 'active-call': {
          if (d.lobbyName !== o.lobbyName) return;
          if (d.active === true && callId && callId !== a?.callId) {
            const ids = Array.isArray(d.participantUserIds)
              ? Array.from(new Set((d.participantUserIds as unknown[]).filter((u): u is string => typeof u === 'string' && !!u)))
              : [];
            setDiscovered({ callId, userIds: ids });
          } else if (d.active !== true) {
            setDiscovered(null);
          }
          return;
        }
        case 'invite': {
          if (d.lobbyName !== o.lobbyName || d.admit === true) return;
          const parsed = parseConversationInvite(d, me);
          if (!parsed || parsed.callId === a?.callId) return;
          if (ring?.callId === parsed.callId) return;
          setIncoming(parsed);
          return;
        }
        case 'accepted': {
          const uid = str(d.userId) ?? str(d.callerId);
          if (!uid || !callId) return;
          if (uid === me) {
            // Answered on another tab of mine.
            if (ring?.callId === callId) setIncoming(null);
            return;
          }
          if (!inThisCall) return;
          setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), ...(str(d.displayName) ? { displayName: str(d.displayName) } : {}), status: 'in-call' } }));
          markAccepted(uid);
          announceSelf();
          return;
        }
        case 'declined': {
          const uid = str(d.callerId) ?? str(d.userId);
          if (!inThisCall || !uid || uid === me || a!.role !== 'caller') return;
          const next = { ...outcomesRef.current, [uid]: 'declined' as const };
          outcomesRef.current = next;
          setOutcomes(next);
          const everyoneSaidNo = a!.targets.length > 0 && a!.targets.every((t) => next[t.userId] === 'declined');
          if (everyoneSaidNo && acceptedRef.current.length === 0 && remoteCountRef.current === 0) hangUp('declined');
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
          if (!a || f.action === 'cancelled') return;
          const reason = str(d.reason);
          // Our own hang-up echoing back from another tab carries no reason.
          if (str(d.callerId) === me && !reason) return;
          const lobbyMatch = d.lobbyName === o.lobbyName;
          const twoParty = peerIds().length <= 1;
          // A server-synthetic end (it has a reason) of a two-party call may
          // name the lobby only; a stale one right after mount is the dying
          // broadcast of the previous call in the same DM.
          const lobbyOnly = !inThisCall && lobbyMatch && !!reason && twoParty && Date.now() - mountedAt.current > 2000;
          if (!inThisCall && !lobbyOnly) return;
          teardown(reason ?? 'ended');
          return;
        }
        case 'user-status': {
          const uid = str(d.userId) ?? str(d.callerId);
          if (!a || !uid || uid === me) return;
          if (!inThisCall && !(d.lobbyName === o.lobbyName && !callId)) return;
          const status = str(d.status);
          if (status === 'busy') {
            const next = { ...outcomesRef.current, [uid]: 'busy' as const };
            outcomesRef.current = next;
            setOutcomes(next);
            return;
          }
          if (status === 'reconnecting' || (status === 'left' && str(d.reason) === 'unload')) {
            setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), status: 'reconnecting' } }));
            return;
          }
          if (status === 'left') {
            const hadPeer = !!rosterRef.current[uid] || acceptedRef.current.includes(uid);
            setRoster((r) => {
              if (!r[uid]) return r;
              const next = { ...r };
              delete next[uid];
              return next;
            });
            acceptedRef.current = acceptedRef.current.filter((u) => u !== uid);
            setAcceptedState(acceptedRef.current);
            // The last other person hung up: a call with only you on it is over.
            const othersLeft = Object.keys(rosterRef.current).length;
            if (hadPeer && othersLeft === 0 && activeRef.current?.startedAt) teardown('peer-left');
            return;
          }
          if (status === 'in-call' || d.inCall === true) {
            setRoster((r) => ({ ...r, [uid]: { ...(r[uid] ?? {}), status: 'in-call' } }));
          }
          return;
        }
        case 'participant-state': {
          const uid = str(d.userId) ?? str(d.callerId);
          if (!a || !uid || uid === me || !inThisCall) return;
          if (str(d.status) === 'left') return;
          const wasAbsent = !rosterRef.current[uid];
          setRoster((r) => {
            const prev = r[uid] ?? { status: 'in-call' as const };
            const next: RosterEntry = { ...prev, status: str(d.status) === 'reconnecting' ? 'reconnecting' : 'in-call' };
            if (str(d.displayName)) next.displayName = str(d.displayName);
            if (str(d.avatarUrl)) next.avatarUrl = str(d.avatarUrl);
            if (str(d.participantId)) next.participantId = str(d.participantId);
            if (typeof d.audioOn === 'boolean') next.audioOn = d.audioOn;
            if (typeof d.cameraOn === 'boolean') next.cameraOn = d.cameraOn;
            if (typeof d.screenSharing === 'boolean') next.screenSharing = d.screenSharing;
            return { ...r, [uid]: next };
          });
          if (a.role === 'caller') markAccepted(uid);
          // A newcomer does not know our state yet.
          if (wasAbsent) announceSelf();
          return;
        }
        default:
      }
    });
  }, [onMessage, announceSelf, eventBase, hangUp, markAccepted, peerIds, setIncoming, setRoster, teardown]);

  // Rings answered by another hook in this page (the app-wide toast).
  useEffect(() => onRingSettled(({ callId }) => {
    if (incomingRef.current?.callId === callId) setIncoming(null);
  }), [setIncoming]);

  // ---- discovery + reconnect -------------------------------------------------
  const discover = opts.discover !== false;
  useEffect(() => {
    setDiscovered(null);
    setIncoming(null);
    mountedAt.current = Date.now();
    if (discover) send({ service: 'call', action: 'status', lobbyName });
  }, [lobbyName, discover, send, setIncoming]);

  const epoch = gw?.sessionEpoch;
  const connectionState = gw?.connectionState;
  const lastEpoch = useRef<number | undefined>(epoch);
  const wasConnected = useRef(connectionState === undefined || connectionState === 'connected');
  useEffect(() => {
    const isConnected = connectionState === undefined || connectionState === 'connected';
    const epochBumped = epoch !== undefined && lastEpoch.current !== undefined && epoch !== lastEpoch.current;
    const cameBack = isConnected && !wasConnected.current;
    lastEpoch.current = epoch;
    wasConnected.current = isConnected;
    if (!(epochBumped || cameBack)) return;
    if (discover) send({ service: 'call', action: 'status', lobbyName: optsRef.current.lobbyName });
    announceSelf();
  }, [epoch, connectionState, discover, send, announceSelf]);

  // ---- media joined: say so, apply the join state -----------------------------------
  const mediaUp = !!active?.stageToken && media.isJoined;
  useEffect(() => {
    if (!mediaUp) return;
    cameraPublished.current = !activeRef.current?.audioOnly;
    if (!selfRef.current.audioOn) { try { mediaRef.current.toggleMute(true); } catch { /* */ } }
    announceSelf();
  }, [mediaUp, announceSelf]);

  // A remote tile arriving is an answer too (a callee who skipped `accepted`).
  useEffect(() => {
    const a = activeRef.current;
    if (!a || a.role !== 'caller' || a.startedAt || remoteMedia.length === 0) return;
    const who = a.targets[0]?.userId;
    if (who) markAccepted(who);
  }, [remoteMedia.length, markAccepted]);

  // ---- ring timeouts ------------------------------------------------------------
  const ringing = !!active && active.role === 'caller' && active.targets.length > 0 && remoteMedia.length === 0;
  const anyAccepted = accepted.length > 0;
  const hasRoster = Object.keys(roster).some((u) => roster[u]!.participantId);
  useEffect(() => {
    if (!ringing || !active?.stageToken || hasRoster) return;
    const t = setTimeout(() => hangUp('no-answer'), anyAccepted ? acceptedJoinTimeoutMs : ringTimeoutMs);
    return () => clearTimeout(t);
  }, [ringing, active?.stageToken, hasRoster, anyAccepted, acceptedJoinTimeoutMs, ringTimeoutMs, hangUp]);

  // ---- clocks ---------------------------------------------------------------
  const startedAt = active?.startedAt ?? null;
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setEnded(null), endedHoldMs);
    return () => clearTimeout(t);
  }, [ended, endedHoldMs]);

  // ---- leaving the page ---------------------------------------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onUnload = () => {
      const a = activeRef.current;
      if (!a) return;
      const o = optsRef.current;
      const peers = peerIds();
      // 'unload', not 'hung-up': they may be refreshing, so the others show
      // reconnecting and the server's rejoin grace decides.
      if (peers.length > 0) {
        gatewaySend(gwRef.current, { service: 'call', action: 'user-status', callId: a.callId, callerId: o.self.userId, userId: o.self.userId, lobbyName: o.lobbyName, status: 'left', reason: 'unload', targetUserIds: peers });
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
  const hangUpRef = useRef(hangUp);
  hangUpRef.current = hangUp;
  useEffect(() => () => { if (activeRef.current) hangUpRef.current('left'); }, []);

  // ---- derived -----------------------------------------------------------------
  const gatewayDown = connectionState !== undefined && connectionState !== 'connected';
  const mediaFailed = !!active?.stageToken && (!!media.error || media.connectionState === 'failed');
  const callerRinging = ringing && accepted.length === 0 && !Object.values(roster).some((r) => r.status === 'in-call');

  let phase: ConversationCallPhase;
  if (error || mediaFailed) phase = 'failed';
  else if (active) {
    if (busy || !active.stageToken) phase = 'connecting';
    else if (gatewayDown || media.connectionState === 'reconnecting') phase = 'reconnecting';
    else if (callerRinging) phase = 'calling';
    else if (media.isJoined) phase = 'live';
    else phase = 'connecting';
  } else if (incoming) phase = 'ringing';
  else if (ended) phase = 'ended';
  else phase = 'idle';

  const participants = useMemo<ConversationCallParticipant[]>(() => {
    const o = opts;
    const out: ConversationCallParticipant[] = [];
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
    const targetName = (uid: string) => active?.targets.find((t) => t.userId === uid)?.displayName;
    const byPid = new Map<string, string>();
    for (const [uid, r] of Object.entries(roster)) if (r.participantId) byPid.set(r.participantId, uid);
    const unmatchedMedia = remoteMedia.filter((m) => !byPid.has(m.participantId));
    const unmatchedPeople = Object.keys(roster).filter((u) => !roster[u]!.participantId)
      .concat(accepted.filter((u) => !roster[u]));
    // One unknown tile and one person without one: that is them.
    if (unmatchedMedia.length === 1 && unmatchedPeople.length === 1) byPid.set(unmatchedMedia[0]!.participantId, unmatchedPeople[0]!);
    const seen = new Set<string>([o.self.userId]);
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
    const person = (uid: string, state: ConversationCallParticipant['state'], r?: RosterEntry): ConversationCallParticipant => ({
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
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push(person(uid, r.status, r));
    }
    for (const uid of accepted) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push(person(uid, 'in-call'));
    }
    if (!active && discovered) {
      for (const uid of discovered.userIds) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push(person(uid, 'in-call'));
      }
    }
    // Invitees not in the call.
    for (const t of active?.targets ?? []) {
      if (seen.has(t.userId)) continue;
      out.push(person(t.userId, outcomes[t.userId] ?? 'ringing'));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, media.participants, roster, accepted, outcomes, discovered, incoming, self, opts.self.userId, opts.self.displayName, opts.self.avatarUrl]);

  const participantCount = participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').length;

  const call = useMemo<ConversationCall | null>(() => {
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

  const devices = useMemo(() => ({ prefs, set: setPrefs, list: deviceList }), [prefs, setPrefs, deviceList]);

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
