import {
  bytesToMs,
  floatToS16,
  resampleLinear,
  rmsS16,
  s16ToBytes,
  silenceBytes,
  TARGET_SAMPLE_RATE,
} from '../../../src/client/voice/pcm';

describe('floatToS16', () => {
  it('clamps rather than wrapping on overshoot', () => {
    // A wrap turns a loud sample into a loud sample of the OPPOSITE sign —
    // audible as a click, and it inflates RMS enough to fake speech.
    const out = floatToS16(new Float32Array([2, -2, 0]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(0);
  });
});

describe('rmsS16', () => {
  it('scores digital silence as zero', () => {
    expect(rmsS16(new Int16Array(160))).toBe(0);
  });

  it('scores a loud tone above the sidecar silence threshold of 300', () => {
    const samples = new Int16Array(1600);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE));
    }
    expect(rmsS16(samples)).toBeGreaterThan(300);
  });

  it('returns 0 for an empty buffer instead of NaN', () => {
    expect(rmsS16(new Int16Array(0))).toBe(0);
  });
});

describe('s16ToBytes', () => {
  it('writes little-endian, matching what the sidecar reads', () => {
    // The sidecar does array('h', pcm) with an explicit LE assumption. A
    // byte-swapped stream still "looks like" audio, so this can only be caught
    // by asserting the bytes.
    const bytes = s16ToBytes(new Int16Array([1, -2]));
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xfe, 0xff]);
  });
});

describe('resampleLinear', () => {
  it('is identity when the rates already match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('shortens 48 kHz to a third of the samples', () => {
    // Safari has handed back the hardware rate despite the 16 kHz request; if
    // this correction is skipped the sidecar plays speech at 0.33x.
    const input = new Float32Array(4800).fill(0.5);
    expect(resampleLinear(input, 48000, 16000).length).toBe(1600);
  });
});

describe('silenceBytes — the flush tail that closes an utterance', () => {
  it('is zero-filled and the right length', () => {
    const tail = silenceBytes(900);
    expect(tail.length).toBe(0.9 * TARGET_SAMPLE_RATE * 2);
    expect(tail.every((b) => b === 0)).toBe(true);
  });

  it('exceeds the sidecar min_trailing_silence of 0.5 s so the cut actually fires', () => {
    expect(bytesToMs(silenceBytes(900).length)).toBeGreaterThan(500);
  });

  it('stays well under the sidecar 1 MB body cap', () => {
    expect(silenceBytes(900).length).toBeLessThan(1 << 20);
  });
});
