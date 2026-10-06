"use strict";
// Vendored from platform-api src/deck/theme.ts at commit 34d17f7 (34d17f78c171b05ae1b146ed8e2fff1f7bec1de2).
// Unchanged except import paths (NodeNext `.js` suffixes). Extraction into a shared
// package is queued in docs/ui-components-queue.md — do not fork behaviour here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SOURCES_SLIDE_TITLE = exports.SOURCES_SLIDE_ID = exports.FOOTER_HEIGHT_IN = exports.FOOTER_Y_IN = exports.BODY_HEIGHT_IN = exports.BODY_Y_IN = exports.ACCENT_HEIGHT_IN = exports.ACCENT_WIDTH_IN = exports.ACCENT_Y_IN = exports.TITLE_HEIGHT_IN = exports.TITLE_Y_IN = exports.EYEBROW_Y_IN = exports.CONTENT_WIDTH_IN = exports.MARGIN_IN = exports.SVG_HEIGHT = exports.SVG_WIDTH = exports.SVG_SCALE = exports.SLIDE_HEIGHT_IN = exports.SLIDE_WIDTH_IN = void 0;
exports.bare = bare;
exports.paletteFor = paletteFor;
exports.footerText = footerText;
/** 16:9 at PowerPoint's widescreen size. */
exports.SLIDE_WIDTH_IN = 13.333;
exports.SLIDE_HEIGHT_IN = 7.5;
/** 96 px per inch → a 1280×720 preview. */
exports.SVG_SCALE = 96;
exports.SVG_WIDTH = Math.round(exports.SLIDE_WIDTH_IN * exports.SVG_SCALE);
exports.SVG_HEIGHT = Math.round(exports.SLIDE_HEIGHT_IN * exports.SVG_SCALE);
exports.MARGIN_IN = 0.7;
exports.CONTENT_WIDTH_IN = exports.SLIDE_WIDTH_IN - exports.MARGIN_IN * 2;
/** The master's fixed furniture: eyebrow, title, accent rule, footer. */
exports.EYEBROW_Y_IN = 0.52;
exports.TITLE_Y_IN = 0.82;
exports.TITLE_HEIGHT_IN = 0.9;
exports.ACCENT_Y_IN = 1.78;
exports.ACCENT_WIDTH_IN = 1.4;
exports.ACCENT_HEIGHT_IN = 0.06;
exports.BODY_Y_IN = 2.1;
exports.BODY_HEIGHT_IN = 4.55;
exports.FOOTER_Y_IN = 6.92;
exports.FOOTER_HEIGHT_IN = 0.3;
/** Hex without the '#', which is what pptxgenjs wants. */
function bare(color) {
    return color.replace('#', '').toUpperCase();
}
const PALETTES = {
    product: {
        background: '#FFFFFF',
        text: '#15161A',
        muted: '#6B7280',
        accent: '#6D4AFF',
        panel: '#F3F1FF',
        series: ['#6D4AFF', '#12B5A5', '#F5A524', '#E5484D', '#2F80ED', '#8E8E93'],
        fontFace: 'Calibri',
        svgFontStack: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    },
    engineering: {
        background: '#0F1117',
        text: '#F2F4F8',
        muted: '#9AA3B2',
        accent: '#32D3A6',
        panel: '#1A1F2B',
        series: ['#32D3A6', '#4C8DFF', '#F5A524', '#E5484D', '#B07CFF', '#9AA3B2'],
        fontFace: 'Consolas',
        svgFontStack: "'SF Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', monospace",
    },
    plain: {
        background: '#FFFFFF',
        text: '#111111',
        muted: '#666666',
        accent: '#111111',
        panel: '#F1F1F1',
        series: ['#111111', '#666666', '#999999', '#444444', '#BBBBBB', '#2B2B2B'],
        fontFace: 'Arial',
        svgFontStack: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
    },
};
function paletteFor(theme) {
    return PALETTES[theme ?? 'product'];
}
/** The footer every slide carries: `<deck title> · n / total`. */
function footerText(deckTitle, position, total) {
    return `${deckTitle} · ${position} / ${total}`;
}
/** The last slide of every deck, and the reason the deck is allowed to exist. */
exports.SOURCES_SLIDE_ID = 'sources';
exports.SOURCES_SLIDE_TITLE = 'Sources';
//# sourceMappingURL=theme.js.map