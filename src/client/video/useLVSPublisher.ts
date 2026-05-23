// useLVSPublisher — headless WHIP publish hook for the realtime-modules
// library. Ported from live-video-streaming/ui/src/hooks/useStudioPublisher.ts
// with all LVS-app-specific concerns dropped (UIProvider notify/showError,
// localStorage key resolution, media capture, DOM <video> attach, keyboard
// shortcut, recents tracking).
//
// Contract:
//   - Caller owns capture (getUserMedia / getDisplayMedia) and DOM preview.
//   - Auth and baseUrl come from <LVSProvider> by default; both can be
//     overridden per-hook via opts.
//   - Errors surface as `error: string | null`. No toasts.
//   - `replaceStream(newStream)` swaps tracks on existing senders without
//     renegotiating — used for cam <-> screen-share swap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  whipPublish, whipTeardown, fetchIceServers, LVSApiError,
} from './lib/transport';
import {
  waitForIceGather, formatBitrate, classifyNetQ, type NetQuality,
} from './lib/sdp';
import { jwtSecondsRemaining } from './lib/jwt';
import { useSafeLVSContext, type LVSConfig } from './LVSProvider';

const MEDIA_WATCHDOG_MS = 20000;
const STATS_POLL_MS = 1000;
const ICE_GATHER_TIMEOUT_MS = 3000;

export type LVSPhase = 'idle' | 'connecting' | 'live' | 'error';

export interface LVSPublisherStats {
  bitrateBps: number;
  bitrateLabel: string;
  fps: number | null;
  lossPct: number;
  netq: NetQuality | null;
  bytesSent: number;
  packetsSent: number;
}

export interface UseLVSPublisherOptions {
  /** Channel ARN — used to build `${baseUrl}/api/channels/:arn/whip`. */
  channelArn: string;
  /** MediaStream to publish. Caller owns capture (getUserMedia /
   *  getDisplayMedia). Null parks the hook in idle. */
  stream: MediaStream | null;
  /** Per-tab participantId — forwarded as `?participantId=X` so WHEP
   *  subscribers can correlate this publisher. Required for hangouts. */
  participantId?: string;
  /** Auto-publish on mount once stream is non-null. Default true. */
  autoStart?: boolean;
  /** Override baseUrl from LVSProvider. */
  baseUrl?: string;
  /** Override getAuthToken from LVSProvider. */
  getAuthToken?: () => string | Promise<string>;
}

export interface UseLVSPublisherResult {
  phase: LVSPhase;
  error: string | null;
  iceState: RTCIceConnectionState;
  connState: RTCPeerConnectionState;
  stats: LVSPublisherStats | null;
  sfuNode: string | null;
  whipResource: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Replace tracks on existing senders without renegotiating. Useful
   *  for cam <-> screen-share swap. New tracks must match the existing
   *  transceivers' kind (audio/video). */
  replaceStream: (newStream: MediaStream) => Promise<void>;
  /** Tear down + re-WHIP with a new stream. Used to add/remove track
   *  KINDS mid-call (e.g. audio-only → AV upgrade), which `replaceStream`
   *  alone can't do (LVS WHIP doesn't support PATCH for renegotiation).
   *  Same participantId is preserved so subscribers' tile routing stays
   *  intact. ~500ms-1s gap while ICE+DTLS re-handshakes. */
  republish: (newStream: MediaStream) => Promise<void>;
}

interface RawStats {
  bytes: number;
  packets: number;
  lost: number;
  ts: number;
}

/** Narrow stats reports without leaning on `any`. Browser TS lib lacks
 *  first-class types for RTCOutboundRtpStreamStats. */
interface RtpStatsLike {
  type: string;
  bytesSent?: number;
  packetsSent?: number;
  framesPerSecond?: number;
  packetsLost?: number;
  isRemote?: boolean;
}

function errMessage(e: unknown): string {
  if (e instanceof LVSApiError) return `WHIP ${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Publish a `MediaStream` to an LVS-compatible SFU via WHIP. Owns the
 * `RTCPeerConnection` lifecycle, polls outbound-rtp stats, and runs a
 * watchdog that flips to `error` if no media flows within ~20s.
 *
 * The caller owns capture (camera/screen) and preview rendering. The
 * hook only touches the network and the PC; pass a `stream` and call
 * `start()` (or rely on `autoStart`).
 */
export function useLVSPublisher(opts: UseLVSPublisherOptions): UseLVSPublisherResult {
  const { channelArn, stream, participantId, autoStart = true } = opts;

  // Resolve effective config: opts override context. `useSafeLVSContext`
  // always calls useContext under the hood (no conditional hook), but
  // swallows the "no provider" throw so we can decide whether overrides
  // suffice. The final null-check (after all hooks) preserves
  // rules-of-hooks ordering.
  const ctx = useSafeLVSContext();
  // Partial overlay: per-call opts override individual fields, the rest
  // come from <LVSProvider>. Previously this required BOTH baseUrl AND
  // getAuthToken to be passed to override anything — useLVSHangout only
  // passes getAuthToken (to inject the per-tab stageToken JWT), so the
  // publisher silently fell back to the provider's default token (often
  // an empty sentinel), causing WHIP 401 "missing bearer token".
  const resolved: LVSConfig | null = useMemo(() => {
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl;
    const getAuthToken = opts.getAuthToken ?? ctx?.getAuthToken;
    if (baseUrl === undefined || !getAuthToken) return ctx;
    return {
      baseUrl,
      getAuthToken,
      log: ctx?.log ?? (() => { /* noop */ }),
    };
  }, [opts.baseUrl, opts.getAuthToken, ctx]);

  // Refs avoid re-renders on every stats tick + give callbacks fresh
  // access to the latest PC / resource handle without stale-closure bugs.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const whipResourceRef = useRef<string | null>(null);
  // When set, `start()` will use this stream INSTEAD of the `stream`
  // prop. Set by `republish(newStream)` so callers can swap kinds
  // (audio-only → AV) without first changing the prop and round-
  // tripping through React. Cleared after consumption.
  const streamOverrideRef = useRef<MediaStream | null>(null);
  const lastStatsRef = useRef<RawStats>({ bytes: 0, packets: 0, lost: 0, ts: 0 });
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Token captured at publish-time so teardown can DELETE without
  // re-resolving auth (which may itself fail during shutdown).
  const authTokenRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<LVSPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [iceState, setIceState] = useState<RTCIceConnectionState>('new');
  const [connState, setConnState] = useState<RTCPeerConnectionState>('new');
  const [stats, setStats] = useState<LVSPublisherStats | null>(null);
  const [whipResource, setWhipResource] = useState<string | null>(null);
  const [sfuNode, setSfuNode] = useState<string | null>(null);

  const stopStatsPolling = useCallback(() => {
    if (statsTimerRef.current != null) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  }, []);

  const pollStats = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const report = await pc.getStats();
      let bytes = 0, packets = 0, lost = 0;
      let fps: number | null = null;
      report.forEach((r) => {
        const s = r as unknown as RtpStatsLike;
        if (s.type === 'outbound-rtp' && !s.isRemote) {
          bytes += s.bytesSent || 0;
          packets += s.packetsSent || 0;
          if (s.framesPerSecond != null && fps == null) fps = s.framesPerSecond;
        }
        if (s.type === 'remote-inbound-rtp') {
          lost += s.packetsLost || 0;
        }
      });

      const now = performance.now();
      const last = lastStatsRef.current;
      let bitrateBps = 0;
      let lossPct = 0;
      if (last.ts > 0) {
        const dt = (now - last.ts) / 1000;
        bitrateBps = dt > 0 ? Math.max(0, ((bytes - last.bytes) * 8) / dt) : 0;
        const dPackets = Math.max(1, packets - last.packets);
        const dLost = Math.max(0, lost - last.lost);
        lossPct = (dLost / (dPackets + dLost)) * 100;
      }
      lastStatsRef.current = { bytes, packets, lost, ts: now };

      const hasRecentPackets = bitrateBps > 0 || pc.connectionState !== 'connected';
      const netq: NetQuality = classifyNetQ(lossPct, hasRecentPackets);

      setStats({
        bitrateBps,
        bitrateLabel: formatBitrate(bitrateBps),
        fps,
        lossPct,
        netq,
        bytesSent: bytes,
        packetsSent: packets,
      });
    } catch {
      // transient getStats failure — ignore
    }
  }, []);

  const startStatsPolling = useCallback(() => {
    stopStatsPolling();
    lastStatsRef.current = { bytes: 0, packets: 0, lost: 0, ts: 0 };
    statsTimerRef.current = setInterval(() => { void pollStats(); }, STATS_POLL_MS);
  }, [pollStats, stopStatsPolling]);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current != null) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  /** Synchronous local cleanup. Closes PC + clears timers + resets state.
   *  Does NOT post WHIP DELETE — `stop()` does that first. */
  const teardownLocal = useCallback(() => {
    stopStatsPolling();
    clearWatchdog();
    const pc = pcRef.current;
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    whipResourceRef.current = null;
    authTokenRef.current = null;
    setWhipResource(null);
    setSfuNode(null);
    setStats(null);
    setIceState('new');
    setConnState('new');
  }, [stopStatsPolling, clearWatchdog]);

  const stop = useCallback(async () => {
    const resource = whipResourceRef.current;
    const token = authTokenRef.current;
    if (resource && token) {
      // Best-effort DELETE; teardown happens regardless.
      await whipTeardown(resource, token).catch(() => { /* ignore */ });
    }
    teardownLocal();
    setPhase('idle');
    setError(null);
  }, [teardownLocal]);

  const start = useCallback(async () => {
    if (!resolved) {
      setError('[lvs] useLVSPublisher requires <LVSProvider> or per-hook baseUrl + getAuthToken overrides.');
      setPhase('error');
      return;
    }
    // republish() sets streamOverrideRef so the next start() uses the
    // fresh stream without waiting for the prop to update. Consume it.
    const activeStream = streamOverrideRef.current ?? stream;
    streamOverrideRef.current = null;
    if (!activeStream) {
      setError('No stream — pass a MediaStream to useLVSPublisher before calling start().');
      setPhase('error');
      return;
    }
    if (pcRef.current) {
      // Already publishing or mid-connect. Idempotent — bail.
      return;
    }
    const { baseUrl, getAuthToken, log } = resolved;
    setError(null);
    setPhase('connecting');

    try {
      const token = await getAuthToken();
      authTokenRef.current = token;

      // JWT expiry preemption — fail fast on already-expired tokens
      // rather than letting WHIP 401 cascade through the publish path.
      // Log a warning at <60s so consumers can refresh while live.
      const ttl = jwtSecondsRemaining(token);
      if (ttl !== null && ttl <= 0) {
        throw new Error(`stage token expired ${Math.abs(ttl)}s ago — refresh before publishing`);
      }
      if (ttl !== null && ttl !== Infinity && ttl < 60) {
        log(`stage token expires in ${ttl}s — refresh recommended`, 'warn');
      }

      const ice = await fetchIceServers(baseUrl);
      log(`fetched ${ice.length} ICE server(s)`, 'info');
      const pc = new RTCPeerConnection({ iceServers: ice });
      pcRef.current = pc;

      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        log(`connectionState -> ${s}`, 'info');
        setConnState(s);
        if (s === 'connected') {
          setPhase('live');
          setError(null);
        } else if (s === 'failed') {
          setPhase('error');
          setError('WebRTC connection failed — media path could not be established.');
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        const s = pc.iceConnectionState;
        log(`iceConnectionState -> ${s}`, 'info');
        setIceState(s);
        if (s === 'failed') {
          setPhase('error');
          setError('ICE failed — no network path between browser and SFU (TURN may be unreachable).');
        }
      });

      // Watchdog: if no bytes flow + ICE never connects within 20s,
      // surface an actionable error. Caller decides whether to stop().
      watchdogTimerRef.current = setTimeout(() => {
        if (pcRef.current !== pc) return;
        const iceOk = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
        const bytes = lastStatsRef.current.bytes;
        if (iceOk && bytes > 0) return;
        setPhase('error');
        setError(
          `Media stalled. ICE=${pc.iceConnectionState}, connection=${pc.connectionState}, bytes=${bytes}.`,
        );
      }, MEDIA_WATCHDOG_MS);

      for (const t of activeStream.getTracks()) pc.addTrack(t, activeStream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // LVS doesn't support trickle ICE — batch candidates into the offer.
      await waitForIceGather(pc, ICE_GATHER_TIMEOUT_MS);

      const offerSdp = pc.localDescription?.sdp;
      if (!offerSdp) throw new Error('failed to generate local SDP');

      const { answerSdp, location, sfuNode: node } = await whipPublish({
        channelArn,
        offerSdp,
        authToken: token,
        participantId,
        baseUrl,
      });
      whipResourceRef.current = location;
      setWhipResource(location);
      setSfuNode(node);
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // connectionstatechange listener flips phase->live once the PC
      // actually establishes. Stats polling starts immediately so the
      // first tick lands within ~1s of the answer.
      startStatsPolling();
    } catch (e) {
      const msg = errMessage(e);
      resolved.log(`publish failed: ${msg}`, 'err');
      setError(msg);
      setPhase('error');
      // Local teardown only — there's no WHIP resource to DELETE if the
      // POST never completed (and if it did, the server will GC on its own).
      teardownLocal();
    }
  }, [
    resolved, stream, channelArn, participantId,
    startStatsPolling, teardownLocal,
  ]);

  /**
   * Swap the currently-published tracks via RTCRtpSender.replaceTrack —
   * no SDP renegotiation. Contract:
   *
   * - Tracks for kinds present in `newStream` swap onto the matching
   *   existing sender. Kinds NOT in `newStream` are left alone (the
   *   previously-published track keeps flowing). This is what makes
   *   screenshare-in work: pass `{video: screenTrack}` only; audio stays.
   *
   * - If a kind is in `newStream` but no sender of that kind exists
   *   (e.g. mic was denied at start so no audio sender was ever added),
   *   we log a warning and skip — addTrack mid-call requires PATCH-based
   *   SDP renegotiation which WHIP doesn't reliably support. Caller
   *   should ensure both kinds are in the initial getUserMedia stream
   *   if either may need to swap later.
   */
  const replaceStream = useCallback(async (newStream: MediaStream) => {
    const pc = pcRef.current;
    if (!pc) {
      throw new Error('replaceStream called before start() — no active peer connection.');
    }
    const senders = pc.getSenders();
    const newVideo = newStream.getVideoTracks()[0] || null;
    const newAudio = newStream.getAudioTracks()[0] || null;
    const vs = senders.find(s => s.track?.kind === 'video');
    const as = senders.find(s => s.track?.kind === 'audio');
    if (newVideo && !vs) {
      resolved?.log('replaceStream: no video sender to swap onto (track ignored)', 'warn');
    } else if (vs && newVideo) {
      await vs.replaceTrack(newVideo);
    }
    if (newAudio && !as) {
      resolved?.log('replaceStream: no audio sender to swap onto (track ignored)', 'warn');
    } else if (as && newAudio) {
      await as.replaceTrack(newAudio);
    }
  }, [resolved]);

  /**
   * Tear down the existing WHIP transport + re-publish with a new
   * stream. The `participantId` is preserved (same WHIP query param),
   * so remote subscribers can keep their tile keyed on it. Use for:
   *   - audio-only → AV upgrade (enableCamera in useLVSHangout)
   *   - AV → audio-only downgrade
   *   - mid-call mic/camera device swap
   * Costs ~500ms-1s of black audio/video while the new PeerConnection
   * completes ICE + DTLS + SDP. Subscribers will see a `producer.added`
   * event on the LVS producer-discovery WS and can re-WHEP.
   */
  const republish = useCallback(async (newStream: MediaStream) => {
    // Order matters: stop FIRST so the WHIP resource is released
    // server-side, then queue the new stream and re-start.
    await stop();
    streamOverrideRef.current = newStream;
    await start();
  }, [stop, start]);

  // Auto-start when stream becomes available. Re-runs if the stream
  // reference changes, but only kicks off when we're idle — avoids
  // double-publishing on rerender.
  useEffect(() => {
    if (!autoStart) return;
    if (!stream) return;
    if (pcRef.current) return;
    void start();
    // We intentionally don't depend on `start` here — its identity
    // changes when stream/participantId/etc. change, and we only want
    // to fire when the stream itself shows up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, autoStart]);

  // Unmount cleanup. Synchronous DELETE via keepalive + sync local
  // teardown so the PC closes before React strict-mode tears the tree.
  useEffect(() => {
    return () => {
      const resource = whipResourceRef.current;
      const token = authTokenRef.current;
      if (resource && token) {
        // Fire-and-forget; can't await in cleanup. whipTeardown swallows.
        void whipTeardown(resource, token);
      }
      teardownLocal();
    };
  }, [teardownLocal]);

  return {
    phase,
    error,
    iceState,
    connState,
    stats,
    sfuNode,
    whipResource,
    start,
    stop,
    replaceStream,
    republish,
  };
}

