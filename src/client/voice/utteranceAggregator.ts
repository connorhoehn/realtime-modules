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
  | 'settled'
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
  lines: Array<{ seq: number; text: string }>;
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

const DEFAULTS = { settleMs: 1200, maxWaitMs: 8000, minSpeechMs: 400 };

/**
 * Collects lines for exactly one utterance.
 *
 * Lifecycle: `new` (audio starts) -> `accept()` per line -> `closeAudio()`
 * (push-to-talk released, silence tail flushed) -> `evaluate(now)` polled until
 * it returns a result.
 */
export class UtteranceAggregator {
  private readonly opts: Required<AggregatorOptions>;
  private readonly bySeq = new Map<number, string>();
  private readonly startedAt: number;
  private lastLineAt = 0;
  private audioClosedAt: number | null = null;
  private speechMs = 0;
  /** Fallback ordering for lines that somehow arrive without a seq. */
  private syntheticSeq = -1;

  constructor(startedAt: number, opts: AggregatorOptions = {}) {
    this.startedAt = startedAt;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Record client-side detected speech so 'lost' can be distinguished from 'silent'. */
  addSpeechMs(ms: number): void {
    this.speechMs += ms;
  }

  get detectedSpeechMs(): number {
    return this.speechMs;
  }

  /** Ingest one caption line. Duplicate seqs replace (the sidecar may resend). */
  accept(line: CaptionLineIn, now: number): void {
    const text = (line.text ?? '').trim();
    if (!text) return;
    const seq = typeof line.seq === 'number' ? line.seq : this.syntheticSeq--;
    this.bySeq.set(seq, text);
    this.lastLineAt = now;
  }

  /** Push-to-talk released and the flush tail has been sent. */
  closeAudio(now: number): void {
    if (this.audioClosedAt === null) this.audioClosedAt = now;
  }

  get closed(): boolean {
    return this.audioClosedAt !== null;
  }

  /** Best-effort text so far — for a live "what it heard" preview. */
  currentText(): string {
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
  evaluate(now: number): AggregatedUtterance | null {
    if (this.audioClosedAt === null) return null;

    const waited = now - this.audioClosedAt;
    const quiet = this.lastLineAt === 0 ? waited : now - this.lastLineAt;
    const haveText = this.bySeq.size > 0;

    if (haveText && quiet >= this.opts.settleMs) return this.finish('settled', now);
    if (waited >= this.opts.maxWaitMs) {
      if (haveText) return this.finish('timeout', now);
      return this.finish(
        this.speechMs >= this.opts.minSpeechMs ? 'lost' : 'silent',
        now,
      );
    }
    // No text yet, but we detected no speech either — no point waiting out the
    // full ceiling for a transcript that was never going to exist.
    if (!haveText && this.speechMs < this.opts.minSpeechMs && quiet >= this.opts.settleMs) {
      return this.finish('silent', now);
    }
    return null;
  }

  /** Abandon — used by cancel(). */
  cancel(now: number): AggregatedUtterance {
    return this.finish('cancelled', now, '');
  }

  private finish(
    outcome: UtteranceOutcome,
    now: number,
    override?: string,
  ): AggregatedUtterance {
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
