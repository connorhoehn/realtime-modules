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
}

export interface UseLVSHangoutResult {
  participants: HangoutParticipant[];
  isJoined: boolean;
  isScreenSharing: boolean;
  isCameraEnabled: boolean;
  error: string | null;
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

  // Parallel WHEP PCs for EVERY remote producer, keyed by the producer's
  // full participantId. For a peer named `hank` you'll see two entries
  // when they're sharing: `hank` (camera kind) + `hank:screen` (screen
  // kind). Managed imperatively from the producer-discovery WS effect
  // below — outside React's render path because hooks can't be called
  // in loops, and we need N concurrent PCs at runtime.
  const remoteSubscribersRef = useRef<Map<string, {
    pc: RTCPeerConnection;
    resourceUrl: string;
    authToken: string;
    kind: 'camera' | 'screen';
  }>>(new Map());
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

    let cancelled = false;
    let ws: WebSocket | null = null;

    const cleanupPc = (fullPid: string) => {
      const entry = remoteSubscribersRef.current.get(fullPid);
      if (!entry) return;
      // Permanent diagnostic — paired with the open log so we can grep
      // open/close transitions when remote tiles inevitably regress.
      console.info('[remote-pc] close', { fullPid, kind: entry.kind });
      try { entry.pc.close(); } catch { /* ignore */ }
      // Fire-and-forget DELETE — best effort.
      void whepTeardown(entry.resourceUrl, entry.authToken).catch(() => { /* */ });
      remoteSubscribersRef.current.delete(fullPid);
      const basePid = fullPid.split(':')[0] ?? fullPid;
      const isScreen = entry.kind === 'screen';
      setRemoteParticipants((prev) => {
        const next = new Map(prev);
        const e = next.get(basePid);
        if (!e) return prev;
        if (isScreen) {
          // Screen-kind teardown — drop screenStream only.
          if (e.screenStream) {
            next.set(basePid, { ...e, screenStream: undefined });
          }
          // Don't delete the entry if camera-kind streams remain.
          if (!e.screenStream && e.streams.length === 0) {
            next.delete(basePid);
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
          }
        }
        return next;
      });
    };

    const openPcFor = async (fullPid: string, kind: 'camera' | 'screen') => {
      // Idempotent — bail if already subscribed.
      if (remoteSubscribersRef.current.has(fullPid)) return;
      // Don't self-subscribe (defense in depth — our own publishers
      // get broadcast back via the discovery WS).
      if (fullPid === participantId) return;
      if (fullPid === `${participantId}:screen`) return;

      try {
        const authToken = await resolveAuthToken();
        const ice = await fetchIceServers(baseUrl);
        // Permanent diagnostic — log every parallel WHEP attempt so the
        // next regression is one browser-console scroll away. Pair with
        // SFU-side `WHEP producer found` log lines via fullPid to verify
        // the WHEP reached the server with the right selector.
        console.info('[remote-pc] open', { fullPid, kind, hasIce: ice.length > 0 });
        const pc = new RTCPeerConnection({ iceServers: ice });
        // Recv-only — both camera + screen publishers are video (+ audio
        // for camera). Add both transceivers; SFU returns inactive lines
        // for kinds the producer doesn't have.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

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
              // during renegotiation).
              let stream = existing.streams[0];
              if (!stream) {
                stream = new MediaStream();
                existing.streams = [stream];
                existing.streamIds = new Set([stream.id]);
              }
              if (!stream.getTracks().some((t) => t.id === track.id)) {
                stream.addTrack(track);
              }
              next.set(basePid, { ...existing });
            }
            return next;
          });

          // Drop the participant entry when the track ends. We tear the
          // whole PC down — the SFU emitted producer.removed which the
          // discovery WS handler will also catch, but track-ended is
          // the more reliable signal (no WS dependency).
          track.addEventListener('ended', () => cleanupPc(fullPid), { once: true });
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGather(pc, 3000);
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
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        if (cancelled) {
          try { pc.close(); } catch { /* */ }
          if (location) void whepTeardown(location, authToken).catch(() => { /* */ });
          return;
        }
        if (!location) {
          // No Location header — server didn't issue a WHEP resource
          // URL, so we can't DELETE on teardown. Bail with cleanup
          // (the PC stays connected for the session lifetime; consumer
          // gets the track but we can't release the SFU consumer
          // cleanly). Should never happen with a spec-compliant server.
          try { pc.close(); } catch { /* */ }
          return;
        }
        remoteSubscribersRef.current.set(fullPid, {
          pc,
          resourceUrl: location,
          authToken,
          kind,
        });
      } catch (e: unknown) {
        // Cleanup any partial state — next discovery tick may retry.
        const entry = remoteSubscribersRef.current.get(fullPid);
        if (entry) {
          try { entry.pc.close(); } catch { /* */ }
          remoteSubscribersRef.current.delete(fullPid);
        }
        // Log so race conditions (WHIP hadn't completed yet when we
        // raced the producer.added) are debuggable. info-level — a
        // retry will follow once the next event lands.
        const msg = e instanceof Error ? e.message : String(e);
        console.info('[remote-pc] open failed', { fullPid, kind, err: msg });
      }
    };

    const wsUrl = baseUrl.replace(/^http/, 'ws') +
      `/api/channels/${encodeURIComponent(channelArn)}/ws`;
    try {
      ws = new WebSocket(wsUrl);
      // Subscribe-channel handshake — stageWsServer only delivers
      // producer events (including the REPLAY of existing publishers
      // for late-joiners) after receiving this frame.
      ws.addEventListener('open', () => {
        void (async () => {
          try {
            const token = await resolveAuthToken();
            ws?.send(JSON.stringify({
              type: 'subscribe-channel',
              channelArn,
              participantId,
              token,
            }));
          } catch { /* token resolver threw — discovery silent, parallel WHEP camera+screen won't surface */ }
        })();
      });
      ws.addEventListener('message', (ev) => {
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
            // Only one PC per fullPid regardless of media kind — both
            // camera audio+video producers on the same publisher map to
            // the same PC (the SFU's WHEP answer carries both tracks).
            // openPcFor is idempotent.
            void openPcFor(pid, kind);
          } else if (msg.type === 'producer.removed') {
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
    } catch { /* WS construction failure — silent fail-open */ }

    return () => {
      cancelled = true;
      try { ws?.close(); } catch { /* */ }
      // Snapshot keys; cleanup mutates the map.
      const keys = Array.from(remoteSubscribersRef.current.keys());
      for (const k of keys) cleanupPc(k);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelArn, participantId, opts.baseUrl]);

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

  const leave = useCallback(() => {
    // Stop the screen-share track first so its `ended` handler doesn't
    // race the publisher teardown.
    const screen = screenShareTrackRef.current;
    if (screen) {
      try { screen.stop(); } catch { /* ignore */ }
      screenShareTrackRef.current = null;
    }
    setIsScreenSharing(false);

    void publisher.stop();

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
      });
    }

    return list;
    // localFlagsTick + localStream + localScreenStream included so
    // flag changes / screen-share toggles recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId, userId, remoteParticipants, localStream, localScreenStream, localFlagsTick]);

  // isJoined: publisher live is the primary signal — we've successfully
  // pushed bytes to the SFU. Parallel WHEPs may legitimately be absent
  // when alone in the lobby (no remote producers yet), so we don't gate
  // on them. This matches the legacy useHangoutEmbed UX where the UI
  // mounts as soon as Stage joined, regardless of who was already there.
  const isJoined = publisher.phase === 'live';

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
    toggleMute,
    toggleCamera,
    enableCamera,
    disableCamera,
    startScreenShare,
    stopScreenShare,
    leave,
  };
}
