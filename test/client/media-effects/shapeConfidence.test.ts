// realtime-modules/test/client/media-effects/shapeConfidence.test.ts
//
// The alpha-shaping curve is the visual heart of the segmentation mask:
//   curve(p) = clamp(1.8p - 0.4, 0, 1)
// It must clamp to 0 below p≈0.22 (kills low-confidence spray), pass 0.5
// through unchanged (edge stays centered), and saturate to 1 above p≈0.78
// (solid person interior). Pinned here as a pure function so a future
// "tweak the blend" edit can't silently move the silhouette edge.

import { describe, it, expect } from '@jest/globals';
import { shapeConfidence } from '../../../src/client/media-effects/segmenter';

describe('shapeConfidence', () => {
  it('maps definite background (0) to 0 and definite person (1) to 1', () => {
    expect(shapeConfidence(0)).toBe(0);
    expect(shapeConfidence(1)).toBe(1);
  });

  it('clamps the low-confidence knee (~0.22) to ~0', () => {
    expect(shapeConfidence(0.22)).toBeCloseTo(0, 2);
    expect(shapeConfidence(0.1)).toBe(0);
  });

  it('passes the midpoint through unchanged', () => {
    expect(shapeConfidence(0.5)).toBeCloseTo(0.5, 10);
  });

  it('saturates the high-confidence knee (~0.78) to ~1', () => {
    expect(shapeConfidence(0.78)).toBeCloseTo(1, 2);
    expect(shapeConfidence(0.9)).toBe(1);
  });

  it('is monotonically non-decreasing across the domain', () => {
    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = shapeConfidence(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
