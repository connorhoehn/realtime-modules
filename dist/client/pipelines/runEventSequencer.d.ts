export interface SequencedFrame {
    eventType?: string;
    payload?: unknown;
    emittedAt?: number;
}
export interface RunSequenceGap {
    runId: string;
    pipelineId?: string;
    /** The numbers still missing when the wait ended. */
    missing: number[];
    /** A `run.started` was synthesized because number 1 never arrived. */
    synthesizedStart: boolean;
}
export interface RunEventSequencerOptions<F extends SequencedFrame> {
    deliver: (frame: F) => void;
    /** Called after a gap timed out: re-read the run's durable state. */
    onGap?: (gap: RunSequenceGap) => void;
    /** A fixed gap wait (disables the adaptive one). */
    gapMs?: number;
    /** Adaptive wait bounds. Defaults 20 / 150 ms. */
    minGapMs?: number;
    maxGapMs?: number;
    /** Build the stand-in `run.started`; default copies the run's ids. Return null to skip. */
    synthesizeStart?: ((first: F) => F | null) | false;
    maxRuns?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
}
/** The stand-in start: the run's ids from the first held frame, marked `synthesized`. */
export declare function synthesizeRunStarted<F extends SequencedFrame>(first: F): F;
export declare class RunEventSequencer<F extends SequencedFrame> {
    private readonly runs;
    private readonly opts;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly samples;
    /** Frames released after waiting on a gap that never filled. */
    gapsTimedOut: number;
    /** Frames that arrived ahead of an earlier one and were held. */
    reordered: number;
    /** Frames that arrived after their number was passed. */
    late: number;
    /** `run.started` frames synthesized for a run whose start never arrived in time. */
    synthesized: number;
    constructor(opts: RunEventSequencerOptions<F>);
    /** The wait a new gap gets now. */
    gapWaitMs(): number;
    push(frame: F): void;
    /** Release every held frame now, in order (e.g. on unmount). No `onGap`. */
    flushAll(): void;
    private runFor;
    private sample;
    private drain;
    private timeout;
    /** Deliver everything held, in order; returns whether a start was synthesized. */
    private release;
}
//# sourceMappingURL=runEventSequencer.d.ts.map