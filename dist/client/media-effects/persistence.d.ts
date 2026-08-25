import type { BackgroundOption } from './backgrounds';
import type { BackgroundMode } from './engine';
export interface PersistedEffectsSettings {
    filterId: string;
    backgroundMode: BackgroundMode;
    backgroundImageUrl: string | null;
    faceSpriteId: string | null;
}
export declare const DEFAULT_EFFECTS_SETTINGS: PersistedEffectsSettings;
/** Minimal storage seam — satisfied by localStorage and by test fakes. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;
/**
 * Read + validate persisted settings. Returns null when nothing (or
 * nothing parseable) is stored, so callers can fall back to defaults.
 *
 * backgroundImageUrl is only restored if it matches one of the provided
 * backgrounds — arbitrary persisted URLs are not honored (a renamed
 * built-in or a background the host no longer offers must not silently
 * keep rendering).
 */
export declare function readPersistedSettings(storage: SettingsStorage | null | undefined, key: string, backgrounds: BackgroundOption[]): PersistedEffectsSettings | null;
/** Write settings; storage failures (quota, privacy mode) are swallowed —
 *  persistence is a nicety, never worth breaking the effects UI over. */
export declare function writePersistedSettings(storage: SettingsStorage | null | undefined, key: string, settings: PersistedEffectsSettings): void;
//# sourceMappingURL=persistence.d.ts.map