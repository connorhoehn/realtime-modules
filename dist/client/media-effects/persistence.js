"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EFFECTS_SETTINGS = void 0;
exports.mediaEffectsSettingsEqual = mediaEffectsSettingsEqual;
exports.readPersistedSettings = readPersistedSettings;
exports.writePersistedSettings = writePersistedSettings;
const presets_1 = require("./presets");
const faceSprites_1 = require("./faceSprites");
/** Field-wise comparison — drives `MediaEffectsController.isDirty`. */
function mediaEffectsSettingsEqual(a, b) {
    return (a.filterId === b.filterId &&
        a.backgroundMode === b.backgroundMode &&
        a.backgroundImageUrl === b.backgroundImageUrl &&
        a.faceSpriteId === b.faceSpriteId);
}
exports.DEFAULT_EFFECTS_SETTINGS = {
    filterId: 'none',
    backgroundMode: 'none',
    backgroundImageUrl: null,
    faceSpriteId: null,
};
const BACKGROUND_MODES = ['none', 'blur', 'image'];
/**
 * Read + validate persisted settings. Returns null when nothing (or
 * nothing parseable) is stored, so callers can fall back to defaults.
 *
 * backgroundImageUrl is only restored if it matches one of the provided
 * backgrounds — arbitrary persisted URLs are not honored (a renamed
 * built-in or a background the host no longer offers must not silently
 * keep rendering).
 */
function readPersistedSettings(storage, key, backgrounds) {
    if (!storage)
        return null;
    let raw = null;
    try {
        raw = storage.getItem(key);
    }
    catch {
        return null; // storage access can throw (privacy modes)
    }
    if (!raw)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const obj = parsed;
    const filterId = (0, presets_1.getFilterById)(typeof obj.filterId === 'string' ? obj.filterId : undefined).id;
    const backgroundMode = BACKGROUND_MODES.includes(obj.backgroundMode)
        ? obj.backgroundMode
        : 'none';
    const candidateUrl = typeof obj.backgroundImageUrl === 'string' ? obj.backgroundImageUrl : null;
    const backgroundImageUrl = candidateUrl && backgrounds.some((b) => b.url === candidateUrl) ? candidateUrl : null;
    const faceSpriteId = (0, faceSprites_1.getSpriteById)(typeof obj.faceSpriteId === 'string' ? obj.faceSpriteId : null)?.id ?? null;
    return { filterId, backgroundMode, backgroundImageUrl, faceSpriteId };
}
/** Write settings; storage failures (quota, privacy mode) are swallowed —
 *  persistence is a nicety, never worth breaking the effects UI over. */
function writePersistedSettings(storage, key, settings) {
    if (!storage)
        return;
    try {
        storage.setItem(key, JSON.stringify(settings));
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=persistence.js.map