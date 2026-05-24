// useLVSHangout — composite WebRTC hangout hook built on the LVS
// (live-video-streaming) WHIP+WHEP primitives. Drop-in replacement for
// the IVS-Stage-based useHangoutEmbed in websocket-gateway/frontend.
//
// Contract: caller passes a participant token (the platform-api join
// response) + a per-tab participantId + a display name. The hook:
//   1. decodes the channel ARN from the token,
//   2. acquires camera+mic via getUserMedia,
//   3. publishes via useLVSPublisher (WHIP),
//   4. opens ONE parallel WHEP PC per remote publisher discovered via
//      the producer-discovery WS (both base cameras AND `:screen`
//      producers — symmetric handling),
//   5. assembles a participants list keyed by remote base pid so
//      consumers can route tracks into per-tile UIs,
//   6. exposes mute/camera/screen-share toggles + leave().
//
// The composite owns capture; the underlying publisher hook is headless
// (caller-owned capture by design), so this layer is where getUserMedia
// + screen-share live.
//
// 2026-05-23 — 3+ person fix. Previously this hook used a single
// `useLVSSubscriber` WHEP that re-handshook on `producer.added`. That
// only ever carried ONE peer's tracks per kind because the SFU's
// `findProducerOfKind` returns first-match. For N peers we need N-1
// parallel PCs (one per remote publisher), each WHEP'ing with the
// positive `participantId` selector so the SFU answers with EXACTLY
// that publisher's tracks. The screen-share path already did this for
// `:screen` pids — we now do the same uniformly for cameras too, and
// the main subscriber is gone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeArn } from './lib/jwt';
import { useLVSPublisher } from './useLVSPublisher';
import { whepPublish, whepTeardown, fetchIceServers } from './lib/transport';
import { useSafeLVSContext, type LVSConfig } from './LVSProvider';
import { waitForIceGather } from './lib/sdp';

/** Default capture constraints — 720p video + audio. Matches the IVS
 *  Stage-based useHangoutEmbed defaults so swap is visually identical. */
const DEFAULT_MEDIA: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: true,
};

export interface UseLVSHangoutOptions {
  /** Participant token from platform-api `/api/video/sessions/:id/join`.
   *  Decoded to extract the `arn` claim (the SFU channel ARN). */
  stageToken: string | null;
  /** SFU-issued participant id (per-tab unique). */
  participantId: string | null;
  /** Display name for the local user. */
  userId: string;
  /** Media constraints for getUserMedia. Defaults to { video: 720p, audio: true }. */
  media?: MediaStreamConstraints;
  /** Override base URL (else read from LVSProvider). */
  baseUrl?: string;
  /** Override token resolver. The default resolver returns `stageToken` itself. */
  getAuthToken?: () => string | Promise<string>;
}

export interface HangoutParticipant {
  /** Stable per-tab id (the publisher's WHIP participantId or, for remotes,
   *  the SDP msid label). */
  participantId: string;
  /** Display name. For remotes, falls back to participantId. */
  displayName: string;
  /** True for the local user. */
  isLocal: boolean;
  /** Per-participant streams — usually `[cameraStream]`. Empty array while
   *  remote hasn't yet produced. Note: `screenStream` is exposed
   *  separately below so consumers can route it into a spotlight slot
   *  while keeping the camera tile alive as a PiP. */
  streams: MediaStream[];
  /** Active screen-share stream, if any. For the local user, populated
   *  by `startScreenShare()`. For remotes, populated by the dedicated
   *  parallel-WHEP PC opened against the `${pid}:screen` producer.
   *  Undefined when not sharing. */
  screenStream?: MediaStream;
  /** Alias retained for legacy ui-components consumers — same as
   *  `displayName`. Some downstream components key on `userId`. */
  userId: string;
  /** Convenience: is any audio track currently enabled? */
  hasAudio: boolean;
  /** Convenience: is any video track currently enabled? */
  hasVideo: boolean;
  /** Wall-clock `Date.now()` recorded the first time this remote pid was
   *  discovered by the multi-WHEP fan-out (i.e. when openPcFor opened a
   *  PC for them). Undefined for the local participant. Consumers use this
   *  alongside `subscriberMs` to implement ghost-producer policies — e.g.
   *  if the SFU keeps a stale producer alive for ~30s after a publisher
   *  crashes, a fresh joiner will WHEP onto it and get a tile with NO
   *  matching app-level identity broadcast. The consumer can compare
   *  `subscriberMs` against a threshold (e.g. 3s) and the absence of a
   *  matching participantState entry to hide the tile.
   *
   *  Note: the hook does NOT filter — it only exposes the timestamp. The
   *  consumer owns the policy decision. */
  firstSeenAt?: number;
  /** Milliseconds since this remote pid was first WHEP'd. Computed on
   *  every render against an internal 1s tick so callers get a coarse
   *  "how long has this tile been here" value without managing their
   *  own timer. Undefined for the local participant. Resolution: ~1s
   *  (don't use for sub-second decisions). */
  subscriberMs?: number;
}

/** Convenience alias — every entry in `participants` where `isLocal=false`
 *  is structurally a `RemoteParticipant`. Same shape as `HangoutParticipant`;
 *  exported so consumers writing ghost-producer filters can name the type
 *  they're working with. */
export type RemoteParticipant = HangoutParticipant;

/**
 * Aggregate transport health across the publisher WHIP PC + every WHEP
 * subscriber PC. UI consumers (HangoutOverlay) render a banner-toast
 * while this is `'reconnecting'` so the user knows the call is
 * recovering rather than permanently dead.
 *
 *   - 'idle'         — no token/pid yet, or the call hasn't been joined
 *   - 'connecting'   — initial WHIP/WHEP handshake in flight
 *   - 'connected'    — publisher live AND every WHEP PC is 'connected'
 *                       (or there are no remote PCs yet)
 *   - 'reconnecting' — publisher OR any WHEP PC is mid-auto-recovery
 *                       (publisher.phase='reconnecting' OR a WHEP PC's
 *                       connectionState is 'disconnected'/'failed' AND
 *                       the all-tracks-ended path has scheduled a retry)
 *   - 'failed'       — publisher hit its permanent error (retry budget
 *                       exhausted) — UI should prompt user to refresh
 */
export type HangoutConnectionState =
  | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface UseLVSHangoutResult {
  participants: HangoutParticipant[];
  isJoined: boolean;
  isScreenSharing: boolean;
  isCameraEnabled: boolean;
  error: string | null;
  /** Aggregate transport health across publisher WHIP + every WHEP
   *  subscriber. Drives the "Reconnecting…" banner in HangoutOverlay. */
  connectionState: HangoutConnectionState;
  toggleMute: (muted: boolean) => void;
  /** Flip the local camera track's `enabled` flag — no SDP churn.
   *  Remote will see a black frame / frozen last frame. Use this for
   *  mid-call mute. For ADD/REMOVE of the video track itself (true
   *  upgrade/downgrade), call `enableCamera()` / `disableCamera()`. */
  toggleCamera: (off: boolean) => void;
  /** Acquire camera + add to the publish stream via re-WHIP. Used when
   *  the call started audio-only and the user wants to turn video on.
   *  Costs ~500ms-1s gap while ICE+DTLS re-handshakes. Idempotent —
   *  no-op when camera is already published. */
  enableCamera: () => Promise<void>;
  /** Drop the camera track + re-publish audio-only. Subscribers will
   *  see the video producer disappear (via `producer.removed`). */
  disableCamera: () => Promise<void>;
  /** Unified camera-toggle entry point that survives a `.stop()`'d track.
   *  When the existing video track is still `live`, this just flips
   *  `enabled` (same as `toggleCamera`). When the track is `ended` /
   *  stopped (camera permission revoked, device unplugged, prior consumer
   *  called `.stop()`), this re-runs `getUserMedia` for video-only and
   *  swaps the new track onto the existing video sender via
   *  `RTCRtpSender.replaceTrack` — no WHIP renegotiation, peers keep
   *  their subscription. Concurrency-guarded so a double-tap doesn't
   *  spawn two getUserMedia calls. */
  setCameraEnabled: (on: boolean) => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  leave: () => void;
}

/** Recompute hasAudio/hasVideo flags by inspecting each stream's enabled
 *  tracks. Pure helper so participant updates stay declarative. */
function computeMediaFlags(streams: MediaStream[]): { hasAudio: boolean; hasVideo: boolean } {
  let hasAudio = false;
  let hasVideo = false;
  for (const s of streams) {
    for (const t of s.getTracks()) {
      if (t.kind === 'audio' && t.enabled && t.readyState === 'live') hasAudio = true;
      if (t.kind === 'video' && t.enabled && t.readyState === 'live') hasVideo = true;
    }
  }
  return { hasAudio, hasVideo };
}

/**
 * Composite hangout hook. Wires WHIP (useLVSPublisher) + per-remote
 * parallel WHEP PCs into a single participants-list API matching the
 * legacy IVS-Stage-based useHangoutEmbed surface, so consumers
 * (HangoutOverlay, HangoutDemoPage, VideoCallPanel) can swap with a
 * one-line import change.
 *
 * Lifecycle:
 *   - idle while `stageToken` or `participantId` is null
 *   - acquires camera+mic via getUserMedia on first valid input
 *   - autostarts publisher
 *   - opens the discovery WS; for every remote producer.added event
 *     (camera OR `:screen`) opens a dedicated WHEP PC targeting that
 *     publisher's pid with the positive selector. The SFU's
 *     `findProducerOfKind(arn, kind, participantId)` returns ONLY
 *     that publisher's tracks, so each remote peer gets its own PC
 *     and its own tile.
 *   - `leave()` releases all local tracks + tears down every parallel PC
 *   - unmount cleanup mirrors `leave()` (idempotent)
 *
 * Track routing: each parallel PC's onTrack carries that remote's
 * camera (or screen) tracks. We attach them to the participant entry
 * keyed by the remote's BASE pid (`fullPid.split(':')[0]`); a peer's
 * camera + screen end up on the same participant entry — camera in
 * `streams[]`, screen in `screenStream` — so a single peer never
 * appears as two tiles.
 */
export function useLVSHangout(opts: UseLVSHangoutOptions): UseLVSHangoutResult {
  const { stageToken, participantId, userId, media, baseUrl, getAuthToken } = opts;

  // ARN derivation: cheap + pure, memoize so we don't re-decode every
  // render. Null when the token is missing or malformed -> hook idles.
  const channelArn = useMemo(() => decodeArn(stageToken), [stageToken]);
  // Safe-context — null when caller forgot to mount <LVSProvider>. The
  // parallel-WHEP effect uses ctx?.baseUrl as the fallback when opts.baseUrl
  // is unset.
  const ctx: LVSConfig | null = useSafeLVSContext();

  // Local capture state. The publisher hook is headless (caller-owned
  // capture), so this layer owns getUserMedia + screen-share swap.
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [remoteParticipants, setRemoteParticipants] = useState<
    Map<string, {
      streams: MediaStream[];
      streamIds: Set<string>;
      // Dedicated screen-share stream consumed via a parallel WHEP PC
      // targeting `${basePid}:screen`. Kept separate from `streams[]`
      // so the consumer can render the camera tile + spotlight
      // independently without inspecting tracks.
      screenStream?: MediaStream;
    }>
  >(new Map());
  // Bump on any local-track enabled toggle so participants memo
  // recomputes hasAudio/hasVideo without us re-rendering the streams ref.
  const [localFlagsTick, setLocalFlagsTick] = useState(0);

  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null); // preserved across screen-share for restore
  const screenShareTrackRef = useRef<MediaStreamTrack | null>(null);
  // Guard against double-tap of the camera toggle while a re-acquire
  // getUserMedia() is in flight — a second call would spawn a parallel
  // permission/device request and race the first one's replaceTrack.
  const cameraToggleInFlightRef = useRef(false);

  // Idempotency flag for leave(). React StrictMode can drive a fast
  // leave-then-unmount sequence (or a consumer might double-bind a
  // button onClick); without this guard, leave() would iterate the
  // already-emptied refs and the unmount-effect cleanup would re-fire
  // setState on a torn-down tree.
  const leftRef = useRef(false);

  // Parallel WHEP PCs for EVERY remote producer, keyed by the producer's
  // full participantId. For a peer named `hank` you'll see two entries
  // when they're sharing: `hank` (camera kind) + `hank:screen` (screen
  // kind). Managed imperatively from the producer-discovery WS effect
  // below — outside React's render path because hooks can't be called
  // in loops, and we need N concurrent PCs at runtime.
  //
  // `epoch` tags which effect-invocation opened this PC. React StrictMode
  // in dev double-invokes effects (mount → cleanup → mount), and without
  // an epoch tag the SECOND invocation would observe an empty
  // remoteSubscribersRef (cleanup cleared it) and re-open every WHEP,
  // leaving TWO RTCPeerConnections subscribed to the same producer. With
  // an epoch tag, the second invocation can detect "same-pid, older
  // epoch still in flight or holding the slot" and close-then-replace
  // atomically.
  const remoteSubscribersRef = useRef<Map<string, {
    pc: RTCPeerConnection;
    resourceUrl: string;
    authToken: string;
    kind: 'camera' | 'screen';
    epoch: number;
  }>>(new Map());

  // In-flight openPcFor calls — keyed by fullPid, value is the epoch of
  // the effect-invocation that started the open + a cancel flag the
  // caller can flip. Without this map the StrictMode-fast cleanup sets
  // `cancelled = true` on the effect-closure-local var but the open
  // continues to addTransceiver / whepPublish / setRemoteDescription
  // and THEN drops the PC into remoteSubscribersRef AFTER cleanup
  // already iterated the map and tore down what it could see.
  //
  // Shape: { epoch, cancel: () => void }. The cancel fn sets the
  // entry's internal flag (closed-over) which the openPcFor body
  // checks at every async boundary.
  const inFlightOpensRef = useRef<Map<string, {
    epoch: number;
    cancelled: boolean;
  }>>(new Map());

  // Monotonic effect-epoch counter. Incremented at the top of every
  // discovery-WS effect mount; cleanup captures its own epoch so it
  // only tears down what IT opened (or what it stole from older
  // epochs). React StrictMode runs effects twice in dev — without an
  // epoch we cannot distinguish "cleanup of epoch 1 firing AFTER
  // epoch 2 already opened a PC" from "cleanup of epoch 2 firing
  // after its own open completed".
  const effectEpochRef = useRef(0);

  // First-seen timestamp per remote BASE pid (screen-only pids share the
  // base entry). Recorded the first time the discovery WS / parallel-WHEP
  // path observes a brand-new pid. Exposed on each participant as
  // `firstSeenAt` so consumers can implement ghost-producer policies
  // (e.g. hide tiles older than 3s with no matching identity broadcast).
  // Lives in a ref because the value is set-once per pid and we don't
  // want a state update just to record it; the render-side `nowTick`
  // below drives recomputation of the derived `subscriberMs` field.
  const firstSeenAtRef = useRef<Map<string, number>>(new Map());

  // Live snapshot of producers the discovery WS has told us are alive on
  // the SFU. Keyed by fullPid → kind. Populated on `producer.added`,
  // dropped on `producer.removed`. Used by the all-tracks-ended auto-
  // recovery path: when a WHEP PC dies but the producer is still in this
  // map, schedule a fresh openPcFor. Without this we'd never know the
  // producer is still on the server (the producer.added that originally
  // opened the PC may have fired minutes ago and we never persisted it).
  const knownProducersRef = useRef<Map<string, 'camera' | 'screen'>>(new Map());

  // Retry budget per fullPid for the all-tracks-ended auto-recovery
  // path. Each entry holds the count + first-attempt timestamp; we
  // reset when 30s have passed since the first attempt. Cap = 3 retries
  // within a 30s window so a pathologically wedged producer (SFU side
  // misconfig, codec mismatch) doesn't spam reconnects forever.
  const retryBudgetRef = useRef<Map<string, { count: number; windowStart: number }>>(new Map());
  const RETRY_CAP = 3;
  const RETRY_WINDOW_MS = 30_000;
  const RETRY_DELAY_MS = 1_000;

  // Pending retry timers per fullPid so leave()/cleanup can cancel them
  // before they fire into a torn-down hook.
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Live snapshot of every WHEP PC's connectionState, keyed by fullPid.
  // Updated by a `connectionstatechange` listener installed in openPcFor.
  // The aggregate `connectionState` derived value reads this map: ANY
  // entry in 'disconnected'/'failed' flips the public aggregate to
  // 'reconnecting' so the UI can banner-toast. Lives in a ref to avoid
  // re-renders for every transient state churn; the `whepHealthTick`
  // state below drives the actual re-render when the AGGREGATE changes.
  const whepConnStatesRef = useRef<Map<string, RTCPeerConnectionState>>(new Map());
  const [whepHealthTick, setWhepHealthTick] = useState(0);
  // Helper exposed via ref so the visibilitychange handler (which lives
  // outside the discovery effect's closure) can poke the WHEP recovery
  // path without us having to plumb scheduleRetry across closures.
  const scheduleRetryRef = useRef<((fullPid: string) => void) | null>(null);

  // Render-time "now" — bumped every 1s so the `subscriberMs` field in
  // the participants memo recomputes without callers having to mount
  // their own setInterval. Resolution: ~1s. Stops bumping when the
  // component unmounts (cleanup clears the interval).
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Stable identity so the publisher hook doesn't observe a new
  // `getAuthToken` on every render (which would churn its useMemo and
  // potentially restart publish).
  const stageTokenRef = useRef(stageToken);
  stageTokenRef.current = stageToken;
  const customGetAuthRef = useRef(getAuthToken);
  customGetAuthRef.current = getAuthToken;

  const resolveAuthToken = useCallback(async () => {
    const custom = customGetAuthRef.current;
    if (custom) return custom();
    return stageTokenRef.current ?? '';
  }, []);

  // Capture camera+mic when token+participantId become valid. Re-runs
  // only when those primary inputs change (not media constraints — that
  // would teardown on every render if a parent re-creates the object).
  useEffect(() => {
    if (!channelArn || !participantId) return;
    let cancelled = false;
    setError(null);
    const constraints = media ?? DEFAULT_MEDIA;
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        cameraStreamRef.current = stream;
        setLocalStream(stream);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setError(`getUserMedia failed: ${msg}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelArn, participantId]);

  // Publisher (WHIP). autoStart=true means the hook fires as soon as
  // both stream + channelArn are set. Idle while null.
  const publisher = useLVSPublisher({
    channelArn: channelArn ?? '',
    stream: channelArn ? localStream : null,
    participantId: participantId ?? undefined,
    autoStart: true,
    baseUrl,
    getAuthToken: resolveAuthToken,
  });

  // Second publisher dedicated to screen-share. Uses a synthetic
  // participantId suffix `${participantId}:screen` so the SFU treats
  // it as a separate publisher and remote subscribers can WHEP it as
  // its own producer (camera publisher stays untouched on the wire).
  // Auto-starts when `localScreenStream` is non-null, auto-tears-down
  // when it's nulled. Same auth resolver. Memoized so the publisher
  // hook's deps don't see a new string identity per render (would
  // re-bind start() each render — harmless today but keeps a stable
  // upstream contract).
  const screenParticipantId = useMemo(
    () => (participantId ? `${participantId}:screen` : undefined),
    [participantId],
  );
  const screenPublisher = useLVSPublisher({
    channelArn: channelArn ?? '',
    stream: channelArn ? localScreenStream : null,
    participantId: screenParticipantId,
    autoStart: true,
    baseUrl,
    getAuthToken: resolveAuthToken,
  });
  // Silence "declared but never read" — the hook is consumed for its
  // side effects (WHIP transport lifecycle), not its return value.
  void screenPublisher;

  // Parallel WHEP for EVERY remote producer (camera + screen).
  //
  // The SFU's WHEP answer with no `participantId` selector returns ONE
  // matching producer per kind (first-match across the channel). For
  // multi-peer hangouts (3+ tabs) that means we'd only ever see ONE
  // remote peer's tracks via a single PC. So instead we open a
  // dedicated PC PER remote producer, each WHEP'ing with the positive
  // `participantId: <fullPid>` selector — the SFU then returns ONLY
  // that publisher's tracks.
  //
  // Lifecycle:
  //   - subscribe-channel handshake on WS open → server replays existing
  //     producers (late-join catches all peers already in the call)
  //   - on `producer.added` with a NON-self pid → open a WHEP PC
  //     (kind='screen' when pid ends `:screen`, else 'camera')
  //   - on `producer.removed` → close the PC + drop the relevant
  //     stream (screenStream if screen-kind; streams[] entry otherwise)
  //   - on unmount → close every PC + DELETE every WHEP resource
  useEffect(() => {
    if (!channelArn) return;
    if (!participantId) return;
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl;
    if (!baseUrl) return;

    // Bump the epoch BEFORE any work. Cleanup will capture this value
    // and use it to decide which PCs/in-flight opens it owns.
    effectEpochRef.current += 1;
    const myEpoch = effectEpochRef.current;

    let cancelled = false;
    let ws: WebSocket | null = null;
    // Reconnect-ladder state — see WS setup further down.
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // forceDeleteBase=true means "even if other media (camera streams or
    // screen) remain on the participant entry, scrub the basePid entirely
    // from remoteParticipants and firstSeenAtRef". The all-tracks-ended
    // auto-recovery path uses this so the next openPcFor sees a clean
    // slate and creates a fresh MediaStream — without it, a stale entry
    // could linger (e.g. screenStream still present from a different PC)
    // and prevent the consumer's <video> element from re-binding to the
    // fresh stream id. For producer.removed and StrictMode cleanup paths,
    // the historical "preserve sibling media" semantics still apply.
    const cleanupPc = (fullPid: string, forceDeleteBase = false) => {
      // Cancel any in-flight open for this pid so the open body bails
      // before it can publish a new entry to remoteSubscribersRef.
      const inflight = inFlightOpensRef.current.get(fullPid);
      if (inflight) {
        inflight.cancelled = true;
        inFlightOpensRef.current.delete(fullPid);
      }
      const entry = remoteSubscribersRef.current.get(fullPid);
      if (!entry) {
        // No PC to close, but if forceDeleteBase is set we still want
        // to scrub the participant entry (covers the case where the
        // PC was already torn down by a prior sweep).
        if (forceDeleteBase) {
          const basePid = fullPid.split(':')[0] ?? fullPid;
          setRemoteParticipants((prev) => {
            if (!prev.has(basePid)) return prev;
            const next = new Map(prev);
            next.delete(basePid);
            return next;
          });
          firstSeenAtRef.current.delete(basePid);
        }
        return;
      }
      // Permanent diagnostic — paired with the open log so we can grep
      // open/close transitions when remote tiles inevitably regress.
      console.info('[remote-pc] close', { fullPid, kind: entry.kind, epoch: entry.epoch, forceDeleteBase });
      try { entry.pc.close(); } catch { /* ignore */ }
      // Fire-and-forget DELETE — best effort.
      void whepTeardown(entry.resourceUrl, entry.authToken).catch(() => { /* */ });
      remoteSubscribersRef.current.delete(fullPid);
      // Drop the per-PC connectionState snapshot so the aggregate doesn't
      // keep reporting 'reconnecting' for a PC that no longer exists.
      whepConnStatesRef.current.delete(fullPid);
      setWhepHealthTick((n) => n + 1);
      const basePid = fullPid.split(':')[0] ?? fullPid;
      const isScreen = entry.kind === 'screen';
      setRemoteParticipants((prev) => {
        const next = new Map(prev);
        const e = next.get(basePid);
        if (!e) return prev;
        if (forceDeleteBase) {
          // Auto-recovery path — scrub everything for this basePid so the
          // next openPcFor creates a brand-new participant entry +
          // MediaStream. Stop any lingering tracks so the consumer's
          // <video> element drops the stale frame.
          for (const s of e.streams) {
            for (const t of s.getTracks()) {
              try { t.stop(); } catch { /* */ }
            }
          }
          if (e.screenStream) {
            for (const t of e.screenStream.getTracks()) {
              try { t.stop(); } catch { /* */ }
            }
          }
          next.delete(basePid);
          firstSeenAtRef.current.delete(basePid);
          return next;
        }
        if (isScreen) {
          // Screen-kind teardown — drop screenStream only.
          if (e.screenStream) {
            next.set(basePid, { ...e, screenStream: undefined });
          }
          // Don't delete the entry if camera-kind streams remain.
          if (!e.screenStream && e.streams.length === 0) {
            next.delete(basePid);
            // Last producer for this peer gone — drop the first-seen
            // entry so a rejoin under the same pid starts a fresh timer
            // (otherwise stale ghost-detection state would linger).
            firstSeenAtRef.current.delete(basePid);
          }
        } else {
          // Camera-kind teardown — drop streams[] (peer left or turned
          // off camera). Stop tracks first so the consumer's <video>
          // element drops the stale frame.
          for (const s of e.streams) {
            for (const t of s.getTracks()) {
              try { t.stop(); } catch { /* */ }
            }
          }
          // If a screenStream is still live, keep the participant entry
          // around so the spotlight tile doesn't vanish.
          if (e.screenStream) {
            next.set(basePid, { ...e, streams: [], streamIds: new Set() });
          } else {
            next.delete(basePid);
            firstSeenAtRef.current.delete(basePid);
          }
        }
        return next;
      });
    };

    // Auto-recovery: when a WHEP PC dies because all receivers'
    // tracks transitioned to `ended` (transient SFU/ICE blip, consumer
    // transport reaped server-side), schedule a fresh openPcFor against
    // the same fullPid IF the producer is still in the discovery
    // snapshot. Capped at RETRY_CAP attempts within RETRY_WINDOW_MS
    // to avoid spamming the SFU when the producer is genuinely wedged.
    //
    // Respects the live epoch (`myEpoch`) + the discovery effect's
    // `cancelled` flag — a scheduled retry that fires AFTER unmount /
    // epoch-bump is a no-op because the epoch we record at schedule
    // time won't match the current effect's epoch any more, and the
    // openPcFor call itself observes `cancelled` at every async
    // boundary.
    const scheduleRetry = (fullPid: string) => {
      if (cancelled) return;
      const kind = knownProducersRef.current.get(fullPid);
      if (!kind) return; // producer truly gone — nothing to retry
      // Budget bookkeeping — start a fresh window if 30s have passed
      // since the first attempt.
      const now = Date.now();
      let budget = retryBudgetRef.current.get(fullPid);
      if (!budget || now - budget.windowStart >= RETRY_WINDOW_MS) {
        budget = { count: 0, windowStart: now };
        retryBudgetRef.current.set(fullPid, budget);
      }
      if (budget.count >= RETRY_CAP) {
        console.info('[remote-pc] retry cap reached — giving up', {
          fullPid,
          attempts: budget.count,
          windowMs: now - budget.windowStart,
        });
        return;
      }
      budget.count += 1;
      // Cancel any pending timer for this pid before scheduling a new one
      // (defensive — shouldn't happen given the cleanupPc serialization
      // but cheap insurance against double-fire).
      const existingTimer = retryTimersRef.current.get(fullPid);
      if (existingTimer) clearTimeout(existingTimer);
      console.info('[remote-pc] scheduling auto-recovery retry', {
        fullPid,
        kind,
        attempt: budget.count,
        delayMs: RETRY_DELAY_MS,
      });
      const timer = setTimeout(() => {
        retryTimersRef.current.delete(fullPid);
        if (cancelled) return;
        // Re-verify the producer is still known + epoch is still live
        // before firing. The effect cleanup bumps cancelled; the auto-
        // recovery should not race past it.
        if (myEpoch !== effectEpochRef.current) return;
        if (!knownProducersRef.current.has(fullPid)) return;
        void openPcFor(fullPid, kind);
      }, RETRY_DELAY_MS);
      retryTimersRef.current.set(fullPid, timer);
    };

    // Publish scheduleRetry through a ref so the visibilitychange
    // handler (which lives in a SEPARATE effect — see below) can drive
    // it without having to re-enter this effect's closure. Reset on
    // cleanup so a fired-after-unmount visibilitychange is a no-op.
    scheduleRetryRef.current = scheduleRetry;

    // Returns true if all receivers on the PC have a track in
    // readyState='ended' (or no tracks at all). Used by both the
    // track-ended handler and the periodic sweep to detect a fully
    // dead consumer transport.
    const isPcFullyDead = (pc: RTCPeerConnection): boolean => {
      const receivers = pc.getReceivers();
      if (receivers.length === 0) return false; // not yet wired up
      return receivers.every((r) => {
        const t = r.track;
        return !t || t.readyState === 'ended';
      });
    };

    const openPcFor = async (fullPid: string, kind: 'camera' | 'screen') => {
      // Don't self-subscribe (defense in depth — our own publishers
      // get broadcast back via the discovery WS).
      if (fullPid === participantId) return;
      if (fullPid === `${participantId}:screen`) return;

      // Idempotent within an epoch — bail if we already have a PC for
      // this pid that was opened by ANY epoch (so a second StrictMode
      // mount in dev doesn't re-open). The cleanup of the older epoch
      // (which fires BEFORE this body runs again in StrictMode) will
      // have already torn down its own PCs + in-flight opens, so
      // anything we see here is genuinely held by the active session.
      if (remoteSubscribersRef.current.has(fullPid)) return;
      // Same idempotency for the in-flight slot — if an older epoch's
      // open is still racing through whepPublish, leave it alone. Its
      // cleanup has already flipped its cancelled flag (we did that in
      // cleanupPc above OR the effect-cleanup loop below) so it will
      // discard its own PC on the next async boundary; meanwhile, no
      // double-open.
      if (inFlightOpensRef.current.has(fullPid)) return;

      // Record first-seen for the BASE pid (so camera + `:screen` for
      // the same publisher share one timestamp — the moment we first
      // committed to subscribing to ANY producer for that peer). Set
      // once per basePid; later kinds for the same peer don't reset it.
      const basePidForSeen = fullPid.split(':')[0] ?? fullPid;
      if (!firstSeenAtRef.current.has(basePidForSeen)) {
        firstSeenAtRef.current.set(basePidForSeen, Date.now());
      }

      // Register the in-flight slot BEFORE any await. The cleanup
      // function (effect-cleanup OR cleanupPc on producer.removed) can
      // flip this object's `cancelled` flag and we'll observe it at
      // every async boundary below. The slot also blocks a second
      // openPcFor for the same pid from racing in.
      const flight = { epoch: myEpoch, cancelled: false };
      inFlightOpensRef.current.set(fullPid, flight);

      const bail = (pc: RTCPeerConnection | null, location: string | null, authToken: string) => {
        if (pc) { try { pc.close(); } catch { /* */ } }
        if (location) void whepTeardown(location, authToken).catch(() => { /* */ });
        // Only drop the in-flight slot if it's still ours — a newer
        // epoch may have already replaced it.
        if (inFlightOpensRef.current.get(fullPid) === flight) {
          inFlightOpensRef.current.delete(fullPid);
        }
      };

      try {
        const authToken = await resolveAuthToken();
        if (flight.cancelled || cancelled) { bail(null, null, authToken); return; }
        const ice = await fetchIceServers(baseUrl);
        if (flight.cancelled || cancelled) { bail(null, null, authToken); return; }
        // Permanent diagnostic — log every parallel WHEP attempt so the
        // next regression is one browser-console scroll away. Pair with
        // SFU-side `WHEP producer found` log lines via fullPid to verify
        // the WHEP reached the server with the right selector.
        console.info('[remote-pc] open', { fullPid, kind, epoch: myEpoch, hasIce: ice.length > 0 });
        const pc = new RTCPeerConnection({ iceServers: ice });
        // Recv-only — both camera + screen publishers are video (+ audio
        // for camera). Add both transceivers; SFU returns inactive lines
        // for kinds the producer doesn't have.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // Track this PC's connectionState in the shared snapshot so the
        // aggregate `connectionState` derived value can pick it up. On
        // 'failed' we also drive the existing scheduleRetry path (the
        // track-ended events sometimes lag the connectionState transition
        // by 100s of ms; this catches the gap so auto-recovery still
        // fires within ~1s of the actual failure instead of waiting on
        // the 5s health sweep).
        pc.addEventListener('connectionstatechange', () => {
          if (cancelled) return;
          const s = pc.connectionState;
          whepConnStatesRef.current.set(fullPid, s);
          setWhepHealthTick((n) => n + 1);
          if (s === 'failed' && knownProducersRef.current.has(fullPid)) {
            console.info('[remote-pc] connectionState=failed — triggering recovery', { fullPid });
            cleanupPc(fullPid, /* forceDeleteBase */ true);
            scheduleRetry(fullPid);
          }
        });

        pc.addEventListener('track', (ev) => {
          if (cancelled) return;
          const track = ev.track;
          const basePid = fullPid.split(':')[0] ?? fullPid;
          console.info('[remote-pc] track', {
            fullPid,
            basePid,
            kind,
            trackKind: track.kind,
            streamId: ev.streams[0]?.id ?? null,
          });

          setRemoteParticipants((prev) => {
            const next = new Map(prev);
            const existing = next.get(basePid) ?? {
              streams: [] as MediaStream[],
              streamIds: new Set<string>(),
            };

            if (kind === 'screen') {
              // Screen-kind track → goes into the dedicated
              // screenStream slot so consumers can route it to a
              // spotlight independently from the camera tile.
              let screen = existing.screenStream;
              if (!screen) {
                screen = new MediaStream();
              }
              if (!screen.getTracks().some((t) => t.id === track.id)) {
                screen.addTrack(track);
              }
              next.set(basePid, { ...existing, screenStream: screen });
            } else {
              // Camera-kind track → goes into streams[]. Dedup by
              // track id (onTrack can fire twice in some browsers
              // during renegotiation). React StrictMode also opens
              // two WHEP PCs in dev — when the second PC delivers its
              // own copy of the audio+video tracks, we MUST evict the
              // older same-kind track or the <video> element ends up
              // bound to a stale (muted forever) receiver and the tile
              // shows the avatar fallback even though video is flowing.
              let stream = existing.streams[0];
              if (!stream) {
                stream = new MediaStream();
                existing.streams = [stream];
                existing.streamIds = new Set([stream.id]);
              }
              if (!stream.getTracks().some((t) => t.id === track.id)) {
                // Evict same-kind duplicates first so we keep exactly
                // one audio + one video. Stop them so the dead receiver
                // releases its resources.
                for (const t of stream.getTracks()) {
                  if (t.kind === track.kind && t.id !== track.id) {
                    try { t.stop(); } catch { /* */ }
                    try { stream.removeTrack(t); } catch { /* */ }
                  }
                }
                stream.addTrack(track);
              }
              next.set(basePid, { ...existing });
            }
            return next;
          });

          // Finding 6 — only tear down the PC when ALL receivers' tracks
          // have ended. A single audio glitch (mic device swap, codec
          // failure) would previously kill the whole PC and drop the
          // still-live video tile. Now we inspect every receiver: if
          // any track is still live, we leave the PC alone and let the
          // SFU drive the eventual teardown via producer.removed.
          //
          // All-tracks-ended path (sticky-stale-state fix): when every
          // receiver is dead the consumer transport was reaped by the
          // SFU mid-call (transient ICE/DTLS blip). Fully scrub the
          // participant entry via forceDeleteBase so the avatar fallback
          // doesn't stick on a stale stream, then schedule an auto-
          // recovery retry — the producer is likely still alive on the
          // SFU and a fresh openPcFor will rebind the tile within ~1s.
          track.addEventListener('ended', () => {
            const current = remoteSubscribersRef.current.get(fullPid);
            if (!current) return;
            const stillLive = current.pc.getReceivers().some((r) => {
              const t = r.track;
              return !!t && t.readyState === 'live';
            });
            if (stillLive) {
              console.info('[remote-pc] track ended — keeping PC (other tracks live)', {
                fullPid,
                endedKind: track.kind,
              });
              return;
            }
            console.info('[remote-pc] all tracks ended — full scrub + retry', {
              fullPid,
              endedKind: track.kind,
            });
            cleanupPc(fullPid, /* forceDeleteBase */ true);
            scheduleRetry(fullPid);
          }, { once: true });
        });

        const offer = await pc.createOffer();
        if (flight.cancelled || cancelled) { bail(pc, null, authToken); return; }
        await pc.setLocalDescription(offer);
        if (flight.cancelled || cancelled) { bail(pc, null, authToken); return; }
        await waitForIceGather(pc, 3000);
        if (flight.cancelled || cancelled) { bail(pc, null, authToken); return; }
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error('failed to generate local SDP');

        const { answerSdp, location } = await whepPublish({
          channelArn,
          offerSdp: sdp,
          authToken,
          // Target THIS publisher specifically — without it the SFU's
          // first-match path returns the FIRST publisher of that kind
          // on the channel, which is the original 3+ person bug.
          participantId: fullPid,
          excludeParticipantId: undefined,
          baseUrl,
        });
        if (flight.cancelled || cancelled) { bail(pc, location, authToken); return; }
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        if (flight.cancelled || cancelled) { bail(pc, location, authToken); return; }
        if (!location) {
          // No Location header — server didn't issue a WHEP resource
          // URL, so we can't DELETE on teardown. Bail with cleanup
          // (the PC stays connected for the session lifetime; consumer
          // gets the track but we can't release the SFU consumer
          // cleanly). Should never happen with a spec-compliant server.
          bail(pc, null, authToken);
          return;
        }
        // If a DIFFERENT epoch managed to install a PC for the same
        // pid while we were awaiting (shouldn't happen given the
        // in-flight slot, but defense in depth), close the older entry
        // before we overwrite. Same epoch / our own slot → just install.
        const existingEntry = remoteSubscribersRef.current.get(fullPid);
        if (existingEntry && existingEntry.epoch !== myEpoch) {
          console.info('[remote-pc] superseding older-epoch PC', {
            fullPid,
            oldEpoch: existingEntry.epoch,
            newEpoch: myEpoch,
          });
          try { existingEntry.pc.close(); } catch { /* */ }
          void whepTeardown(existingEntry.resourceUrl, existingEntry.authToken).catch(() => { /* */ });
        }
        remoteSubscribersRef.current.set(fullPid, {
          pc,
          resourceUrl: location,
          authToken,
          kind,
          epoch: myEpoch,
        });
        if (inFlightOpensRef.current.get(fullPid) === flight) {
          inFlightOpensRef.current.delete(fullPid);
        }
      } catch (e: unknown) {
        // Cleanup any partial state — next discovery tick may retry.
        const entry = remoteSubscribersRef.current.get(fullPid);
        if (entry && entry.epoch === myEpoch) {
          try { entry.pc.close(); } catch { /* */ }
          remoteSubscribersRef.current.delete(fullPid);
        }
        if (inFlightOpensRef.current.get(fullPid) === flight) {
          inFlightOpensRef.current.delete(fullPid);
        }
        // Log so race conditions (WHIP hadn't completed yet when we
        // raced the producer.added) are debuggable. info-level — a
        // retry will follow once the next event lands.
        const msg = e instanceof Error ? e.message : String(e);
        console.info('[remote-pc] open failed', { fullPid, kind, epoch: myEpoch, err: msg });
      }
    };

    const wsUrl = baseUrl.replace(/^http/, 'ws') +
      `/api/channels/${encodeURIComponent(channelArn)}/ws`;

    // Reconnect ladder — exponential backoff capped at 10s, reset on
    // every successful open (Finding 7 — discovery WS had NO reconnect
    // path; one transient blip silently killed all producer events for
    // the rest of the call).
    const RECONNECT_MAX_MS = 10_000;
    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(RECONNECT_MAX_MS, 250 * Math.pow(2, reconnectAttempt));
      reconnectAttempt += 1;
      console.info('[remote-discovery] scheduling reconnect', {
        attempt: reconnectAttempt,
        delayMs: delay,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        connectWs();
      }, delay);
    };

    const connectWs = () => {
      if (cancelled) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        // Construction failure — schedule a retry; otherwise the call
        // is permanently blind to producer.added/removed events.
        scheduleReconnect();
        return;
      }
      ws = socket;
      socket.addEventListener('open', () => {
        if (cancelled) {
          // StrictMode-fast cleanup already ran; close immediately so we
          // don't dangle an open WS the next effect can't see.
          try { socket.close(); } catch { /* */ }
          return;
        }
        reconnectAttempt = 0; // successful open resets the backoff
        void (async () => {
          try {
            const token = await resolveAuthToken();
            if (cancelled) return;
            socket.send(JSON.stringify({
              type: 'subscribe-channel',
              channelArn,
              participantId,
              token,
            }));
          } catch { /* token resolver threw — discovery silent, parallel WHEP camera+screen won't surface */ }
        })();
      });
      socket.addEventListener('message', (ev) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(ev.data);
          const pid = msg?.participantId;
          if (typeof pid !== 'string') return;
          // Skip self — our own producers get echoed back here.
          if (pid === participantId) return;
          if (pid === `${participantId}:screen`) return;

          const isScreen = pid.endsWith(':screen');
          const kind: 'camera' | 'screen' = isScreen ? 'screen' : 'camera';

          // Permanent diagnostic — every remote producer event surfaces
          // here so future regressions in the discovery WS wiring are
          // visible without re-instrumenting. info-level since these
          // fire ~once per peer join / camera-toggle / screen-share-
          // toggle (rare enough to not flood the console).
          console.info('[remote-discovery] event', {
            type: msg.type,
            participantId: pid,
            mediaKind: msg.kind,
            ourKind: kind,
          });

          if (msg.type === 'producer.added') {
            // Persist in the discovery snapshot so the all-tracks-ended
            // auto-recovery path knows the producer is still live on the
            // SFU. Keyed by fullPid → kind (matches the openPcFor arg).
            knownProducersRef.current.set(pid, kind);
            // Only one PC per fullPid regardless of media kind — both
            // camera audio+video producers on the same publisher map to
            // the same PC (the SFU's WHEP answer carries both tracks).
            // openPcFor is idempotent (epoch-keyed + in-flight slot).
            void openPcFor(pid, kind);
          } else if (msg.type === 'producer.removed') {
            // Drop from the discovery snapshot first so any pending
            // auto-recovery retry sees the producer as gone and bails.
            knownProducersRef.current.delete(pid);
            // Clear retry budget + cancel any pending timer — the
            // producer is genuinely gone, not transient.
            retryBudgetRef.current.delete(pid);
            const pendingTimer = retryTimersRef.current.get(pid);
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(pid);
            }
            // Only tear down when ALL media kinds for this publisher
            // are gone. The SFU emits producer.removed once per kind,
            // so on a camera+audio publisher leaving we'll see two
            // events; for screen-share stopping we'll see one (video-
            // only). Heuristic: tear down on the first event — the SFU
            // will close the second producer cleanly via PC negotiation
            // (tracks transition to `ended`). This matches the screen-
            // share path's original behavior.
            cleanupPc(pid);
          }
        } catch { /* malformed frame — ignore */ }
      });
      socket.addEventListener('close', () => {
        if (cancelled) return;
        // Unexpected close — reconnect. We don't try to dedupe vs.
        // intentional close because cancelled-guard above covers that.
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        // 'error' is followed by 'close' per the WS spec — let close
        // schedule the reconnect to avoid double-scheduling.
      });
    };

    connectWs();

    // Periodic stream-health sweep — every 5s walk every WHEP PC owned
    // by THIS epoch and check if all receivers' tracks are ended. The
    // track-ended event handler covers the happy path but events can be
    // missed (browser bugs, race with .close()) — the sweep is a
    // belt-and-suspenders backstop so a stuck "avatar fallback forever"
    // tile self-heals within at most 5s + RETRY_DELAY_MS.
    const HEALTH_SWEEP_MS = 5_000;
    const healthSweepTimer = setInterval(() => {
      if (cancelled) return;
      // Snapshot keys first — cleanupPc mutates the map.
      const keys = Array.from(remoteSubscribersRef.current.keys());
      for (const k of keys) {
        const entry = remoteSubscribersRef.current.get(k);
        if (!entry || entry.epoch !== myEpoch) continue;
        if (isPcFullyDead(entry.pc)) {
          console.info('[remote-pc] sweep — PC fully dead, scrubbing + retry', {
            fullPid: k,
            kind: entry.kind,
          });
          cleanupPc(k, /* forceDeleteBase */ true);
          scheduleRetry(k);
        }
      }
    }, HEALTH_SWEEP_MS);

    return () => {
      cancelled = true;
      // Drop the published scheduleRetry pointer so the visibilitychange
      // handler can't fire it against this torn-down closure. The next
      // effect mount (StrictMode remount) will repopulate.
      scheduleRetryRef.current = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearInterval(healthSweepTimer);
      // Cancel + drop every pending auto-recovery retry timer. Without
      // this a retry scheduled milliseconds before unmount could fire
      // openPcFor against a torn-down effect (epoch check catches it,
      // but cancelling the timer is the obviously-correct path).
      for (const [pid, t] of retryTimersRef.current.entries()) {
        clearTimeout(t);
        retryTimersRef.current.delete(pid);
      }
      // Cancel every in-flight open keyed to this epoch BEFORE closing
      // anything else — they may still be racing toward
      // remoteSubscribersRef.set().
      for (const [pid, flight] of inFlightOpensRef.current.entries()) {
        if (flight.epoch === myEpoch) {
          flight.cancelled = true;
          inFlightOpensRef.current.delete(pid);
        }
      }
      try { ws?.close(); } catch { /* */ }
      // Snapshot keys; cleanup mutates the map. Only tear down PCs
      // owned by THIS epoch — a newer epoch (StrictMode remount) may
      // already have installed its own PCs by the time this cleanup
      // runs, and we must not nuke them.
      const keys = Array.from(remoteSubscribersRef.current.keys());
      for (const k of keys) {
        const entry = remoteSubscribersRef.current.get(k);
        if (entry && entry.epoch === myEpoch) cleanupPc(k);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelArn, participantId, opts.baseUrl]);

  // Visibilitychange — backgrounded tabs throttle setInterval to 1Hz on
  // Chrome, and the SFU's consumer-transport reaper may close our
  // WHEP PCs before the periodic health sweep (5s interval) can fire.
  // When the tab returns to visible we proactively check every WHEP PC:
  // any in `disconnected` / `failed` get scheduled for the same auto-
  // recovery scheduleRetry path used by the all-tracks-ended handler
  // (so the existing 3-retry-in-30s budget still applies — visibility
  // recovery isn't a budget bypass).
  //
  // The publisher's PC is handled by useLVSPublisher's own
  // `connectionstatechange='failed'` → `scheduleReconnect` path; we
  // don't need to drive that ourselves. Same for live PCs that
  // genuinely survived the background period — we never touch them.
  useEffect(() => {
    if (typeof document === 'undefined') return; // SSR / Node tests
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      // Snapshot keys first — we mutate the ref below.
      const keys = Array.from(remoteSubscribersRef.current.keys());
      let recoveredAny = false;
      for (const k of keys) {
        const entry = remoteSubscribersRef.current.get(k);
        if (!entry) continue;
        const s = entry.pc.connectionState;
        if (s === 'disconnected' || s === 'failed') {
          console.info('[remote-pc] visibility recovery — PC unhealthy, scrubbing + retry', {
            fullPid: k,
            kind: entry.kind,
            connectionState: s,
          });
          // Close the PC ourselves + schedule a retry via the published
          // ref. When openPcFor eventually runs it'll see no entry in
          // remoteSubscribersRef and open a fresh PC.
          try { entry.pc.close(); } catch { /* */ }
          remoteSubscribersRef.current.delete(k);
          whepConnStatesRef.current.delete(k);
          scheduleRetryRef.current?.(k);
          recoveredAny = true;
        }
      }
      if (recoveredAny) setWhepHealthTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // toggleMute / toggleCamera flip `enabled` on the local tracks. No
  // SDP renegotiation — the publisher's transceivers stay live; we just
  // null the outbound media. Bump localFlagsTick so participants memo
  // recomputes hasAudio/hasVideo.
  const toggleMute = useCallback((muted: boolean) => {
    const s = localStreamRef.current;
    if (!s) return;
    for (const t of s.getAudioTracks()) t.enabled = !muted;
    setLocalFlagsTick((n) => n + 1);
  }, []);

  const toggleCamera = useCallback((off: boolean) => {
    const s = localStreamRef.current;
    if (!s) return;
    for (const t of s.getVideoTracks()) t.enabled = !off;
    setLocalFlagsTick((n) => n + 1);
  }, []);

  const stopScreenShare = useCallback(() => {
    // Clearing localScreenStream causes the dedicated screenPublisher
    // to teardown its WHIP transport (DELETE), which fires
    // `producer.removed` to subscribers. The camera publisher is
    // untouched. No track-swap, no restore step.
    const track = screenShareTrackRef.current;
    if (track) {
      try { track.stop(); } catch { /* ignore */ }
      screenShareTrackRef.current = null;
    }
    setLocalScreenStream(null);
    setIsScreenSharing(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = display.getVideoTracks()[0];
      if (!videoTrack) {
        display.getTracks().forEach((t) => t.stop());
        return;
      }
      screenShareTrackRef.current = videoTrack;

      // Multi-stream design. Setting `localScreenStream` causes the
      // dedicated screenPublisher (configured above) to autoStart a
      // SECOND WHIP transport with `participantId: ${pid}:screen`.
      // The camera publisher stays untouched — remote viewers see BOTH
      // the sharer's camera AND their screen at the same time.
      setLocalScreenStream(display);
      setIsScreenSharing(true);

      // Browser-chrome "Stop sharing" button fires `ended` on the
      // captured video track. Mirror our stopScreenShare path so the
      // screenPublisher tears down cleanly.
      videoTrack.addEventListener(
        'ended',
        () => {
          if (screenShareTrackRef.current === videoTrack) {
            screenShareTrackRef.current = null;
            setLocalScreenStream(null);
            setIsScreenSharing(false);
          }
        },
        { once: true },
      );
    } catch (e) {
      const err = e as DOMException;
      // User cancelled the picker — not an error.
      if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Screen share failed: ${msg}`);
    }
  }, []);

  /**
   * Acquire camera + re-publish with audio + video. Used when the
   * call started audio-only and the user wants to turn video on. The
   * existing audio track is preserved (taken from the current local
   * stream); only the video track is freshly captured.
   */
  const enableCamera = useCallback(async () => {
    const existing = localStreamRef.current;
    const alreadyHasVideo = existing?.getVideoTracks().some((t) => t.readyState === 'live');
    if (alreadyHasVideo) return; // idempotent
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const videoTrack = camStream.getVideoTracks()[0];
      if (!videoTrack) {
        camStream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Build the new combined stream: keep existing audio (if any) +
      // the new video track.
      const merged = new MediaStream();
      if (existing) {
        for (const t of existing.getAudioTracks()) merged.addTrack(t);
      }
      merged.addTrack(videoTrack);
      localStreamRef.current = merged;
      cameraStreamRef.current = merged;
      setLocalStream(merged);
      await publisher.republish(merged);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to enable camera: ${msg}`);
    }
  }, [publisher]);

  /**
   * Drop the camera track + re-publish audio-only. Used to downgrade
   * mid-call. Stops the video track to release the device + LED.
   */
  const disableCamera = useCallback(async () => {
    const existing = localStreamRef.current;
    if (!existing) return;
    const videoTracks = existing.getVideoTracks();
    if (videoTracks.length === 0) return; // already audio-only
    // Stop the video tracks (releases the device + camera LED).
    videoTracks.forEach((t) => { try { t.stop(); } catch { /* */ } });
    // Build audio-only stream from remaining audio tracks.
    const audioOnly = new MediaStream();
    for (const t of existing.getAudioTracks()) audioOnly.addTrack(t);
    localStreamRef.current = audioOnly;
    cameraStreamRef.current = audioOnly;
    setLocalStream(audioOnly);
    try {
      await publisher.republish(audioOnly);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to disable camera: ${msg}`);
    }
  }, [publisher]);

  /**
   * Unified camera-toggle that survives a `.stop()`'d (ended) track.
   *
   * Three cases:
   *   1. Track is live, just disabled → flip `enabled` back on. Cheapest
   *      path; equivalent to `toggleCamera(false)`. Local preview lights
   *      up immediately; peers' inbound video resumes from black/freeze.
   *   2. Track is live, currently enabled, caller passed `on=false` →
   *      flip `enabled = false`. Same as `toggleCamera(true)`. We
   *      DELIBERATELY do NOT `.stop()` here — leaving the track live
   *      means the next setCameraEnabled(true) is the cheap case (1)
   *      with no getUserMedia permission re-prompt.
   *   3. No video track at all, or the only video track is `ended` /
   *      stopped (camera was hard-released earlier, e.g. by an upstream
   *      consumer or by `disableCamera()`) → re-run getUserMedia for
   *      video, swap onto the existing video RTCRtpSender via
   *      `publisher.replaceStream()` (RTCRtpSender.replaceTrack under
   *      the hood, no WHIP renegotiation). Peers see the producer keep
   *      flowing — no `producer.removed` / `producer.added` flicker.
   *      The localStream reference is updated so the UI's
   *      `<video srcObject={localStream}>` picks up the new track.
   *
   * Guarded by `cameraToggleInFlightRef` so a double-tap during the
   * re-acquire path doesn't kick off two concurrent getUserMedia calls.
   *
   * Falls back to `enableCamera()` (full re-WHIP) when no video sender
   * exists yet on the publisher — that happens when the call started
   * audio-only and there's no video transceiver to replaceTrack onto.
   */
  const setCameraEnabled = useCallback(async (on: boolean) => {
    if (cameraToggleInFlightRef.current) return;
    const existing = localStreamRef.current;
    const videoTracks = existing ? existing.getVideoTracks() : [];
    const liveVideo = videoTracks.find((t) => t.readyState === 'live');

    // Case 1 + 2: a live track exists — just flip enabled. No async work.
    if (liveVideo) {
      for (const t of videoTracks) {
        if (t.readyState === 'live') t.enabled = on;
      }
      setLocalFlagsTick((n) => n + 1);
      return;
    }

    // Disabling and there's no live track anyway → nothing to do.
    if (!on) {
      setLocalFlagsTick((n) => n + 1);
      return;
    }

    // Case 3: re-acquire + replaceTrack.
    cameraToggleInFlightRef.current = true;
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const videoTrack = camStream.getVideoTracks()[0];
      if (!videoTrack) {
        camStream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Drop any prior ended video tracks from the merged stream we're
      // about to publish + show locally.
      const merged = new MediaStream();
      if (existing) {
        for (const t of existing.getAudioTracks()) merged.addTrack(t);
      }
      merged.addTrack(videoTrack);
      localStreamRef.current = merged;
      cameraStreamRef.current = merged;
      setLocalStream(merged);

      // Try the cheap path first: swap onto the existing video sender.
      // replaceStream() warns + skips when no video sender exists; in
      // that case fall back to a full re-WHIP via republish() so the
      // SFU actually gets a video producer.
      try {
        await publisher.replaceStream(merged);
      } catch {
        // replaceStream throws when called before start() — fall through
        // to republish which handles the no-PC case internally.
        await publisher.republish(merged);
      }
      setLocalFlagsTick((n) => n + 1);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to enable camera: ${msg}`);
    } finally {
      cameraToggleInFlightRef.current = false;
    }
  }, [publisher]);

  const leave = useCallback(() => {
    // Idempotent — a second leave() (StrictMode double-invoke, double-
    // bound onClick, leave+unmount race) is a no-op rather than a
    // thrash that re-fires setState on a torn-down tree.
    if (leftRef.current) return;
    leftRef.current = true;

    // Stop the screen-share track first so its `ended` handler doesn't
    // race the publisher teardown.
    const screen = screenShareTrackRef.current;
    if (screen) {
      try { screen.stop(); } catch { /* ignore */ }
      screenShareTrackRef.current = null;
    }
    setIsScreenSharing(false);

    void publisher.stop();

    // Cancel every in-flight openPcFor so the racing async bodies
    // discard their PCs at the next await-boundary check instead of
    // installing entries into remoteSubscribersRef AFTER we just
    // cleared it.
    for (const [pid, flight] of inFlightOpensRef.current.entries()) {
      flight.cancelled = true;
      inFlightOpensRef.current.delete(pid);
    }

    // Tear down every parallel WHEP PC + DELETE the SFU resources. The
    // discovery WS effect's cleanup runs on unmount; for an in-call
    // leave() we need to do it eagerly here so the SFU drops us before
    // peers see a stale producer entry.
    const keys = Array.from(remoteSubscribersRef.current.keys());
    for (const k of keys) {
      const entry = remoteSubscribersRef.current.get(k);
      if (!entry) continue;
      try { entry.pc.close(); } catch { /* */ }
      void whepTeardown(entry.resourceUrl, entry.authToken).catch(() => { /* */ });
      remoteSubscribersRef.current.delete(k);
    }

    const s = localStreamRef.current;
    if (s) {
      s.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    localStreamRef.current = null;
    cameraStreamRef.current = null;
    setLocalStream(null);
    setLocalScreenStream(null);
    setRemoteParticipants(new Map());
    // Wipe ghost-producer state so a subsequent rejoin starts fresh.
    firstSeenAtRef.current.clear();
    // Wipe discovery snapshot + auto-recovery retry budget so a
    // subsequent rejoin doesn't carry over stale "producer is alive"
    // beliefs (the SFU is going to re-broadcast producer.added on
    // resubscribe anyway).
    knownProducersRef.current.clear();
    retryBudgetRef.current.clear();
    for (const [pid, t] of retryTimersRef.current.entries()) {
      clearTimeout(t);
      retryTimersRef.current.delete(pid);
    }
  }, [publisher]);

  // Unmount cleanup: same as leave(), but the publisher hook also runs
  // its own teardown — so we only release local tracks here to avoid
  // double-stopping the WHIP resources. The discovery WS effect handles
  // tearing down parallel PCs on unmount.
  useEffect(() => {
    return () => {
      const screen = screenShareTrackRef.current;
      if (screen) {
        try { screen.stop(); } catch { /* ignore */ }
      }
      const s = localStreamRef.current;
      if (s) {
        s.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
      }
      localStreamRef.current = null;
      cameraStreamRef.current = null;
      screenShareTrackRef.current = null;
    };
  }, []);

  // Surface error from publisher leg. Per-remote WHEP failures are
  // recoverable (next producer.added retries) and shouldn't blow up the
  // UI — log only.
  const composedError = error ?? publisher.error ?? null;

  // Build the public participants list. Local user first; remotes
  // appended in insertion order (Map preserves it).
  const participants = useMemo<HangoutParticipant[]>(() => {
    const list: HangoutParticipant[] = [];

    // Local participant — present whenever we have a participantId,
    // even before media lands. The streams[] is empty until
    // getUserMedia resolves; consumers can render a placeholder.
    if (participantId) {
      const localStreams: MediaStream[] = [];
      if (localStreamRef.current) localStreams.push(localStreamRef.current);
      const flags = computeMediaFlags(localStreams);
      list.push({
        participantId,
        displayName: userId,
        userId,
        isLocal: true,
        streams: localStreams,
        screenStream: localScreenStream ?? undefined,
        hasAudio: flags.hasAudio,
        hasVideo: flags.hasVideo,
      });
    }

    // Remotes.
    for (const [pid, entry] of remoteParticipants.entries()) {
      // computeMediaFlags must consider the camera streams AND the
      // dedicated parallel-WHEP screenStream — a screen-only peer (camera
      // off, sharing) needs hasVideo=true so consumers don't render them
      // as a "no video" placeholder. Without including screenStream here,
      // a camera-off sharer reads as hasVideo=false even though their
      // screen track is live.
      const flagSources = entry.screenStream
        ? [...entry.streams, entry.screenStream]
        : entry.streams;
      const flags = computeMediaFlags(flagSources);
      // Ghost-producer annotations. firstSeenAt is set on first openPcFor
      // for this BASE pid; subscriberMs is derived against `nowTick` so
      // it advances at ~1s resolution without callers managing a timer.
      // Fall back to `nowTick` if the ref is somehow missing the entry
      // (shouldn't happen — openPcFor runs before track-onTrack populates
      // remoteParticipants — but the fallback keeps subscriberMs=0 rather
      // than NaN so consumer filters don't accidentally hide brand-new
      // tiles on a missing-ref race).
      const firstSeenAt = firstSeenAtRef.current.get(pid) ?? nowTick;
      const subscriberMs = Math.max(0, nowTick - firstSeenAt);
      list.push({
        participantId: pid,
        displayName: pid, // falls back to participantId — no name channel from SFU
        userId: pid,
        isLocal: false,
        streams: entry.streams,
        // Expose screenStream so consumers (HangoutOverlay spotlight)
        // can route the parallel-WHEP screen track independently.
        screenStream: entry.screenStream,
        hasAudio: flags.hasAudio,
        hasVideo: flags.hasVideo,
        firstSeenAt,
        subscriberMs,
      });
    }

    return list;
    // localFlagsTick + localStream + localScreenStream included so
    // flag changes / screen-share toggles recompute. nowTick drives the
    // ghost-producer subscriberMs recomputation every 1s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId, userId, remoteParticipants, localStream, localScreenStream, localFlagsTick, nowTick]);

  // isJoined: publisher live is the primary signal — we've successfully
  // pushed bytes to the SFU. Parallel WHEPs may legitimately be absent
  // when alone in the lobby (no remote producers yet), so we don't gate
  // on them. This matches the legacy useHangoutEmbed UX where the UI
  // mounts as soon as Stage joined, regardless of who was already there.
  const isJoined = publisher.phase === 'live';

  // Aggregate transport health. Order of precedence (worst → best):
  //   1. publisher.phase='error' → 'failed' (retry budget exhausted)
  //   2. publisher.phase='reconnecting' OR any WHEP in
  //      disconnected/failed → 'reconnecting'
  //   3. publisher.phase='live' → 'connected'
  //   4. publisher.phase='connecting' → 'connecting'
  //   5. otherwise → 'idle'
  // whepHealthTick is in deps so the memo re-evaluates whenever a WHEP
  // PC's connectionState changes.
  const connectionState = useMemo<HangoutConnectionState>(() => {
    if (publisher.phase === 'error') return 'failed';
    let anyWhepUnhealthy = false;
    for (const s of whepConnStatesRef.current.values()) {
      if (s === 'disconnected' || s === 'failed') {
        anyWhepUnhealthy = true;
        break;
      }
    }
    if (publisher.phase === 'reconnecting' || anyWhepUnhealthy) return 'reconnecting';
    if (publisher.phase === 'live') return 'connected';
    if (publisher.phase === 'connecting') return 'connecting';
    return 'idle';
    // whepHealthTick is the re-render trigger; the ref read above
    // captures the latest map values when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publisher.phase, whepHealthTick]);

  // Camera state: did the local participant actually publish a live
  // video track? Drives the in-call "Turn on camera" button visibility.
  const isCameraEnabled = useMemo(
    () => !!localStream && localStream.getVideoTracks().some((t) => t.readyState === 'live'),
    [localStream],
  );

  return {
    participants,
    isJoined,
    isScreenSharing,
    isCameraEnabled,
    error: composedError,
    connectionState,
    toggleMute,
    toggleCamera,
    enableCamera,
    disableCamera,
    setCameraEnabled,
    startScreenShare,
    stopScreenShare,
    leave,
  };
}
