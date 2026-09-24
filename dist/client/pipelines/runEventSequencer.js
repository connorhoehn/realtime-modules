"use strict";
// realtime-modules/src/client/pipelines/runEventSequencer.ts
//
// Put a run's progress frames back in the order the platform emitted them
// (realtime-examples NFR #170, tightened in Loop 30).
//
// With several gateway replicas sharing the MQ `pipeline-events` work queue,
// a client can hear `step.started` before the `run.started` that preceded
// it. platform-api numbers every progress event of a run 1, 2, 3 …
// (`payload.runSeq`). The sequencer:
//
//   * releases a frame at once when it is the next number, or has no number
//     (tokens, checkpoints, older platforms), or its number already passed
//     (late, or a resumed run starting again at 1) — late beats lost;
//   * holds a frame only when an earlier number is actually missing;
//   * waits for the gap at most an adaptive timeout — a little over the
//     observed time gaps take to fill (p95 × 1.5 + 10 ms), between
//     `minGapMs` and `maxGapMs` (150 ms), starting at the cap until it has
//     seen a few — then releases what it holds in order and asks the host to
//     re-read the run's durable state (`onGap`) rather than waiting longer;
//   * when the missing number is 1, delivers a synthesized `run.started`
//     first, so a reducer never sees a step for a run that has not started.
//     The real one, if it lands later, is delivered as a late frame.
//
// Pure (no React): the Activity pane, the run page and the chat run card use
// the same one.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunEventSequencer = void 0;
exports.synthesizeRunStarted = synthesizeRunStarted;
const SAMPLE_WINDOW = 32;
const MIN_SAMPLES = 4;
function sequenceOf(frame) {
    const p = frame.payload;
    if (!p || typeof p !== 'object')
        return null;
    if (typeof p.runId !== 'string' || !p.runId)
        return null;
    if (typeof p.runSeq !== 'number' || !Number.isInteger(p.runSeq) || p.runSeq < 1)
        return null;
    return { runId: p.runId, runSeq: p.runSeq, pipelineId: typeof p.pipelineId === 'string' ? p.pipelineId : undefined };
}
/** The stand-in start: the run's ids from the first held frame, marked `synthesized`. */
function synthesizeRunStarted(first) {
    const p = (first.payload ?? {});
    const payload = { runId: p.runId, runSeq: 1, synthesized: true };
    for (const k of ['pipelineId', 'runOwnerId', 'triggeredBy', 'pipelineVersion'])
        if (p[k] !== undefined)
            payload[k] = p[k];
    // Both spellings the reducers read: `startedAt` (run cards), `at` (the run page).
    payload.startedAt = typeof first.emittedAt === 'number' ? new Date(first.emittedAt).toISOString() : new Date().toISOString();
    payload.at = payload.startedAt;
    return { ...first, eventType: 'pipeline.run.started', payload, emittedAt: first.emittedAt };
}
class RunEventSequencer {
    runs = new Map();
    opts;
    now;
    setTimer;
    clearTimer;
    samples = [];
    /** Frames released after waiting on a gap that never filled. */
    gapsTimedOut = 0;
    /** Frames that arrived ahead of an earlier one and were held. */
    reordered = 0;
    /** Frames that arrived after their number was passed. */
    late = 0;
    /** `run.started` frames synthesized for a run whose start never arrived in time. */
    synthesized = 0;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? (() => Date.now());
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    }
    /** The wait a new gap gets now. */
    gapWaitMs() {
        if (typeof this.opts.gapMs === 'number')
            return this.opts.gapMs;
        const min = this.opts.minGapMs ?? 20;
        const max = this.opts.maxGapMs ?? 150;
        if (this.samples.length < MIN_SAMPLES)
            return max;
        const sorted = [...this.samples].sort((a, b) => a - b);
        const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
        return Math.max(min, Math.min(max, Math.ceil(p95 * 1.5 + 10)));
    }
    push(frame) {
        const seq = sequenceOf(frame);
        if (!seq) {
            this.opts.deliver(frame);
            return;
        }
        const run = this.runFor(seq.runId);
        const at = this.now();
        if (run.next === null && seq.runSeq === 1)
            run.next = 1;
        if (run.next !== null && seq.runSeq < run.next) {
            this.late += 1;
            // It missed a timeout: let the adaptive wait learn how late it was.
            if (seq.runSeq <= run.timedOutBelow)
                this.sample(this.gapWaitMs() + (at - run.timedOutAt));
            this.opts.deliver(frame);
            return;
        }
        if (run.next !== null && seq.runSeq === run.next) {
            this.opts.deliver(frame);
            run.next += 1;
            this.drain(run, at);
            return;
        }
        if (!run.held.has(seq.runSeq)) {
            run.held.set(seq.runSeq, { frame, at });
            this.reordered += 1;
        }
        if (run.timer == null) {
            run.timer = this.setTimer(() => { run.timer = null; this.timeout(seq.runId, run); }, this.gapWaitMs());
        }
    }
    /** Release every held frame now, in order (e.g. on unmount). No `onGap`. */
    flushAll() {
        for (const run of this.runs.values())
            this.release(run, false);
    }
    runFor(runId) {
        let run = this.runs.get(runId);
        if (run)
            return run;
        run = { next: null, held: new Map(), timer: null, timedOutBelow: 0, timedOutAt: 0 };
        this.runs.set(runId, run);
        while (this.runs.size > (this.opts.maxRuns ?? 500)) {
            const [oldestKey, oldest] = this.runs.entries().next().value;
            this.release(oldest, false);
            this.runs.delete(oldestKey);
        }
        return run;
    }
    sample(ms) {
        this.samples.push(Math.max(0, ms));
        if (this.samples.length > SAMPLE_WINDOW)
            this.samples.shift();
    }
    drain(run, at) {
        let oldestHold = null;
        while (run.next !== null && run.held.has(run.next)) {
            const h = run.held.get(run.next);
            oldestHold = oldestHold === null ? h.at : Math.min(oldestHold, h.at);
            run.held.delete(run.next);
            this.opts.deliver(h.frame);
            run.next += 1;
        }
        // How long the gap took to fill: the adaptive wait's evidence.
        if (oldestHold !== null)
            this.sample(at - oldestHold);
        if (run.held.size === 0 && run.timer != null) {
            this.clearTimer(run.timer);
            run.timer = null;
        }
    }
    timeout(runId, run) {
        if (run.held.size === 0)
            return;
        const numbers = [...run.held.keys()].sort((a, b) => a - b);
        const from = run.next ?? 1;
        const missing = [];
        for (let n = from; n < numbers[numbers.length - 1]; n += 1)
            if (!run.held.has(n))
                missing.push(n);
        const first = run.held.get(numbers[0]).frame;
        const synthesizedStart = this.release(run, true);
        run.timedOutBelow = numbers[numbers.length - 1];
        run.timedOutAt = this.now();
        const pipelineId = sequenceOf(first)?.pipelineId;
        this.opts.onGap?.({ runId, ...(pipelineId ? { pipelineId } : {}), missing, synthesizedStart });
    }
    /** Deliver everything held, in order; returns whether a start was synthesized. */
    release(run, timedOut) {
        if (run.timer != null) {
            this.clearTimer(run.timer);
            run.timer = null;
        }
        if (run.held.size === 0)
            return false;
        const numbers = [...run.held.keys()].sort((a, b) => a - b);
        let synthesizedStart = false;
        if (run.next === null && this.opts.synthesizeStart !== false) {
            const first = run.held.get(numbers[0]).frame;
            const start = typeof this.opts.synthesizeStart === 'function'
                ? this.opts.synthesizeStart(first)
                : synthesizeRunStarted(first);
            if (start) {
                this.opts.deliver(start);
                this.synthesized += 1;
                synthesizedStart = true;
            }
        }
        if (timedOut)
            this.gapsTimedOut += numbers.length;
        for (const n of numbers) {
            this.opts.deliver(run.held.get(n).frame);
            run.held.delete(n);
        }
        run.next = numbers[numbers.length - 1] + 1;
        return synthesizedStart;
    }
}
exports.RunEventSequencer = RunEventSequencer;
//# sourceMappingURL=runEventSequencer.js.map