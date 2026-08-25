// realtime-modules/test/client/media-effects/registries.test.ts
//
// Registry contracts: presets and sprites are static lookup tables whose
// unknown-id behavior the engine and persistence layer both lean on
// (getFilterById falls back to DEFAULT_FILTER, getSpriteById to null).
// Also pins the SSR contract of getBuiltInBackgrounds: in a document-less
// environment (this node test env) it returns [] rather than touching DOM.

import { describe, it, expect } from '@jest/globals';
import {
  FILTER_PRESETS,
  DEFAULT_FILTER,
  getFilterById,
} from '../../../src/client/media-effects/presets';
import {
  FACE_SPRITES,
  getSpriteById,
} from '../../../src/client/media-effects/faceSprites';
import { getBuiltInBackgrounds } from '../../../src/client/media-effects/backgrounds';

describe('FILTER_PRESETS registry', () => {
  it('ships the 9 ported presets with unique ids', () => {
    expect(FILTER_PRESETS).toHaveLength(9);
    const ids = FILTER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(9);
    expect(ids).toEqual([
      'none', 'bw', 'sepia', 'warm', 'cool', 'vintage', 'noir', 'hi-contrast', 'beauty',
    ]);
  });

  it('defaults to the identity filter', () => {
    expect(DEFAULT_FILTER.id).toBe('none');
    expect(DEFAULT_FILTER.cssFilter).toBe('none');
  });

  it('looks up by id and falls back to DEFAULT_FILTER for unknown/missing ids', () => {
    expect(getFilterById('noir').label).toBe('Noir');
    expect(getFilterById('does-not-exist')).toBe(DEFAULT_FILTER);
    expect(getFilterById(undefined)).toBe(DEFAULT_FILTER);
  });
});

describe('FACE_SPRITES registry', () => {
  it('ships the 5 ported sprites with render functions', () => {
    expect(FACE_SPRITES.map((s) => s.id)).toEqual([
      'dog-ears', 'sunglasses', 'mustache', 'party-hat', 'crown',
    ]);
    for (const sprite of FACE_SPRITES) {
      expect(typeof sprite.render).toBe('function');
      expect(sprite.label.length).toBeGreaterThan(0);
    }
  });

  it('returns null for unknown, null, and undefined ids', () => {
    expect(getSpriteById('crown')?.id).toBe('crown');
    expect(getSpriteById('unknown')).toBeNull();
    expect(getSpriteById(null)).toBeNull();
    expect(getSpriteById(undefined)).toBeNull();
  });
});

describe('getBuiltInBackgrounds (SSR / node)', () => {
  it('returns [] when document is unavailable instead of throwing', () => {
    expect(typeof document).toBe('undefined');
    expect(getBuiltInBackgrounds()).toEqual([]);
  });
});
