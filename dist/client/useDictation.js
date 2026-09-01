"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDictation = useDictation;
const react_1 = require("react");
const contextFrame_1 = require("./voice/contextFrame");
const captureChannel_1 = require("./voice/captureChannel");
const pcmRecorder_1 = require("./voice/pcmRecorder");
const transcriptBus_1 = require("./voice/transcriptBus");
const DEFAULT_ENDPOINT = '/api/voice-capture/dictate';
function useDictation(opts) {
    const { sampleContext, authToken = null, endpoint = DEFAULT_ENDPOINT, chunkMs = 200, onTranscript, viewportDominanceRatio, } = opts;
    const supported = (0, react_1.useMemo)(() => (0, pcmRecorder_1.isVoiceCaptureSupported)(), []);
    const [state, setState] = (0, react_1.useState)(supported ? 'idle' : 'unsupported');
    const [micActive, setMicActive] = (0, react_1.useState)(false);
    const [permission, setPermission] = (0, react_1.useState)('unknown');
    const [pendingContext, setPendingContext] = (0, react_1.useState)(null);
    const [lastTranscript, setLastTranscript] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    // --- refs: the audio path must survive a render ---------------------------
    const recorderRef = (0, react_1.useRef)(null);
    const dictationIdRef = (0, react_1.useRef)('');
    const startSampleRef = (0, react_1.useRef)(null);
    const t0Ref = (0, react_1.useRef)(0);
    const speechMsRef = (0, react_1.useRef)(0);
    const sendQueueRef = (0, react_1.useRef)(Promise.resolve());
    const cancelledRef = (0, react_1.useRef)(false);
    const authTokenRef = (0, react_1.useRef)(authToken);
    authTokenRef.current = authToken;
    const sampleContextRef = (0, react_1.useRef)(sampleContext);
    sampleContextRef.current = sampleContext;
    const onTranscriptRef = (0, react_1.useRef)(onTranscript);
    onTranscriptRef.current = onTranscript;
    const endpointRef = (0, react_1.useRef)(endpoint);
    endpointRef.current = endpoint;
    const contextOpts = (0, react_1.useMemo)(() => (viewportDominanceRatio !== undefined ? { viewportDominanceRatio } : {}), [viewportDominanceRatio]);
    // --- permission, observed rather than assumed -----------------------------
    // The Permissions API reports revocation that happens OUTSIDE the page (a
    // settings panel, a site-data reset). Without the change listener the UI
    // would keep offering a button that is now guaranteed to fail. Firefox does
    // not expose the 'microphone' name, so absence is 'unknown', never 'denied'.
    (0, react_1.useEffect)(() => {
        if (!supported || typeof navigator === 'undefined' || !navigator.permissions?.query) {
            return;
        }
        let status = null;
        let disposed = false;
        const onChange = () => {
            if (status && !disposed)
                setPermission(status.state);
        };
        navigator.permissions
            .query({ name: 'microphone' })
            .then((s) => {
            if (disposed)
                return;
            status = s;
            setPermission(s.state);
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
    const enqueuePcm = (0, react_1.useCallback)((bytes, dictationId) => {
        sendQueueRef.current = sendQueueRef.current
            .then(async () => {
            if (cancelledRef.current)
                return;
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
                body: bytes.slice().buffer,
            });
            if (!res.ok)
                throw new Error(`dictation upload failed (${res.status})`);
        })
            .catch((err) => setError(err));
    }, []);
    const releaseMic = (0, react_1.useCallback)(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
        setMicActive(false);
    }, []);
    // --- controls -------------------------------------------------------------
    const start = (0, react_1.useCallback)(() => {
        if (!supported)
            return;
        if (recorderRef.current)
            return; // already listening
        // Latch the target BEFORE any await. Everything after this line can be
        // interrupted by a permission prompt, and the screen behind that prompt is
        // not necessarily the screen the user was looking at when they pressed.
        const startSample = sampleContextRef.current();
        const t0 = Date.now();
        startSampleRef.current = startSample;
        t0Ref.current = t0;
        setPendingContext((0, contextFrame_1.buildContextFrame)({
            start: startSample,
            end: startSample,
            t0_ms: t0,
            t1_ms: t0,
            options: contextOpts,
        }));
        const dictationId = `d${(0, captureChannel_1.generateCaptureId)()}`;
        dictationIdRef.current = dictationId;
        cancelledRef.current = false;
        speechMsRef.current = 0;
        setError(null);
        setState('starting');
        const recorder = new pcmRecorder_1.PcmRecorder({
            chunkMs,
            onChunk: (chunk) => {
                if (cancelledRef.current)
                    return;
                if (chunk.isSpeech)
                    speechMsRef.current += chunk.durationMs;
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
            .catch((err) => {
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
    const stop = (0, react_1.useCallback)(() => {
        const dictationId = dictationIdRef.current;
        if (!dictationId || cancelledRef.current)
            return;
        if (!recorderRef.current)
            return;
        const t1 = Date.now(); // the utterance ended HERE — not when ASR finished
        releaseMic();
        setState('transcribing');
        // /end runs after every queued chunk, so the utterance is complete before
        // inference starts.
        sendQueueRef.current = sendQueueRef.current
            .then(async () => {
            if (cancelledRef.current)
                return;
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
            if (!res.ok)
                throw new Error(`dictation failed (${res.status})`);
            const body = (await res.json());
            if (cancelledRef.current)
                return;
            const context = (0, contextFrame_1.buildContextFrame)({
                start: startSampleRef.current ?? {},
                end: sampleContextRef.current(),
                t0_ms: t0Ref.current,
                t1_ms: t1,
                options: contextOpts,
            });
            const text = (body.text ?? '').trim();
            const event = {
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
            (0, transcriptBus_1.publishTranscript)(event);
            const inline = onTranscriptRef.current;
            if (inline)
                await inline(event);
        })
            .catch((err) => {
            setError(err);
            setPendingContext(null);
            setState('error');
        });
    }, [releaseMic, contextOpts]);
    const cancel = (0, react_1.useCallback)(() => {
        const dictationId = dictationIdRef.current;
        cancelledRef.current = true;
        releaseMic();
        setPendingContext(null);
        setState(supported ? 'idle' : 'unsupported');
        if (!dictationId)
            return;
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
    (0, react_1.useEffect)(() => () => {
        cancelledRef.current = true;
        recorderRef.current?.stop();
        recorderRef.current = null;
    }, []);
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
//# sourceMappingURL=useDictation.js.map