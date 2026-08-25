"use strict";
// realtime-modules/src/client/media-effects/presets.ts
//
// Filter presets — all color/tone transforms are Canvas 2D `ctx.filter`
// strings, so a preset is pure data: no shaders, no per-preset code paths.
// The engine assigns `cssFilter` to the 2D context right before drawImage.
// Ported from videonowandlater's broadcast filter set.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_FILTER = exports.FILTER_PRESETS = void 0;
exports.getFilterById = getFilterById;
exports.FILTER_PRESETS = [
    { id: 'none', label: 'None', cssFilter: 'none' },
    { id: 'bw', label: 'B&W', cssFilter: 'grayscale(1)' },
    { id: 'sepia', label: 'Sepia', cssFilter: 'sepia(1)' },
    { id: 'warm', label: 'Warm', cssFilter: 'saturate(1.35) contrast(1.05) brightness(1.03) hue-rotate(-6deg)' },
    { id: 'cool', label: 'Cool', cssFilter: 'saturate(1.15) contrast(1.05) hue-rotate(12deg)' },
    { id: 'vintage', label: 'Vintage', cssFilter: 'sepia(0.5) contrast(1.1) brightness(0.95) saturate(0.75)' },
    { id: 'noir', label: 'Noir', cssFilter: 'grayscale(1) contrast(1.45) brightness(1.05)' },
    { id: 'hi-contrast', label: 'High Contrast', cssFilter: 'contrast(1.5) saturate(1.25)' },
    { id: 'beauty', label: 'Beauty', cssFilter: 'blur(1.2px) brightness(1.08) saturate(0.92) contrast(0.98)' },
];
exports.DEFAULT_FILTER = exports.FILTER_PRESETS[0];
/** Unknown or missing ids fall back to DEFAULT_FILTER ('none') so a stale
 *  persisted id can never crash the draw loop. */
function getFilterById(id) {
    return exports.FILTER_PRESETS.find((p) => p.id === id) ?? exports.DEFAULT_FILTER;
}
//# sourceMappingURL=presets.js.map