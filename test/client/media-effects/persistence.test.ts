// realtime-modules/test/client/media-effects/persistence.test.ts
//
// Persistence helpers are pure over an injected storage seam, so these run
// in the default node environment with a Map-backed fake — no jsdom
// localStorage involved. The contract under test: restore validates every
// field against the live registries (stale ids degrade to defaults), and
// backgroundImageUrl only survives if it matches a known background.

import { describe, it, expect } from '@jest/globals';
import {
  readPersistedSettings,
  writePersistedSettings,
  DEFAULT_EFFECTS_SETTINGS,
  type SettingsStorage,
} from '../../../src/client/media-effects/persistence';
import type { BackgroundOption } from '../../../src/client/media-effects/backgrounds';

function fakeStorage(seed?: Record<string, string>): SettingsStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const BACKGROUNDS: BackgroundOption[] = [
  { id: 'dusk', label: 'Dusk', url: 'data:image/jpeg;base64,AAA' },
  { id: 'ocean', label: 'Ocean', url: 'data:image/jpeg;base64,BBB' },
];

const KEY = 'media-effects-test';

describe('readPersistedSettings', () => {
  it('returns null when storage is absent, empty, or unparseable', () => {
    expect(readPersistedSettings(null, KEY, BACKGROUNDS)).toBeNull();
    expect(readPersistedSettings(undefined, KEY, BACKGROUNDS)).toBeNull();
    expect(readPersistedSettings(fakeStorage(), KEY, BACKGROUNDS)).toBeNull();
    expect(readPersistedSettings(fakeStorage({ [KEY]: 'not json{{' }), KEY, BACKGROUNDS)).toBeNull();
    expect(readPersistedSettings(fakeStorage({ [KEY]: '"a string"' }), KEY, BACKGROUNDS)).toBeNull();
  });

  it('returns null when storage access throws (privacy modes)', () => {
    const throwing: SettingsStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(readPersistedSettings(throwing, KEY, BACKGROUNDS)).toBeNull();
  });

  it('round-trips valid settings', () => {
    const storage = fakeStorage();
    const settings = {
      filterId: 'noir',
      backgroundMode: 'image' as const,
      backgroundImageUrl: BACKGROUNDS[1].url,
      faceSpriteId: 'crown',
    };
    writePersistedSettings(storage, KEY, settings);
    expect(readPersistedSettings(storage, KEY, BACKGROUNDS)).toEqual(settings);
  });

  it('degrades unknown filter and sprite ids to defaults', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({
        filterId: 'ultra-hdr-3000',
        backgroundMode: 'blur',
        backgroundImageUrl: null,
        faceSpriteId: 'halo',
      }),
    });
    const restored = readPersistedSettings(storage, KEY, BACKGROUNDS);
    expect(restored).toEqual({
      filterId: 'none',
      backgroundMode: 'blur',
      backgroundImageUrl: null,
      faceSpriteId: null,
    });
  });

  it('rejects invalid background modes', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({ ...DEFAULT_EFFECTS_SETTINGS, backgroundMode: 'greenscreen' }),
    });
    expect(readPersistedSettings(storage, KEY, BACKGROUNDS)?.backgroundMode).toBe('none');
  });

  it('only restores backgroundImageUrl when it matches a provided background', () => {
    const known = fakeStorage({
      [KEY]: JSON.stringify({ ...DEFAULT_EFFECTS_SETTINGS, backgroundImageUrl: BACKGROUNDS[0].url }),
    });
    expect(readPersistedSettings(known, KEY, BACKGROUNDS)?.backgroundImageUrl).toBe(BACKGROUNDS[0].url);

    const unknown = fakeStorage({
      [KEY]: JSON.stringify({
        ...DEFAULT_EFFECTS_SETTINGS,
        backgroundImageUrl: 'https://evil.example/bg.jpg',
      }),
    });
    expect(readPersistedSettings(unknown, KEY, BACKGROUNDS)?.backgroundImageUrl).toBeNull();
  });
});

describe('writePersistedSettings', () => {
  it('serializes to JSON under the given key', () => {
    const storage = fakeStorage();
    writePersistedSettings(storage, KEY, DEFAULT_EFFECTS_SETTINGS);
    expect(JSON.parse(storage.map.get(KEY)!)).toEqual(DEFAULT_EFFECTS_SETTINGS);
  });

  it('swallows storage failures and missing storage', () => {
    const throwing: SettingsStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    };
    expect(() => writePersistedSettings(throwing, KEY, DEFAULT_EFFECTS_SETTINGS)).not.toThrow();
    expect(() => writePersistedSettings(null, KEY, DEFAULT_EFFECTS_SETTINGS)).not.toThrow();
  });
});
