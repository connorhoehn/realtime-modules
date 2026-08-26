"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useVoiceCapture = useVoiceCapture;
const react_1 = require("react");
const captureChannel_1 = require("./captureChannel");
const contextFrame_1 = require("./contextFrame");
const pcmRecorder_1 = require("./pcmRecorder");
const pcm_1 = require("./pcm");
const transcriptBus_1 = require("./transcriptBus");
const utteranceAggregator_1 = require("./utteranceAggregator");
const DEFAULT_ENDPOINT = '/api/voice-capture/pcm';
const POLL_MS = 150;
function useVoiceCapture(opts) {
    const { authToken, sampleContext, onTranscript, subscribe, sendMessage, endpoint = DEFAULT_ENDPOINT, chunkMs = 200, flushMs = 900, settleMs, maxWaitMs, viewportDominanceRatio, } = opts;
    const supported = (0, react_1.useMemo)(() => (0, pcmRecorder_1.isVoiceCaptureSupported)(), []);
    const captureId = (0, react_1.useMemo)(() => opts.captureId ?? (supported ? (0, captureChannel_1.generateCaptureId)() : 'unsupported'), [opts.captureId, supported]);
    const routingKey = (0, react_1.useMemo)(() => (0, captureChannel_1.captureRoutingKey)(captureId), [captureId]);
    const [channel, setChannel] = (0, react_1.useState)(null);
    const [state, setState] = (0, react_1.useState)(supported ? 'idle' : 'unsupported');
    const [micActive, setMicActive] = (0, react_1.useState)(false);
    const [liveText, setLiveText] = (0, react_1.useState)('');
    const [lastTranscript, setLastTranscript] = (0, react_1.useState)(null);
    const [pendingContext, setPendingContext] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    // --- refs: the audio path must not be re-created by a render -------------
    const recorderRef = (0, react_1.useRef)(null);
    const aggRef = (0, react_1.useRef)(null);
    const utteranceIdRef = (0, react_1.useRef)('');
    const startSampleRef = (0, react_1.useRef)(null);
    const t0Ref = (0, react_1.useRef)(0);
    const sendQueueRef = (0, react_1.useRef)(Promise.resolve());
    const cancelledRef = (0, react_1.useRef)(false);
    const authTokenRef = (0, react_1.useRef)(authToken);
    authTokenRef.current = authToken;
    const sampleContextRef = (0, react_1.useRef)(sampleContext);
    sampleContextRef.current = sampleContext;
    const onTranscriptRef = (0, react_1.useRef)(onTranscript);
    onTranscriptRef.current = onTranscript;
    const sendMessageRef = (0, react_1.useRef)(sendMessage);
    sendMessageRef.current = sendMessage;
    const contextOpts = (0, react_1.useMemo)(() => (viewportDominanceRatio !== undefined ? { viewportDominanceRatio } : {}), [viewportDominanceRatio]);
    // --- caption channel subscription ---------------------------------------
    // Subscribed on MOUNT, not on press. The relay is stateless fan-out with no
    // replay, so subscribing at press time would race the first caption line
    // straight into the void.
    (0, react_1.useEffect)(() => {
        if (!supported)
            return;
        let disposed = false;
        (0, captureChannel_1.captureWsChannel)(routingKey)
            .then((ch) => {
            if (!disposed)
                setChannel(ch);
        })
            .catch((err) => setError(err));
        return () => {
            disposed = true;
        };
    }, [routingKey, supported]);
    (0, react_1.useEffect)(() => {
        if (!channel)
            return;
        sendMessageRef.current({ service: 'subscribe', action: 'subscribe', channel });
        return () => {
            sendMessageRef.current({ service: 'subscribe', action: 'unsubscribe', channel });
        };
    }, [channel]);
    (0, react_1.useEffect)(() => {
        if (!channel)
            return;
        return subscribe((msg) => {
            const m = msg;
            if (m?.type !== 'caption' || m.channel !== channel)
                return;
            const line = m.data;
            if (!line)
                return;
            // Late lines from a PREVIOUS utterance can never be mis-assigned: each
            // utterance gets its own participantId, which is also what gives it a
            // fresh accumulator on the sidecar.
            if (line.participantId && line.participantId !== utteranceIdRef.current)
                return;
            const agg = aggRef.current;
            if (!agg)
                return;
            agg.accept(line, Date.now());
            setLiveText(agg.currentText());
        });
    }, [channel, subscribe]);
    // --- transport ------------------------------------------------------------
    // Chunks are POSTed strictly in order. Concurrent fetches would let the
    // network reorder them, and reordered PCM is not "slightly wrong audio" — it
    // is a different sentence.
    const postPcm = (0, react_1.useCallback)((bytes, utteranceId, flush) => {
        const token = authTokenRef.current;
        if (!token)
            return;
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
                body: bytes.slice().buffer,
            });
            if (!res.ok)
                throw new Error(`capture proxy ${res.status}`);
        })
            .catch((err) => {
            setError(err);
        });
    }, [endpoint, captureId]);
    // --- finalize loop --------------------------------------------------------
    (0, react_1.useEffect)(() => {
        if (state !== 'transcribing')
            return;
        const timer = setInterval(() => {
            const agg = aggRef.current;
            if (!agg)
                return;
            const now = Date.now();
            const done = agg.evaluate(now);
            if (!done)
                return;
            aggRef.current = null;
            const context = (0, contextFrame_1.buildContextFrame)({
                start: startSampleRef.current ?? {},
                end: sampleContextRef.current(),
                t0_ms: t0Ref.current,
                // The utterance ENDED when the audio stopped, not when its transcript
                // finished arriving. ASR lag must not widen the span a consumer sees.
                t1_ms: done.endedAt,
                options: contextOpts,
            });
            const event = {
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
            (0, transcriptBus_1.publishTranscript)(event);
            const inline = onTranscriptRef.current;
            if (inline) {
                try {
                    const ret = inline(event);
                    if (ret && typeof ret.catch === 'function') {
                        ret.catch((err) => setError(err));
                    }
                }
                catch (err) {
                    setError(err);
                }
            }
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [state, captureId, contextOpts]);
    // --- controls -------------------------------------------------------------
    const start = (0, react_1.useCallback)(() => {
        if (!supported)
            return;
        if (!authTokenRef.current) {
            setError(new Error('voice capture requires an auth token'));
            return;
        }
        if (recorderRef.current)
            return; // already listening
        // Latch the target BEFORE any await.
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
        // A fresh participant id per utterance gives us a fresh accumulator on the
        // sidecar — otherwise a sub-threshold remark stays buffered and gets
        // prepended to the NEXT one, attached to the next one's target.
        const utteranceId = (0, captureChannel_1.generateCaptureId)();
        utteranceIdRef.current = utteranceId;
        cancelledRef.current = false;
        setError(null);
        setLiveText('');
        setState('starting');
        const agg = new utteranceAggregator_1.UtteranceAggregator(t0, {
            ...(settleMs !== undefined ? { settleMs } : {}),
            ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
        });
        aggRef.current = agg;
        const recorder = new pcmRecorder_1.PcmRecorder({
            chunkMs,
            onChunk: (chunk) => {
                if (cancelledRef.current)
                    return;
                if (chunk.isSpeech)
                    agg.addSpeechMs(chunk.durationMs);
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
            .catch((err) => {
            recorderRef.current = null;
            aggRef.current = null;
            setMicActive(false);
            setPendingContext(null);
            setError(err);
            setState('error');
        });
    }, [supported, chunkMs, postPcm, settleMs, maxWaitMs, contextOpts]);
    const releaseMic = (0, react_1.useCallback)(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
        setMicActive(false);
    }, []);
    const stop = (0, react_1.useCallback)(() => {
        if (!recorderRef.current && !aggRef.current)
            return;
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
        postPcm((0, pcm_1.silenceBytes)(flushMs), utteranceId, true);
        agg.closeAudio(Date.now());
        setState('transcribing');
    }, [releaseMic, postPcm, flushMs]);
    const cancel = (0, react_1.useCallback)(() => {
        cancelledRef.current = true;
        releaseMic();
        aggRef.current = null;
        startSampleRef.current = null;
        setLiveText('');
        setPendingContext(null);
        setState(supported ? 'idle' : 'unsupported');
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
//# sourceMappingURL=useVoiceCapture.js.map