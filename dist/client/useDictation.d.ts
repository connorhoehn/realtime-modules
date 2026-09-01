import { type CaptureContextSample, type ContextFrame } from './voice/contextFrame';
import { type TranscriptReadyEvent } from './voice/transcriptBus';
export type DictationState = 
/** No microphone / AudioWorklet / secure context in this browser. */
'unsupported' | 'idle'
/** Permission prompt and audio-graph setup in flight. */
 | 'starting'
/** Track is LIVE and audio is streaming. */
 | 'listening'
/** Track released; the /end request is in flight. */
 | 'transcribing' | 'error';
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
export declare function useDictation(opts: UseDictationOptions): UseDictationResult;
//# sourceMappingURL=useDictation.d.ts.map