import { type CaptureContextSample, type ContextFrame } from './contextFrame';
import { type TranscriptReadyEvent } from './transcriptBus';
export type VoiceCaptureState = 'unsupported' | 'idle'
/** Mic permission / graph setup in flight. */
 | 'starting'
/** Track is LIVE and audio is being sent. */
 | 'listening'
/** Track released; waiting for the tail of the transcript. */
 | 'transcribing' | 'error';
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
export declare function useVoiceCapture(opts: UseVoiceCaptureOptions): UseVoiceCaptureResult;
//# sourceMappingURL=useVoiceCapture.d.ts.map