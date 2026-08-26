// realtime-modules/src/client/voice/transcriptBus.ts
//
// One published transcript, many consumers.
//
// The capture hook must not know what happens to an utterance. Phase 1 has two
// sinks already — attach as a document comment, and raise a work item for the
// proposal/acceptance lane — and hardwiring either into `useVoiceCapture` would
// make the second one a fork of the first. So the hook publishes here and sinks
// subscribe.
//
// Deliberately a plain in-process emitter: no queue, no replay, no persistence.
// A transcript is delivered to whoever is listening at the moment it completes.
// If a sink needs durability it should persist on receipt — that is a decision
// for the sink, and this module has no opinion about it.

import type { ContextFrame } from './contextFrame';
import type { UtteranceOutcome } from './utteranceAggregator';

/**
 * PUBLISHED CONTRACT. Everything a sink needs to decide what to do with a
 * spoken remark, and nothing about how it was captured.
 *
 * `text` is the re-aggregated transcript: the sidecar cuts ASR windows at a
 * hard 3.0 s, so one thought arrives as several caption lines and is rejoined
 * client-side in `seq` order before it reaches here. `lines` preserves the
 * split for debugging; sinks should read `text`.
 */
export interface TranscriptReadyEvent {
  /** Fresh per push-to-talk press. Stable id for this utterance. */
  utteranceId: string;
  /** The capture session the utterance belongs to. */
  captureId: string;
  /** Re-aggregated transcript. Empty when `outcome` is 'silent'/'lost'. */
  text: string;
  /** Utterance span on the capturing client's clock, epoch ms. */
  t0_ms: number;
  t1_ms: number;
  /** WHERE this belongs. Latched at t0 and never re-decided. */
  context: ContextFrame;
  /**
   * How collection ended. Sinks MUST branch on this: 'lost' means we sent audio
   * our own RMS gate scored as speech and no transcript ever came back, which
   * is the only observable signal of the sidecar's drop-oldest ASR queue.
   */
  outcome: UtteranceOutcome;
  /** Raw sidecar lines in seq order, before rejoining. */
  lines: Array<{ seq: number; text: string }>;
  /** Milliseconds of audio the client's RMS gate scored as speech. */
  speechMs: number;
}

export type TranscriptHandler = (event: TranscriptReadyEvent) => void;

const handlers = new Set<TranscriptHandler>();

/**
 * Subscribe to completed utterances. Returns an unsubscribe function.
 *
 * Safe to call from a React effect; safe to call from module scope in a
 * long-lived worker. Handlers are invoked synchronously in registration order,
 * and a throwing handler cannot stop the others.
 */
export function subscribeTranscripts(handler: TranscriptHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Publish. Called by `useVoiceCapture`; sinks should never call this. */
export function publishTranscript(event: TranscriptReadyEvent): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (err) {
      // One bad sink must not deny the transcript to every other sink.
      // eslint-disable-next-line no-console
      console.error('[voice-capture] transcript handler threw', err);
    }
  }
}

/** Test seam. */
export function __resetTranscriptHandlers(): void {
  handlers.clear();
}
