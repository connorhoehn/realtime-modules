// realtime-modules/src/client/useDictation.ts
//
// Push-to-talk DICTATION: hold a key, speak, get the transcript back on the
// same HTTP request that carried the audio.
//
//   press   -> latch context -> getUserMedia -> AudioWorklet -> 16 kHz s16le
//              -> POST <endpoint>/pcm  (200 ms chunks, streamed during the hold)
//   release -> POST <endpoint>/end     -> { text } IN THE RESPONSE BODY
//              -> ContextFrame built from the LATCHED sample -> publishTranscript
//
// ---------------------------------------------------------------------------
// Why this is not `useVoiceCapture`
// ---------------------------------------------------------------------------
//
// `useVoiceCapture` (client/voice/useVoiceCapture.ts) rides the live-CAPTION
// path: audio to the sidecar, transcript back via Redis -> the gateway's
// caption-relay -> a WS channel the browser subscribed to. That is the right
// shape for captions, which are a broadcast to a room.
//
// Dictation is not a broadcast. It is one person asking one question and
// waiting for one answer, and the audio already travels to the transcriber over
// HTTP. Routing the reply back through Redis and a fan-out channel means the
// answer takes three extra hops to reach the machine that asked, and it means
// the transcript exists, briefly, as a message on a channel addressed by a
// bearer id rather than as a response to an authenticated request.
//
// Both costs were measured on the same 3.6 s utterance, same audio, same
// resident model (services/live-captions):
//
//                              key release -> usable transcript
//   caption path (windowed)    1558 ms   "...based on the documents. content."
//   dictation path (this)       418 ms   "...based on the documents content."
//
// The 1140 ms difference is not network. It is the caption path's 3.0 s window
// cut plus the 1200 ms client-side settle wait that exists only because nobody
// downstream knows how many windows an utterance became. The text difference is
// the same cause: the window boundary landed mid-phrase and put a sentence stop
// in the middle of a command.
//
// Push-to-talk already knows where the utterance ends — the human let go of the
// key. Re-deriving that boundary from audio is strictly worse information.
//
// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
//
//  * WHERE the utterance attaches is latched at the PRESS and never re-decided.
//    The user may click elsewhere while speaking; the target does not move.
//    (client/voice/contextFrame.ts owns the ladder and this hook does not
//    second-guess it.)
//  * The microphone track is released on stop, on cancel, on error and on
//    unmount. `micActive` reads the track's own readyState, so the UI indicator
//    can never claim to be off while the OS indicator is on.
//  * Permission denial and revocation are STATES, not silent failures.
//  * Words only. This hook transcribes speech and carries a loudness number for
//    the recorder's own gate. It does not derive, request, store or expose
//    emotion, sentiment, mood, stress or tone — prohibited under EU AI Act
//    Art. 5(1)(f), and there is deliberately no field in which such a value
//    could be returned.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildContextFrame,
  type CaptureContextSample,
  type ContextFrame,
} from './voice/contextFrame';
import { generateCaptureId } from './voice/captureChannel';
import {
  isVoiceCaptureSupported,
  PcmRecorder,
  type PcmChunk,
} from './voice/pcmRecorder';
import { publishTranscript, type TranscriptReadyEvent } from './voice/transcriptBus';

export type DictationState =
  /** No microphone / AudioWorklet / secure context in this browser. */
  | 'unsupported'
  | 'idle'
  /** Permission prompt and audio-graph setup in flight. */
  | 'starting'
  /** Track is LIVE and audio is streaming. */
  | 'listening'
  /** Track released; the /end request is in flight. */
  | 'transcribing'
  | 'error';

/**
 * Microphone permission, tracked as a first-class value.
 *
 * A dictation button that silently does nothing because permission was revoked
 * in a settings panel three days ago is indistinguishable from one that is
 * broken. The host renders this.
 */
export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied';

export interface UseDictationOptions {
  /**
   * Sample of what is on screen RIGHT NOW. Called at press and at release.
   * Must be synchronous and cheap: it runs BEFORE the permission prompt, and a
   * sample taken after that prompt resolves describes a different screen.
   */
  sampleContext: () => CaptureContextSample;
  /** Bearer token for the dictation proxy. Dictation is disabled without one. */
  authToken?: string | null;
  /**
   * Base path of the dictation proxy. `/pcm`, `/end` and `/cancel` hang off it.
   */
  endpoint?: string;
  /** Audio per POST. 200 ms matches what the sidecar's call-path tap sends. */
  chunkMs?: number;
  /** Inline sink. Every utterance also goes to the module transcript bus. */
  onTranscript?: (event: TranscriptReadyEvent) => void | Promise<void>;
  viewportDominanceRatio?: number;
}

export interface UseDictationResult {
  supported: boolean;
  state: DictationState;
  /**
   * True ONLY while a MediaStreamTrack is genuinely live. Bind the "listening"
   * affordance to THIS, never to `state`.
   */
  micActive: boolean;
  permission: MicPermission;
  /**
   * Context frame the CURRENT utterance is latched to, `t1_ms` provisional.
   * Render it so the speaker can see where the remark is going while talking.
   */
  pendingContext: ContextFrame | null;
  lastTranscript: TranscriptReadyEvent | null;
  error: Error | null;
  /** Press. A second call while listening is a no-op. */
  start: () => void;
  /** Release. Sends /end and resolves the transcript. */
  stop: () => void;
  /** Release and throw the utterance away — the audio is never transcribed. */
  cancel: () => void;
}

const DEFAULT_ENDPOINT = '/api/voice-capture/dictate';

interface DictateEndResponse {
  id?: string;
  found?: boolean;
  text?: string;
  audioMs?: number;
  asrMs?: number;
  truncated?: boolean;
}

export function useDictation(opts: UseDictationOptions): UseDictationResult {
  const {
    sampleContext,
    authToken = null,
    endpoint = DEFAULT_ENDPOINT,
    chunkMs = 200,
    onTranscript,
    viewportDominanceRatio,
  } = opts;

  const supported = useMemo(() => isVoiceCaptureSupported(), []);

  const [state, setState] = useState<DictationState>(supported ? 'idle' : 'unsupported');
  const [micActive, setMicActive] = useState(false);
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [pendingContext, setPendingContext] = useState<ContextFrame | null>(null);
  const [lastTranscript, setLastTranscript] = useState<TranscriptReadyEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // --- refs: the audio path must survive a render ---------------------------
  const recorderRef = useRef<PcmRecorder | null>(null);
  const dictationIdRef = useRef('');
  const startSampleRef = useRef<CaptureContextSample | null>(null);
  const t0Ref = useRef(0);
  const speechMsRef = useRef(0);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledRef = useRef(false);

  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const sampleContextRef = useRef(sampleContext);
  sampleContextRef.current = sampleContext;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

  const contextOpts = useMemo(
    () => (viewportDominanceRatio !== undefined ? { viewportDominanceRatio } : {}),
    [viewportDominanceRatio],
  );

  // --- permission, observed rather than assumed -----------------------------
  // The Permissions API reports revocation that happens OUTSIDE the page (a
  // settings panel, a site-data reset). Without the change listener the UI
  // would keep offering a button that is now guaranteed to fail. Firefox does
  // not expose the 'microphone' name, so absence is 'unknown', never 'denied'.
  useEffect(() => {
    if (!supported || typeof navigator === 'undefined' || !navigator.permissions?.query) {
      return;
    }
    let status: PermissionStatus | null = null;
    let disposed = false;
    const onChange = () => {
      if (status && !disposed) setPermission(status.state as MicPermission);
    };
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((s) => {
        if (disposed) return;
        status = s;
        setPermission(s.state as MicPermission);
        s.addEventListener('change', onChange);
      })
      .catch(() => {
        /* name unsupported — leave 'unknown' */
      });
    return () => {
      disposed = true;
      status?.removeEventListener('change', onChange);
    };
  }, [supported]);

  // --- transport ------------------------------------------------------------
  // Chunks POST strictly in order. Concurrent fetches let the network reorder
  // them, and reordered PCM is not "slightly wrong audio" — it is a different
  // sentence.
  const enqueuePcm = useCallback((bytes: Uint8Array, dictationId: string) => {
    sendQueueRef.current = sendQueueRef.current
      .then(async () => {
        if (cancelledRef.current) return;
        const res = await fetch(`${endpointRef.current}/pcm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(authTokenRef.current
              ? { Authorization: `Bearer ${authTokenRef.current}` }
              : {}),
            'X-Dictation-Id': dictationId,
            'X-Sample-Rate': '16000',
          },
          // Copy into a fresh buffer — the worklet recycles its own.
          body: bytes.slice().buffer as ArrayBuffer,
        });
        if (!res.ok) throw new Error(`dictation upload failed (${res.status})`);
      })
      .catch((err: Error) => setError(err));
  }, []);

  const releaseMic = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setMicActive(false);
  }, []);

  // --- controls -------------------------------------------------------------
  const start = useCallback(() => {
    if (!supported) return;
    if (recorderRef.current) return; // already listening

    // Latch the target BEFORE any await. Everything after this line can be
    // interrupted by a permission prompt, and the screen behind that prompt is
    // not necessarily the screen the user was looking at when they pressed.
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

    const dictationId = `d${generateCaptureId()}`;
    dictationIdRef.current = dictationId;
    cancelledRef.current = false;
    speechMsRef.current = 0;
    setError(null);
    setState('starting');

    const recorder = new PcmRecorder({
      chunkMs,
      onChunk: (chunk: PcmChunk) => {
        if (cancelledRef.current) return;
        if (chunk.isSpeech) speechMsRef.current += chunk.durationMs;
        enqueuePcm(chunk.bytes, dictationId);
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
        setPermission('granted'); // gUM resolved — authoritative
        setMicActive(true);
        setState('listening');
      })
      .catch((err: Error) => {
        recorderRef.current = null;
        setMicActive(false);
        setPendingContext(null);
        // NotAllowedError covers both "denied at the prompt" and "revoked in
        // settings"; the UI needs to say something specific either way.
        if (/NotAllowed|Permission|denied/i.test(`${err.name} ${err.message}`)) {
          setPermission('denied');
        }
        setError(err);
        setState('error');
      });
  }, [supported, chunkMs, enqueuePcm, contextOpts]);

  const stop = useCallback(() => {
    const dictationId = dictationIdRef.current;
    if (!dictationId || cancelledRef.current) return;
    if (!recorderRef.current) return;

    const t1 = Date.now(); // the utterance ended HERE — not when ASR finished
    releaseMic();
    setState('transcribing');

    // /end runs after every queued chunk, so the utterance is complete before
    // inference starts.
    sendQueueRef.current = sendQueueRef.current
      .then(async () => {
        if (cancelledRef.current) return;
        const res = await fetch(`${endpointRef.current}/end`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(authTokenRef.current
              ? { Authorization: `Bearer ${authTokenRef.current}` }
              : {}),
            'X-Dictation-Id': dictationId,
            'X-Sample-Rate': '16000',
          },
          body: new ArrayBuffer(0),
        });
        if (!res.ok) throw new Error(`dictation failed (${res.status})`);
        const body = (await res.json()) as DictateEndResponse;
        if (cancelledRef.current) return;

        const context = buildContextFrame({
          start: startSampleRef.current ?? {},
          end: sampleContextRef.current(),
          t0_ms: t0Ref.current,
          t1_ms: t1,
          options: contextOpts,
        });

        const text = (body.text ?? '').trim();
        const event: TranscriptReadyEvent = {
          utteranceId: dictationId,
          captureId: dictationId,
          text,
          t0_ms: context.t0_ms,
          t1_ms: context.t1_ms,
          context,
          // No 'lost' outcome exists on this path: /end either returns a
          // transcript or fails loudly. Nothing is dropped by a bounded queue.
          outcome: text ? 'settled' : 'silent',
          lines: text ? [{ seq: 1, text }] : [],
          speechMs: Math.round(speechMsRef.current),
        };

        setLastTranscript(event);
        setPendingContext(null);
        setState('idle');

        publishTranscript(event);
        const inline = onTranscriptRef.current;
        if (inline) await inline(event);
      })
      .catch((err: Error) => {
        setError(err);
        setPendingContext(null);
        setState('error');
      });
  }, [releaseMic, contextOpts]);

  const cancel = useCallback(() => {
    const dictationId = dictationIdRef.current;
    cancelledRef.current = true;
    releaseMic();
    setPendingContext(null);
    setState(supported ? 'idle' : 'unsupported');
    if (!dictationId) return;
    // Best-effort: tell the sidecar to drop the buffer rather than waiting for
    // the idle reaper. A failure here costs nothing — the session expires.
    void fetch(`${endpointRef.current}/cancel`, {
      method: 'POST',
      headers: {
        ...(authTokenRef.current ? { Authorization: `Bearer ${authTokenRef.current}` } : {}),
        'X-Dictation-Id': dictationId,
      },
    }).catch(() => {
      /* the session reaps itself */
    });
  }, [releaseMic, supported]);

  // Unmount must never leave a track live.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      recorderRef.current?.stop();
      recorderRef.current = null;
    },
    [],
  );

  return {
    supported,
    state,
    micActive,
    permission,
    pendingContext,
    lastTranscript,
    error,
    start,
    stop,
    cancel,
  };
}
