// useLVSSubscriber — WHEP viewer hook for LVS-compatible SFUs. Ported
// from live-video-streaming/ui/src/hooks/useWhep.ts, stripped of demo-
// only concerns (multi-pod endpoint chooser, in-hook debug log panel,
// X-SFU-Direct header). Designed for hangouts: per-track callback
// surfaces participantId from `streams[0].id` so consumers can route
// multiplexed remote tracks into per-publisher tiles.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  whepPublish,
  whepTeardown,
  fetchIceServers,
  LVSApiError,
} from './lib/transport';
import {
  waitForIceGather,
  formatBitrate,
  classifyNetQ,
  type NetQuality,
} from './lib/sdp';
import { jwtSecondsRemaining } from './lib/jwt';
import { useLVSContext } from './LVSProvider';

export type LVSSubscriberPhase =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'failed'
  | 'reconnecting';

export interface LVSSubscriberStats {
  bitrateBps: number;
  bitrateLabel: string;
  fps: number | null;
  lossPct: number;
  netq: NetQuality | null;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  width: number;
  height: number;
}

export interface UseLVSSubscriberOptions {
  /** Channel ARN — `${baseUrl}/api/channels/:arn/whep`. */
  channelArn: string;
  /** Auto-connect on mount. Default true. */
  autoStart?: boolean;
  /** Skip self via excludeParticipantId — passed to whep server so its
   *  SDP answer never includes our own published tracks. Hangout-essential. */
  excludeParticipantId?: string;
  baseUrl?: string;
  getAuthToken?: () => string | Promise<string>;
  /** Per-track callback — fires on every inbound track. The second arg
   *  is the track's `streams[0].id` (msid), typically the SFU-assigned
   *  participantId. Lets consumers route tracks into per-participant
   *  tiles when WHEP multiplexes many publishers into one PC. */
  onTrack?: (track: MediaStreamTrack, participantId: string | null) => void;
  /** When true, opens an auxiliary WebSocket to LVS's producer-
   *  discovery channel (`/api/channels/:arn/ws`) and triggers a
   *  re-WHEP whenever a producer of a NEW kind is announced. This is
   *  how subscribers pick up an audio-only publisher's upgrade to
   *  video — WHEP itself has no push channel for new producers. */
  watchProducerEvents?: boolean;
}

export interface UseLVSSubscriberResult {
  phase: LVSSubscriberPhase;
  error: string | null;
  iceState: RTCIceConnectionState;
  connState: RTCPeerConnectionState;
  stats: LVSSubscriberStats | null;
  sfuNode: string | null;
  /** Aggregated MediaStream of all inbound tracks. Pass to a <video>
   *  element via srcObject. */
  stream: MediaStream | null;
  /** Per-track map keyed by trackId. Lets consumers split multiplexed
   *  remote-tracks-per-publisher into per-participant tiles. */
  tracks: ReadonlyMap<string, MediaStreamTrack>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Subscribe to an LVS channel via WHEP. Manages the RTCPeerConnection
 * lifecycle (two recvonly transceivers → offer/answer → stats poll →
 * reconnect ladder → teardown). Exposes an aggregated `MediaStream`
 * for direct `<video srcObject>` binding plus a `Map<trackId, track>`
 * for per-participant tile routing in hangouts.
 *
 * Reconnect ladder: `[1, 2, 4, 8, 16, 30]s`, max 5 attempts. Triggered
 * on `connectionState === 'failed' | 'disconnected'`. Each attempt
 * tears down the prior PC + WHEP resource before reconnecting.
 */
export function useLVSSubscriber(
  opts: UseLVSSubscriberOptions,
): UseLVSSubscriberResult {
  const ctx = useLVSContext();
  const baseUrl = opts.baseUrl ?? ctx.baseUrl;
  const getAuthToken = opts.getAuthToken ?? ctx.getAuthToken;
  const log = ctx.log;

  const [phase, setPhase] = useState<LVSSubscriberPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [iceState, setIceState] = useState<RTCIceConnectionState>('new');
  const [connState, setConnState] = useState<RTCPeerConnectionState>('new');
  const [stats, setStats] = useState<LVSSubscriberStats | null>(null);
  const [sfuNode, setSfuNode] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [tracks, setTracks] = useState<ReadonlyMap<string, MediaStreamTrack>>(
    new Map(),
  );

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tracksRef = useRef<Map<string, MediaStreamTrack>>(new Map());
  const resourceRef = useRef<string | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const stoppedRef = useRef(false);
  const onTrackRef = useRef(opts.onTrack);
  onTrackRef.current = opts.onTrack;
  const channelArnRef = useRef(opts.channelArn);
  channelArnRef.current = opts.channelArn;
  const excludeRef = useRef(opts.excludeParticipantId);
  excludeRef.current = opts.excludeParticipantId;
  const startRef = useRef<() => Promise<void>>(async () => {});

  const clearTimers = useCallback(() => {
    if (statsTimerRef.current != null) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const teardownPc = useCallback(async () => {
    const resource = resourceRef.current;
    resourceRef.current = null;
    if (resource) {
      try {
        const token = await getAuthToken();
        await whepTeardown(resource, token);
      } catch {
        /* best-effort */
      }
    }
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current = null;
    }
    tracksRef.current = new Map();
  }, [getAuthToken]);

  const stop = useCallback(async () => {
    stoppedRef.current = true;
    reconnectAttemptRef.current = 0;
    clearTimers();
    await teardownPc();
    setStream(null);
    setTracks(new Map());
    setStats(null);
    setIceState('new');
    setConnState('new');
    setSfuNode(null);
    setPhase('idle');
    setError(null);
    log('subscriber stopped');
  }, [clearTimers, teardownPc, log]);

  const startStatsPolling = useCallback((pc: RTCPeerConnection) => {
    let lastBytes = 0;
    let lastTs = 0;
    statsTimerRef.current = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed') return;
      const report = await pc.getStats();
      let bytes = 0;
      let packets = 0;
      let lost = 0;
      let fps = 0;
      let width = 0;
      let height = 0;
      report.forEach((r) => {
        if (r.type === 'inbound-rtp') {
          const inbound = r as RTCInboundRtpStreamStats & {
            framesPerSecond?: number;
            frameWidth?: number;
            frameHeight?: number;
          };
          bytes += inbound.bytesReceived ?? 0;
          packets += inbound.packetsReceived ?? 0;
          lost += inbound.packetsLost ?? 0;
          if (typeof inbound.framesPerSecond === 'number') {
            fps = Math.max(fps, inbound.framesPerSecond);
          }
          if (typeof inbound.frameWidth === 'number') {
            width = Math.max(width, inbound.frameWidth);
          }
          if (typeof inbound.frameHeight === 'number') {
            height = Math.max(height, inbound.frameHeight);
          }
        }
      });
      const now = performance.now();
      let bitrateBps = 0;
      if (lastTs > 0) {
        const dt = (now - lastTs) / 1000;
        if (dt > 0) bitrateBps = ((bytes - lastBytes) * 8) / dt;
      }
      lastBytes = bytes;
      lastTs = now;
      const totalSeen = packets + lost;
      const lossPct = totalSeen > 0 ? (lost / totalSeen) * 100 : 0;
      const hasRecent = bitrateBps > 0;
      setStats({
        bitrateBps,
        bitrateLabel: formatBitrate(bitrateBps),
        fps: fps > 0 ? Math.round(fps) : null,
        lossPct,
        netq: hasRecent ? classifyNetQ(lossPct, hasRecent) : null,
        bytesReceived: bytes,
        packetsReceived: packets,
        packetsLost: lost,
        width,
        height,
      });
    }, 1000);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      const msg = `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`;
      log(msg, 'err');
      setError(msg);
      setPhase('failed');
      return;
    }
    const delayMs =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttemptRef.current = attempt + 1;
    log(
      `subscriber reconnect in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`,
      'warn',
    );
    reconnectTimerRef.current = setTimeout(() => {
      if (stoppedRef.current) return;
      void teardownPc().then(() => {
        if (!stoppedRef.current) void startRef.current();
      });
    }, delayMs);
  }, [log, teardownPc]);

  const start = useCallback(async () => {
    const arn = channelArnRef.current;
    if (!arn) return;
    stoppedRef.current = false;
    clearTimers();
    if (reconnectAttemptRef.current === 0) setError(null);
    setPhase('connecting');
    log(
      reconnectAttemptRef.current === 0
        ? 'subscriber start'
        : `subscriber reconnect attempt ${reconnectAttemptRef.current}`,
    );

    try {
      const iceServers = await fetchIceServers(baseUrl);
      log(`ICE servers: ${iceServers.length}`);

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.addEventListener('track', (ev) => {
        let s = streamRef.current;
        if (!s) {
          s = new MediaStream();
          streamRef.current = s;
          setStream(s);
        }
        s.addTrack(ev.track);
        const next = new Map(tracksRef.current);
        next.set(ev.track.id, ev.track);
        tracksRef.current = next;
        setTracks(next);
        const participantId = ev.streams[0]?.id ?? null;
        log(
          `track ${ev.track.kind} id=${ev.track.id} msid=${participantId ?? '-'}`,
          'ok',
        );
        ev.track.addEventListener('ended', () => {
          const m = new Map(tracksRef.current);
          m.delete(ev.track.id);
          tracksRef.current = m;
          setTracks(m);
        });
        onTrackRef.current?.(ev.track, participantId);
      });

      pc.addEventListener('iceconnectionstatechange', () => {
        setIceState(pc.iceConnectionState);
        log(`iceConnectionState → ${pc.iceConnectionState}`);
      });

      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        setConnState(s);
        log(`connectionState → ${s}`);
        if (s === 'connected') {
          reconnectAttemptRef.current = 0;
          setPhase('live');
        }
        if (s === 'failed' || s === 'disconnected') {
          setPhase('reconnecting');
          scheduleReconnect();
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGather(pc, 3000);

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('failed to generate local SDP');

      const token = await getAuthToken();
      const ttl = jwtSecondsRemaining(token);
      if (ttl !== null && ttl <= 0) {
        throw new Error(`stage token expired ${Math.abs(ttl)}s ago — refresh before subscribing`);
      }
      if (ttl !== null && ttl !== Infinity && ttl < 60) {
        log(`stage token expires in ${ttl}s — refresh recommended`, 'warn');
      }
      const { answerSdp, location, sfuNode: node } = await whepPublish({
        channelArn: arn,
        offerSdp: sdp,
        authToken: token,
        excludeParticipantId: excludeRef.current,
        baseUrl,
      });
      resourceRef.current = location;
      setSfuNode(node);
      log(`WHEP 201 resource=${location ?? '-'} node=${node ?? '-'}`, 'ok');

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      startStatsPolling(pc);
    } catch (e) {
      const msg =
        e instanceof LVSApiError
          ? `WHEP ${e.status}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      log(`subscriber failed: ${msg}`, 'err');
      setError(msg);
      // Failure during setup → fall back to reconnect ladder rather
      // than terminal-failing, matching the source behavior.
      setPhase('reconnecting');
      scheduleReconnect();
    }
  }, [baseUrl, getAuthToken, log, clearTimers, scheduleReconnect, startStatsPolling]);

  // Keep startRef current so scheduleReconnect avoids stale closures.
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Auto-start on mount + on channelArn change.
  useEffect(() => {
    const auto = opts.autoStart ?? true;
    if (!auto) return;
    void start();
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.channelArn]);

  // Producer-discovery WS watcher — when watchProducerEvents is on,
  // open the LVS auxiliary channel and re-WHEP if a producer of a kind
  // we don't already have appears. Coalesces bursts (publisher adding
  // audio + video in the same upgrade) via a 250ms debounce.
  useEffect(() => {
    if (!opts.watchProducerEvents) return;
    if (!opts.channelArn) return;
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl;
    if (!baseUrl) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const debouncedRewhep = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        // Tear + restart picks up the new producer kind. Same
        // `excludeParticipantId` so we don't subscribe to ourselves.
        void (async () => {
          await stop().catch(() => { /* ignore */ });
          if (!cancelled) await start().catch(() => { /* ignore */ });
        })();
      }, 250);
    };

    const wsUrl = baseUrl.replace(/^http/, 'ws') +
      `/api/channels/${encodeURIComponent(opts.channelArn)}/ws`;
    try {
      ws = new WebSocket(wsUrl);
      // Send the subscribe-channel handshake on open. The server
      // (stageWsServer) keeps the socket alive but delivers ZERO
      // producer.added / producer.removed events until it sees this
      // frame — which is why bursts of producers used to show up only
      // via the reconnect ladder. participantId = our pid so the
      // server can scope replay frames.
      ws.addEventListener('open', () => {
        void (async () => {
          try {
            const token = await getAuthToken();
            ws?.send(JSON.stringify({
              type: 'subscribe-channel',
              channelArn: opts.channelArn,
              participantId: excludeRef.current ?? undefined,
              token,
            }));
          } catch { /* token resolver threw — discovery WS goes silent, but core WHEP still works */ }
        })();
      });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type !== 'producer.added') return;
          // Skip our own producers (defense in depth — server should
          // already filter by excludeParticipantId, but the discovery
          // channel doesn't.)
          if (excludeRef.current && msg.participantId === excludeRef.current) return;
          // Optimization: only re-WHEP if the producer's kind isn't
          // already in our tracks map. Avoids re-handshaking on
          // unrelated audio/video adds we already have.
          const haveKind = Array.from(tracks.values()).some(t => t.kind === msg.kind);
          if (haveKind) return;
          debouncedRewhep();
        } catch { /* malformed frame — ignore */ }
      });
    } catch { /* WS construction failure — silent fail-open */ }

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      try { ws?.close(); } catch { /* */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.watchProducerEvents, opts.channelArn, opts.baseUrl]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      clearTimers();
      void teardownPc();
    };
  }, [clearTimers, teardownPc]);

  return {
    phase,
    error,
    iceState,
    connState,
    stats,
    sfuNode,
    stream,
    tracks,
    start,
    stop,
  };
}
