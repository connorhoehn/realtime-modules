/** The one sample rate the sidecar's ASR model wants. */
export declare const TARGET_SAMPLE_RATE = 16000;
/**
 * RMS threshold below which a chunk counts as silence.
 *
 * Expressed in s16le amplitude units to match `LIVE_SILENCE_RMS` (default 300)
 * on the sidecar. We compute it client-side for ONE reason: to know whether an
 * utterance actually contained speech. The sidecar's ASR queue is bounded at 8
 * windows with drop-OLDEST and exposes no metrics, so a dropped window is
 * otherwise a silently lost utterance. If we know we sent speech and no text
 * ever came back, we can say so instead of pretending the user said nothing.
 */
export declare const DEFAULT_SILENCE_RMS = 300;
/**
 * Root-mean-square amplitude of an s16le buffer, in s16 amplitude units.
 * A trailing odd byte (torn sample) is ignored, matching pcm.py.
 */
export declare function rmsS16(pcm: Int16Array): number;
/** Convert normalized float32 samples in [-1, 1) to s16le, clamping overshoot. */
export declare function floatToS16(samples: Float32Array): Int16Array;
/**
 * Linear-interpolating resampler, used ONLY as a fallback.
 *
 * The capture path asks for `new AudioContext({ sampleRate: 16000 })` so the
 * browser's own (much better) resampler does this work. Chrome and Firefox
 * honour that; Safari has historically ignored the hint and handed back the
 * hardware rate, which would send 44.1 kHz bytes to a service that will
 * interpret them as 16 kHz — audio at 0.36x speed, and whisper transcribing
 * gibberish. So we check ctx.sampleRate at runtime and correct here.
 */
export declare function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
/** Bytes of s16le mono needed to represent `ms` milliseconds at `rate` Hz. */
export declare function silenceBytes(ms: number, rate?: number): Uint8Array;
/** Milliseconds of audio a given s16le byte count represents. */
export declare function bytesToMs(byteLength: number, rate?: number): number;
/** View an Int16Array as the little-endian bytes the sidecar reads. */
export declare function s16ToBytes(pcm: Int16Array): Uint8Array;
//# sourceMappingURL=pcm.d.ts.map