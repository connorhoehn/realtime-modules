// realtime-modules/src/client/voice/useVoiceCapture.ts
//
// Push-to-talk ambient voice capture, for any page — not just a call.
//
//   press  -> getUserMedia -> AudioWorklet -> 16 kHz s16le -> POST /pcm proxy
//                                                                  |
//   release -> silence tail forces the sidecar to cut its window   v
//                                                        live-captions sidecar
//                                                                  |
//   transcript <- gateway WS `caption` frames <- caption-relay <- Redis
//                                                                  |
//                                             publishTranscript -> every sink
//
// Nothing on the server side is new: the live-captions sidecar is a generic
// HTTP speech-to-text service whose `X-Channel-Arn` header is free-form, and
// the gateway's caption-relay psubscribes `captions:*`. A routing key of
// `capture:<captureId>` therefore rides the existing fan-out untouched.
//
// Audio does NOT ride a WebSocket. The gateway coerces every frame to a UTF-8
// string, so binary over WS is not merely awkward there, it is lossy. PCM goes
// over HTTP POST; only the resulting text comes back over the socket.
//
// Three invariants, none negotiable:
//
//  * WHERE the utterance attaches is latched from the screen at the instant of
//    the press and never re-decided (contextFrame.ts). If the context moved
//    before release, `contextSplit` is set and `autoAttach` is false.
//  * The microphone track is released on every stop, including error and
//    unmount paths (pcmRecorder.stop()).
//  * The hook writes nothing. Finished utterances are published to the
//    transcript bus; sinks decide what to persist. The comment path is one
//    subscriber, the work-item lane is another, and neither is privileged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  captureRoutingKey,
  captureWsChannel,
  generateCaptureId,
} from './captureChannel';
import {
  buildContextFrame,
  type CaptureContextSample,
  type ContextFrame,
} from './contextFrame';
import { isVoiceCaptureSupported, PcmRecorder, type PcmChunk } from './pcmRecorder';
import { silenceBytes } from './pcm';
import {
  publishTranscript,
  type TranscriptReadyEvent,
} from './transcriptBus';
import {
  UtteranceAggregator,
  type CaptionLineIn,
} from './utteranceAggregator';

export type VoiceCaptureState =
  | 'unsupported'
  | 'idle'
  /** Mic permission / graph setup in flight. */
  | 'starting'
  /** Track is LIVE and audio is being sent. */
  | 'listening'
  /** Track released; waiting for the tail of the transcript. */
  | 'transcribing'
  | 'error';

export interface UseVoiceCaptureOptions {
  /** Bearer token for the capture proxy. Capture is disabled without one. */
  authToken: string | null;
  /**
   * Sample of what is on screen RIGHT NOW. Called twice per utterance — once at
   * press, once at release. Must be cheap and synchronous: it runs before the
   * permission prompt, and a sample taken after that prompt resolves is a
   * different screen.
   */
  sampleContext: () => CaptureContextSample;
  /**
   * Optional per-hook sink. Every utterance also goes to the module-level
   * transcript bus (`subscribeTranscripts`), which is the surface other lanes
   * should use — this callback exists for a host that wants the event inline.
   */
  onTranscript?: (event: TranscriptReadyEvent) => void | Promise<void>;
  /** Gateway WS message bus. */
  subscribe: (handler: (msg: unknown) => void) => () => void;
  sendMessage: (msg: Record<string, unknown>) => void;
  /** Capture proxy. Defaults to the platform-api route. */
  endpoint?: string;
  /** Stable across the hook's life. Generated if omitted. */
  captureId?: string;
  /** Audio per POST. Default 200 ms. */
  chunkMs?: number;
  /**
   * Silence appended on release to force the sidecar to cut its window.
   *
   * Its accumulator cuts on >=0.5 s trailing silence with >=0.6 s of speech
   * buffered, so 900 ms reliably closes a real remark instead of leaving its
   * tail buffered until the next press.
   */
  flushMs?: number;
  settleMs?: number;
  maxWaitMs?: number;
  viewportDominanceRatio?: number;
}

export interface UseVoiceCaptureResult {
  /** Secure context + getUserMedia + AudioWorklet + SubtleCrypto all present. */
  supported: boolean;
  state: VoiceCaptureState;
  /**
   * True only while a MediaStreamTrack is genuinely live. Bind the UI's
   * "listening" affordance to THIS, never to `state`, so our indicator can
   * never claim to be off while the OS indicator is on.
   */
  micActive: boolean;
  /** Partial transcript of the utterance in flight. */
  liveText: string;
  lastTranscript: TranscriptReadyEvent | null;
  /**
   * Context frame the CURRENT utterance is latched to, with `t1_ms` still
   * provisional. Null when idle. Render this so the speaker can see where the
   * remark is going while they are still talking.
   */
  pendingContext: ContextFrame | null;
  error: Error | null;
  /** Press. Safe to call repeatedly; a second call while listening is a no-op. */
  start: () => void;
  /** Release. Flushes and waits for the transcript. */
  stop: () => void;
  /** Release and throw the utterance away. */
  cancel: () => void;
  captureId: string;
  /** WS channel transcripts arrive on; null until the SHA-1 resolves. */
  channel: string | null;
}

const DEFAULT_ENDPOINT = '/api/voice-capture/pcm';
const POLL_MS = 150;

export function useVoiceCapture(opts: UseVoiceCaptureOptions): UseVoiceCaptureResult {
  const {
    authToken,
    sampleContext,
    onTranscript,
    subscribe,
    sendMessage,
    endpoint = DEFAULT_ENDPOINT,
    chunkMs = 200,
    flushMs = 900,
    settleMs,
    maxWaitMs,
    viewportDominanceRatio,
  } = opts;

  const supported = useMemo(() => isVoiceCaptureSupported(), []);
  const captureId = useMemo(
    () => opts.captureId ?? (supported ? generateCaptureId() : 'unsupported'),
    [opts.captureId, supported],
  );
  const routingKey = useMemo(() => captureRoutingKey(captureId), [captureId]);

  const [channel, setChannel] = useState<string | null>(null);
  const [state, setState] = useState<VoiceCaptureState>(
    supported ? 'idle' : 'unsupported',
  );
  const [micActive, setMicActive] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [lastTranscript, setLastTranscript] = useState<TranscriptReadyEvent | null>(null);
  const [pendingContext, setPendingContext] = useState<ContextFrame | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // --- refs: the audio path must not be re-created by a render -------------
  const recorderRef = useRef<PcmRecorder | null>(null);
  const aggRef = useRef<UtteranceAggregator | null>(null);
  const utteranceIdRef = useRef<string>('');
  const startSampleRef = useRef<CaptureContextSample | null>(null);
  const t0Ref = useRef(0);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledRef = useRef(false);

  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const sampleContextRef = useRef(sampleContext);
  sampleContextRef.current = sampleContext;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const contextOpts = useMemo(
    () => (viewportDominanceRatio !== undefined ? { viewportDominanceRatio } : {}),
    [viewportDominanceRatio],
  );

  // --- caption channel subscription ---------------------------------------
  // Subscribed on MOUNT, not on press. The relay is stateless fan-out with no
  // replay, so subscribing at press time would race the first caption line
  // straight into the void.
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    captureWsChannel(routingKey)
      .then((ch) => {
        if (!disposed) setChannel(ch);
      })
      .catch((err: Error) => setError(err));
    return () => {
      disposed = true;
    };
  }, [routingKey, supported]);

  useEffect(() => {
    if (!channel) return;
    sendMessageRef.current({ service: 'subscribe', action: 'subscribe', channel });
    return () => {
      sendMessageRef.current({ service: 'subscribe', action: 'unsubscribe', channel });
    };
  }, [channel]);

  useEffect(() => {
    if (!channel) return;
    return subscribe((msg: unknown) => {
      const m = msg as { type?: string; channel?: string; data?: CaptionLineIn };
      if (m?.type !== 'caption' || m.channel !== channel) return;
      const line = m.data;
      if (!line) return;
      // Late lines from a PREVIOUS utterance can never be mis-assigned: each
      // utterance gets its own participantId, which is also what gives it a
      // fresh accumulator on the sidecar.
      if (line.participantId && line.participantId !== utteranceIdRef.current) return;
      const agg = aggRef.current;
      if (!agg) return;
      agg.accept(line, Date.now());
      setLiveText(agg.currentText());
    });
  }, [channel, subscribe]);

  // --- transport ------------------------------------------------------------
  // Chunks are POSTed strictly in order. Concurrent fetches would let the
  // network reorder them, and reordered PCM is not "slightly wrong audio" — it
  // is a different sentence.
  const postPcm = useCallback(
    (bytes: Uint8Array, utteranceId: string, flush: boolean) => {
      const token = authTokenRef.current;
      if (!token) return;
      sendQueueRef.current = sendQueueRef.current
        .then(async () => {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              Authorization: `Bearer ${token}`,
              'X-Capture-Id': captureId,
              'X-Utterance-Id': utteranceId,
              ...(flush ? { 'X-Capture-Flush': '1' } : {}),
            },
            // Copy into a fresh ArrayBuffer: the worklet's buffer is recycled.
            body: bytes.slice().buffer as ArrayBuffer,
          });
          if (!res.ok) throw new Error(`capture proxy ${res.status}`);
        })
        .catch((err: Error) => {
          setError(err);
        });
    },
    [endpoint, captureId],
  );

  // --- finalize loop --------------------------------------------------------
  useEffect(() => {
    if (state !== 'transcribing') return;
    const timer = setInterval(() => {
      const agg = aggRef.current;
      if (!agg) return;
      const now = Date.now();
      const done = agg.evaluate(now);
      if (!done) return;
      aggRef.current = null;

      const context = buildContextFrame({
        start: startSampleRef.current ?? {},
        end: sampleContextRef.current(),
        t0_ms: t0Ref.current,
        // The utterance ENDED when the audio stopped, not when its transcript
        // finished arriving. ASR lag must not widen the span a consumer sees.
        t1_ms: done.endedAt,
        options: contextOpts,
      });

      const event: TranscriptReadyEvent = {
        utteranceId: utteranceIdRef.current,
        captureId,
        text: done.text,
        t0_ms: context.t0_ms,
        t1_ms: context.t1_ms,
        context,
        outcome: done.outcome,
        lines: done.lines,
        speechMs: done.speechMs,
      };

      setLastTranscript(event);
      setLiveText('');
      setPendingContext(null);
      setState('idle');

      publishTranscript(event);
      const inline = onTranscriptRef.current;
      if (inline) {
        try {
          const ret = inline(event);
          if (ret && typeof (ret as Promise<void>).catch === 'function') {
            (ret as Promise<void>).catch((err: Error) => setError(err));
          }
        } catch (err) {
          setError(err as Error);
        }
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, captureId, contextOpts]);

  // --- controls -------------------------------------------------------------
  const start = useCallback(() => {
    if (!supported) return;
    if (!authTokenRef.current) {
      setError(new Error('voice capture requires an auth token'));
      return;
    }
    if (recorderRef.current) return; // already listening

    // Latch the target BEFORE any await.
    const startSample = sampleContextRef.current();
    const t0 = Date.now();
    startSampleRef.current = startSample;
    t0Ref.current = t0;
    setPendingContext(
      buildContextFrame({
        start: startSample,
        end: startSample,
        t0_ms: t0,
        t1_ms: t0,
        options: contextOpts,
      }),
    );

    // A fresh participant id per utterance gives us a fresh accumulator on the
    // sidecar — otherwise a sub-threshold remark stays buffered and gets
    // prepended to the NEXT one, attached to the next one's target.
    const utteranceId = generateCaptureId();
    utteranceIdRef.current = utteranceId;
    cancelledRef.current = false;
    setError(null);
    setLiveText('');
    setState('starting');

    const agg = new UtteranceAggregator(t0, {
      ...(settleMs !== undefined ? { settleMs } : {}),
      ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
    });
    aggRef.current = agg;

    const recorder = new PcmRecorder({
      chunkMs,
      onChunk: (chunk: PcmChunk) => {
        if (cancelledRef.current) return;
        if (chunk.isSpeech) agg.addSpeechMs(chunk.durationMs);
        postPcm(chunk.bytes, utteranceId, false);
      },
      onError: (err) => setError(err),
    });
    recorderRef.current = recorder;

    recorder
      .start()
      .then(() => {
        if (cancelledRef.current) {
          recorder.stop();
          return;
        }
        setMicActive(true);
        setState('listening');
      })
      .catch((err: Error) => {
        recorderRef.current = null;
        aggRef.current = null;
        setMicActive(false);
        setPendingContext(null);
        setError(err);
        setState('error');
      });
  }, [supported, chunkMs, postPcm, settleMs, maxWaitMs, contextOpts]);

  const releaseMic = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setMicActive(false);
  }, []);

  const stop = useCallback(() => {
    if (!recorderRef.current && !aggRef.current) return;
    const utteranceId = utteranceIdRef.current;
    releaseMic();
    const agg = aggRef.current;
    if (!agg) {
      setState('idle');
      return;
    }
    // Force the sidecar to cut its window NOW. Without this the tail of the
    // remark sits in the accumulator until enough further audio arrives — which
    // for a one-shot push-to-talk is never.
    postPcm(silenceBytes(flushMs), utteranceId, true);
    agg.closeAudio(Date.now());
    setState('transcribing');
  }, [releaseMic, postPcm, flushMs]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    releaseMic();
    aggRef.current = null;
    startSampleRef.current = null;
    setLiveText('');
    setPendingContext(null);
    setState(supported ? 'idle' : 'unsupported');
  }, [releaseMic, supported]);

  // Unmount must never leave a track live.
  useEffect(() => () => {
    cancelledRef.current = true;
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  return {
    supported,
    state,
    micActive,
    liveText,
    lastTranscript,
    pendingContext,
    error,
    start,
    stop,
    cancel,
    captureId,
    channel,
  };
}
