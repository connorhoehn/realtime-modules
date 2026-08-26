"use strict";
// realtime-modules/src/client/voice/utteranceAggregator.ts
//
// Re-assembles one spoken thought out of the several caption lines the
// live-captions sidecar emits for it.
//
// Why this is needed at all: the sidecar cuts an ASR window at a HARD 3.0 s
// (LIVE_WINDOW_SECONDS) even mid-sentence, so "the second paragraph here is
// wrong, it should say quarterly not monthly" arrives as two or three separate
// caption lines. Its Window struct carries no timestamps, so the lines cannot
// be stitched by time on the receiving end either.
//
// What we do have is the per-participant monotonic `seq` the emitter assigns
// (services/live-captions/src/captions.py), and — because push-to-talk means
// WE own the utterance boundary — the knowledge of exactly when the audio
// started and stopped. So: collect every line that arrives while an utterance
// is open, sort by seq, join. That is a total order, because a capture session
// has exactly one participant.
//
// Pure — the caller supplies the clock. No timers, no React.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UtteranceAggregator = void 0;
const DEFAULTS = { settleMs: 1200, maxWaitMs: 8000, minSpeechMs: 400 };
/**
 * Collects lines for exactly one utterance.
 *
 * Lifecycle: `new` (audio starts) -> `accept()` per line -> `closeAudio()`
 * (push-to-talk released, silence tail flushed) -> `evaluate(now)` polled until
 * it returns a result.
 */
class UtteranceAggregator {
    opts;
    bySeq = new Map();
    startedAt;
    lastLineAt = 0;
    audioClosedAt = null;
    speechMs = 0;
    /** Fallback ordering for lines that somehow arrive without a seq. */
    syntheticSeq = -1;
    constructor(startedAt, opts = {}) {
        this.startedAt = startedAt;
        this.opts = { ...DEFAULTS, ...opts };
    }
    /** Record client-side detected speech so 'lost' can be distinguished from 'silent'. */
    addSpeechMs(ms) {
        this.speechMs += ms;
    }
    get detectedSpeechMs() {
        return this.speechMs;
    }
    /** Ingest one caption line. Duplicate seqs replace (the sidecar may resend). */
    accept(line, now) {
        const text = (line.text ?? '').trim();
        if (!text)
            return;
        const seq = typeof line.seq === 'number' ? line.seq : this.syntheticSeq--;
        this.bySeq.set(seq, text);
        this.lastLineAt = now;
    }
    /** Push-to-talk released and the flush tail has been sent. */
    closeAudio(now) {
        if (this.audioClosedAt === null)
            this.audioClosedAt = now;
    }
    get closed() {
        return this.audioClosedAt !== null;
    }
    /** Best-effort text so far — for a live "what it heard" preview. */
    currentText() {
        return [...this.bySeq.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, t]) => t)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    /**
     * Has this utterance finished? Returns null while still collecting.
     *
     * Deliberately does not finalize before the audio is closed: a mid-utterance
     * pause of >settleMs is common (people think mid-sentence) and cutting there
     * would split one remark into two comments.
     */
    evaluate(now) {
        if (this.audioClosedAt === null)
            return null;
        const waited = now - this.audioClosedAt;
        const quiet = this.lastLineAt === 0 ? waited : now - this.lastLineAt;
        const haveText = this.bySeq.size > 0;
        if (haveText && quiet >= this.opts.settleMs)
            return this.finish('settled', now);
        if (waited >= this.opts.maxWaitMs) {
            if (haveText)
                return this.finish('timeout', now);
            return this.finish(this.speechMs >= this.opts.minSpeechMs ? 'lost' : 'silent', now);
        }
        // No text yet, but we detected no speech either — no point waiting out the
        // full ceiling for a transcript that was never going to exist.
        if (!haveText && this.speechMs < this.opts.minSpeechMs && quiet >= this.opts.settleMs) {
            return this.finish('silent', now);
        }
        return null;
    }
    /** Abandon — used by cancel(). */
    cancel(now) {
        return this.finish('cancelled', now, '');
    }
    finish(outcome, now, override) {
        const lines = [...this.bySeq.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([seq, text]) => ({ seq, text }));
        return {
            text: override ?? this.currentText(),
            outcome,
            lines: override === '' ? [] : lines,
            startedAt: this.startedAt,
            endedAt: now,
            speechMs: Math.round(this.speechMs),
        };
    }
}
exports.UtteranceAggregator = UtteranceAggregator;
//# sourceMappingURL=utteranceAggregator.js.map