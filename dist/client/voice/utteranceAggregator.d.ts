/** A caption line as it arrives off the wire from the gateway relay. */
export interface CaptionLineIn {
    id?: string;
    seq?: number;
    text?: string;
    participantId?: string;
    at?: string;
}
/** Why an utterance stopped collecting. */
export type UtteranceOutcome = 
/** Lines arrived and the stream went quiet — normal completion. */
'settled'
/**
 * We waited `maxWaitMs` and lines were still trickling (or never stopped).
 * The text is whatever we have. Surfaced rather than hidden because the
 * sidecar's ASR queue drops the OLDEST window when it is behind.
 */
 | 'timeout'
/**
 * We sent audio the client's own RMS gate scored as speech, and NOTHING came
 * back. The most likely cause is a dropped window: the queue is bounded at 8
 * with drop-oldest and has no metrics endpoint, so this is the only place a
 * lost utterance can be noticed at all. Never silently treat it as silence.
 */
 | 'lost'
/** No speech was detected client-side. Nothing was said; not an error. */
 | 'silent'
/** The human cancelled. Audio and text are discarded. */
 | 'cancelled';
export interface AggregatedUtterance {
    text: string;
    outcome: UtteranceOutcome;
    /** Lines the sidecar produced for this utterance, in seq order. */
    lines: Array<{
        seq: number;
        text: string;
    }>;
    startedAt: number;
    endedAt: number;
    /** Milliseconds of audio the client's RMS gate scored as speech. */
    speechMs: number;
}
export interface AggregatorOptions {
    /**
     * Quiet period after the last line before we call an utterance done. Must
     * comfortably exceed one ASR inference (~0.3–1 s warm on CPU for a 3 s
     * window) or a long utterance finalizes with its tail missing.
     */
    settleMs?: number;
    /** Absolute ceiling on waiting for transcripts after the audio stops. */
    maxWaitMs?: number;
    /** Below this much detected speech, treat the utterance as silence. */
    minSpeechMs?: number;
}
/**
 * Collects lines for exactly one utterance.
 *
 * Lifecycle: `new` (audio starts) -> `accept()` per line -> `closeAudio()`
 * (push-to-talk released, silence tail flushed) -> `evaluate(now)` polled until
 * it returns a result.
 */
export declare class UtteranceAggregator {
    private readonly opts;
    private readonly bySeq;
    private readonly startedAt;
    private lastLineAt;
    private audioClosedAt;
    private speechMs;
    /** Fallback ordering for lines that somehow arrive without a seq. */
    private syntheticSeq;
    constructor(startedAt: number, opts?: AggregatorOptions);
    /** Record client-side detected speech so 'lost' can be distinguished from 'silent'. */
    addSpeechMs(ms: number): void;
    get detectedSpeechMs(): number;
    /** Ingest one caption line. Duplicate seqs replace (the sidecar may resend). */
    accept(line: CaptionLineIn, now: number): void;
    /** Push-to-talk released and the flush tail has been sent. */
    closeAudio(now: number): void;
    get closed(): boolean;
    /** Best-effort text so far — for a live "what it heard" preview. */
    currentText(): string;
    /**
     * Has this utterance finished? Returns null while still collecting.
     *
     * Deliberately does not finalize before the audio is closed: a mid-utterance
     * pause of >settleMs is common (people think mid-sentence) and cutting there
     * would split one remark into two comments.
     */
    evaluate(now: number): AggregatedUtterance | null;
    /** Abandon — used by cancel(). */
    cancel(now: number): AggregatedUtterance;
    private finish;
}
//# sourceMappingURL=utteranceAggregator.d.ts.map