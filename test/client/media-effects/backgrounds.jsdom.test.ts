/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/media-effects/backgrounds.jsdom.test.ts
//
// Built-in background generation in a browser-like environment. jsdom has
// no Canvas 2D raster backend, which deliberately exercises the SVG
// data-URI fallback path — the point being that getBuiltInBackgrounds
// always yields self-contained data: URLs (no external fetches) in any
// environment with a document.

import { describe, it, expect } from '@jest/globals';
import { getBuiltInBackgrounds } from '../../../src/client/media-effects/backgrounds';

describe('getBuiltInBackgrounds (browser-like)', () => {
  it('generates the 4 built-in gradients as data: URIs', () => {
    const backgrounds = getBuiltInBackgrounds();
    expect(backgrounds.map((b) => b.id)).toEqual(['dusk', 'ocean', 'forest', 'slate']);
    for (const bg of backgrounds) {
      expect(bg.label.length).toBeGreaterThan(0);
      // Self-contained by contract: never an http(s) URL.
      expect(bg.url.startsWith('data:image/')).toBe(true);
    }
  });

  it('is memoized — same array and same url strings on every call', () => {
    const first = getBuiltInBackgrounds();
    const second = getBuiltInBackgrounds();
    expect(second).toBe(first);
  });
});
