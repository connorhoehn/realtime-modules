// realtime-modules/src/client/media-effects/persistence.ts
//
// Pure persistence helpers for useMediaEffects' persistKey option.
// Separated from the hook so the restore/validate logic is unit-testable
// with a plain fake storage object — no jsdom, no localStorage global.
//
// Restore is defensive by design: persisted state outlives app versions,
// so every field is validated against the current registries and anything
// unrecognized degrades to its default instead of crashing the draw loop
// or pointing the background at a URL we no longer ship.

import { getFilterById } from './presets';
import { getSpriteById } from './faceSprites';
import type { BackgroundOption } from './backgrounds';
import type { BackgroundMode } from './engine';

/**
 * The complete set of user-selectable effect settings — the unit that both
 * the live (committed) state and the preview `draft` are made of, and the
 * exact shape written to localStorage under `persistKey`.
 */
export interface MediaEffectsSettings {
  filterId: string;
  backgroundMode: BackgroundMode;
  backgroundImageUrl: string | null;
  faceSpriteId: string | null;
}

/** Historical name for {@link MediaEffectsSettings}; kept for consumers. */
export type PersistedEffectsSettings = MediaEffectsSettings;

/** Field-wise comparison — drives `MediaEffectsController.isDirty`. */
export function mediaEffectsSettingsEqual(
  a: MediaEffectsSettings,
  b: MediaEffectsSettings,
): boolean {
  return (
    a.filterId === b.filterId &&
    a.backgroundMode === b.backgroundMode &&
    a.backgroundImageUrl === b.backgroundImageUrl &&
    a.faceSpriteId === b.faceSpriteId
  );
}

export const DEFAULT_EFFECTS_SETTINGS: PersistedEffectsSettings = {
  filterId: 'none',
  backgroundMode: 'none',
  backgroundImageUrl: null,
  faceSpriteId: null,
};

/** Minimal storage seam — satisfied by localStorage and by test fakes. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

const BACKGROUND_MODES: BackgroundMode[] = ['none', 'blur', 'image'];

/**
 * Read + validate persisted settings. Returns null when nothing (or
 * nothing parseable) is stored, so callers can fall back to defaults.
 *
 * backgroundImageUrl is only restored if it matches one of the provided
 * backgrounds — arbitrary persisted URLs are not honored (a renamed
 * built-in or a background the host no longer offers must not silently
 * keep rendering).
 */
export function readPersistedSettings(
  storage: SettingsStorage | null | undefined,
  key: string,
  backgrounds: BackgroundOption[],
): PersistedEffectsSettings | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null; // storage access can throw (privacy modes)
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const filterId = getFilterById(typeof obj.filterId === 'string' ? obj.filterId : undefined).id;

  const backgroundMode = BACKGROUND_MODES.includes(obj.backgroundMode as BackgroundMode)
    ? (obj.backgroundMode as BackgroundMode)
    : 'none';

  const candidateUrl = typeof obj.backgroundImageUrl === 'string' ? obj.backgroundImageUrl : null;
  const backgroundImageUrl =
    candidateUrl && backgrounds.some((b) => b.url === candidateUrl) ? candidateUrl : null;

  const faceSpriteId =
    getSpriteById(typeof obj.faceSpriteId === 'string' ? obj.faceSpriteId : null)?.id ?? null;

  return { filterId, backgroundMode, backgroundImageUrl, faceSpriteId };
}

/** Write settings; storage failures (quota, privacy mode) are swallowed —
 *  persistence is a nicety, never worth breaking the effects UI over. */
export function writePersistedSettings(
  storage: SettingsStorage | null | undefined,
  key: string,
  settings: PersistedEffectsSettings,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(settings));
  } catch {
    // ignore
  }
}
