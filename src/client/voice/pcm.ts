// realtime-modules/src/client/voice/pcm.ts
//
// Browser-side PCM helpers for ambient voice capture. Mirrors the maths the
// live-captions sidecar does on the other end (services/live-captions/src/pcm.py)
// so the two agree on what "silence" and "one sample" mean.
//
// Wire format the sidecar expects: raw s16le, mono, 16 kHz. No container, no
// header — it appends bytes straight into an UtteranceAccumulator.
//
// Nothing here touches the DOM or an AudioContext, so it is unit-testable with
// plain Float32Arrays.

/** The one sample rate the sidecar's ASR model wants. */
export const TARGET_SAMPLE_RATE = 16000;

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
export const DEFAULT_SILENCE_RMS = 300;

/**
 * Root-mean-square amplitude of an s16le buffer, in s16 amplitude units.
 * A trailing odd byte (torn sample) is ignored, matching pcm.py.
 */
export function rmsS16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < pcm.length; i += 1) acc += pcm[i]! * pcm[i]!;
  return Math.sqrt(acc / pcm.length);
}

/** Convert normalized float32 samples in [-1, 1) to s16le, clamping overshoot. */
export function floatToS16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

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
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = samples[i0]! * (1 - frac) + samples[i1]! * frac;
  }
  return out;
}

/** Bytes of s16le mono needed to represent `ms` milliseconds at `rate` Hz. */
export function silenceBytes(ms: number, rate: number = TARGET_SAMPLE_RATE): Uint8Array {
  const samples = Math.max(0, Math.round((ms / 1000) * rate));
  return new Uint8Array(samples * 2); // zero-filled == digital silence
}

/** Milliseconds of audio a given s16le byte count represents. */
export function bytesToMs(byteLength: number, rate: number = TARGET_SAMPLE_RATE): number {
  return (byteLength / 2 / rate) * 1000;
}

/** View an Int16Array as the little-endian bytes the sidecar reads. */
export function s16ToBytes(pcm: Int16Array): Uint8Array {
  // Node and every browser we target are little-endian, but be explicit rather
  // than aliasing the buffer and hoping — a big-endian host would silently
  // transmit byte-swapped samples that still "look like" audio.
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(i * 2, pcm[i]!, true);
  return out;
}
