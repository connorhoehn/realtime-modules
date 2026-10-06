"use strict";
// Vendored from platform-api src/deck/renderPptx.ts at commit 34d17f7 (34d17f78c171b05ae1b146ed8e2fff1f7bec1de2).
// Unchanged except import paths (NodeNext `.js` suffixes). Extraction into a shared
// package is queued in docs/ui-components-queue.md — do not fork behaviour here.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PPTX_CONTENT_TYPE = void 0;
exports.citationLine = citationLine;
exports.slideNotes = slideNotes;
exports.renderPptx = renderPptx;
// The .pptx itself — a real OOXML package, not an export of a picture of one.
//
// pptxgenjs is pure JavaScript (it zips the OOXML parts itself), so this runs
// in the same container as every other step: no headless Office, no native
// module, no network. What comes back is the bytes of the file a person opens
// in PowerPoint, Keynote or Google Slides.
//
// Every slide is built from the shared geometry in theme.ts, which the SVG
// preview reads too, so the preview and the file agree on where things are.
const PptxGenJSModule = __importStar(require("pptxgenjs"));
const loaded = PptxGenJSModule.default;
const PptxGenJS = (typeof loaded === 'function' ? loaded : loaded.default);
const DeckSpec_1 = require("./DeckSpec");
const theme_1 = require("./theme");
exports.PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LAYOUT_NAME = 'DECK_16x9';
const MASTER_NAME = 'DECK_MASTER';
/** One line per citation, the way it reads in the speaker notes. */
function citationLine(source) {
    return `${source.title} — ${source.documentId}${source.anchor ? `#${source.anchor}` : ''}`;
}
/** The speaker notes a slide ships with: what to say, then what it stands on. */
function slideNotes(slide) {
    const parts = [];
    if (slide.notes)
        parts.push(slide.notes);
    parts.push(`Sources:\n${slide.sources.map((source) => `- ${citationLine(source)}`).join('\n')}`);
    return parts.join('\n\n');
}
function defineMaster(pptx, palette) {
    pptx.defineSlideMaster({
        title: MASTER_NAME,
        background: { color: (0, theme_1.bare)(palette.background) },
        objects: [
            // The accent rule under the title — the one piece of furniture that is
            // the same on every slide, so it lives on the master.
            {
                rect: {
                    x: theme_1.MARGIN_IN, y: theme_1.ACCENT_Y_IN, w: theme_1.ACCENT_WIDTH_IN, h: theme_1.ACCENT_HEIGHT_IN,
                    fill: { color: (0, theme_1.bare)(palette.accent) },
                },
            },
        ],
    });
}
function addFurniture(slide, palette, opts) {
    if (opts.eyebrow) {
        slide.addText(opts.eyebrow.toUpperCase(), {
            x: theme_1.MARGIN_IN, y: theme_1.EYEBROW_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: 0.28,
            fontFace: palette.fontFace, fontSize: 11, bold: true, charSpacing: 1.6,
            color: (0, theme_1.bare)(palette.accent), valign: 'middle',
        });
    }
    slide.addText(opts.title, {
        x: theme_1.MARGIN_IN, y: theme_1.TITLE_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.TITLE_HEIGHT_IN,
        fontFace: palette.fontFace, fontSize: opts.titleSize, bold: true,
        color: (0, theme_1.bare)(palette.text), valign: 'top', align: 'left', shrinkText: true,
    });
    slide.addText(opts.footer, {
        x: theme_1.MARGIN_IN, y: theme_1.FOOTER_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.FOOTER_HEIGHT_IN,
        fontFace: palette.fontFace, fontSize: 10, color: (0, theme_1.bare)(palette.muted), valign: 'middle',
    });
}
function addBullets(slide, palette, bullets, box) {
    if (!bullets.length)
        return;
    slide.addText(bullets.map((text) => ({ text, options: { bullet: { code: '2022' }, breakLine: true } })), {
        ...box,
        fontFace: palette.fontFace, fontSize: 18, color: (0, theme_1.bare)(palette.text),
        lineSpacingMultiple: 1.4, paraSpaceAfter: 10, valign: 'top', shrinkText: true,
    });
}
function addSlideBody(pptx, slide, palette, spec) {
    const box = { x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.BODY_HEIGHT_IN };
    switch (spec.layout) {
        case 'title':
        case 'section':
            // The furniture IS the slide; the bullets, when present, read as a standfirst.
            addBullets(slide, palette, spec.bullets ?? [], { ...box, h: 1.6 });
            return;
        case 'bullets':
            addBullets(slide, palette, spec.bullets ?? [], box);
            return;
        case 'two-column': {
            const [left, right] = spec.columns ?? [[], []];
            const columnWidth = (theme_1.CONTENT_WIDTH_IN - 0.6) / 2;
            addBullets(slide, palette, left, { x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: columnWidth, h: theme_1.BODY_HEIGHT_IN });
            addBullets(slide, palette, right, { x: theme_1.MARGIN_IN + columnWidth + 0.6, y: theme_1.BODY_Y_IN, w: columnWidth, h: theme_1.BODY_HEIGHT_IN });
            return;
        }
        case 'chart': {
            const chart = spec.chart;
            const captionHeight = spec.bullets?.length ? 1.1 : 0;
            slide.addChart(chart.kind === 'line' ? pptx.ChartType.line : pptx.ChartType.bar, chart.series.map((series) => ({ name: series.name, labels: chart.labels, values: series.values })), {
                x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.BODY_HEIGHT_IN - captionHeight,
                chartColors: palette.series.map(theme_1.bare),
                showLegend: chart.series.length > 1, legendPos: 'b', legendColor: (0, theme_1.bare)(palette.muted),
                showValue: false,
                catAxisLabelColor: (0, theme_1.bare)(palette.muted), valAxisLabelColor: (0, theme_1.bare)(palette.muted),
                catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
                catAxisLineShow: false, valAxisLineShow: false,
                chartArea: { fill: { color: (0, theme_1.bare)(palette.background) } },
                plotArea: { fill: { color: (0, theme_1.bare)(palette.background) } },
                lineDataSymbol: 'circle', lineSize: 3,
                barGapWidthPct: 60,
            });
            if (captionHeight) {
                addBullets(slide, palette, spec.bullets ?? [], {
                    x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN + theme_1.BODY_HEIGHT_IN - captionHeight, w: theme_1.CONTENT_WIDTH_IN, h: captionHeight,
                });
            }
            return;
        }
        case 'quote': {
            const quote = spec.quote;
            slide.addShape('rect', {
                x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.BODY_HEIGHT_IN,
                fill: { color: (0, theme_1.bare)(palette.panel) },
            });
            slide.addText(`“${quote.text}”`, {
                x: theme_1.MARGIN_IN + 0.5, y: theme_1.BODY_Y_IN + 0.5, w: theme_1.CONTENT_WIDTH_IN - 1, h: theme_1.BODY_HEIGHT_IN - 1.4,
                fontFace: palette.fontFace, fontSize: 24, italic: true, color: (0, theme_1.bare)(palette.text),
                valign: 'middle', shrinkText: true,
            });
            slide.addText(`— ${quote.by}`, {
                x: theme_1.MARGIN_IN + 0.5, y: theme_1.BODY_Y_IN + theme_1.BODY_HEIGHT_IN - 0.85, w: theme_1.CONTENT_WIDTH_IN - 1, h: 0.4,
                fontFace: palette.fontFace, fontSize: 14, color: (0, theme_1.bare)(palette.muted), valign: 'middle',
            });
            return;
        }
        case 'image': {
            // No bytes are fetched at render time: the frame states what belongs here
            // rather than shipping a stock image nobody chose.
            slide.addShape('rect', {
                x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.BODY_HEIGHT_IN,
                fill: { color: (0, theme_1.bare)(palette.panel) },
                line: { color: (0, theme_1.bare)(palette.muted), width: 1, dashType: 'dash' },
            });
            slide.addText(spec.image.alt, {
                x: theme_1.MARGIN_IN + 0.5, y: theme_1.BODY_Y_IN + 0.5, w: theme_1.CONTENT_WIDTH_IN - 1, h: theme_1.BODY_HEIGHT_IN - 1,
                fontFace: palette.fontFace, fontSize: 16, color: (0, theme_1.bare)(palette.muted),
                align: 'center', valign: 'middle', shrinkText: true,
            });
            return;
        }
    }
}
/**
 * Renders the whole deck, Sources slide included, and hands back the file's
 * bytes. `spec` must already have been through `validateDeckSpec`.
 */
async function renderPptx(spec) {
    const palette = (0, theme_1.paletteFor)(spec.theme);
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: LAYOUT_NAME, width: theme_1.SLIDE_WIDTH_IN, height: theme_1.SLIDE_HEIGHT_IN });
    pptx.layout = LAYOUT_NAME;
    pptx.title = spec.title;
    pptx.subject = spec.subtitle ?? spec.title;
    pptx.company = 'platform-api';
    defineMaster(pptx, palette);
    const total = spec.slides.length + 1;
    spec.slides.forEach((slideSpec, index) => {
        const slide = pptx.addSlide({ masterName: MASTER_NAME });
        addFurniture(slide, palette, {
            ...(slideSpec.eyebrow ? { eyebrow: slideSpec.eyebrow } : {}),
            title: slideSpec.title,
            titleSize: slideSpec.layout === 'title' ? 40 : slideSpec.layout === 'section' ? 34 : 28,
            footer: (0, theme_1.footerText)(spec.title, index + 1, total),
        });
        if (slideSpec.layout === 'title' && spec.subtitle) {
            slide.addText(spec.subtitle, {
                x: theme_1.MARGIN_IN, y: theme_1.TITLE_Y_IN + theme_1.TITLE_HEIGHT_IN + 0.15, w: theme_1.CONTENT_WIDTH_IN, h: 0.5,
                fontFace: palette.fontFace, fontSize: 18, color: (0, theme_1.bare)(palette.muted),
            });
        }
        addSlideBody(pptx, slide, palette, slideSpec);
        slide.addNotes(slideNotes(slideSpec));
    });
    // The Sources slide: the deck saying, on the record, what it stands on.
    const sources = (0, DeckSpec_1.deckSources)(spec);
    const closing = pptx.addSlide({ masterName: MASTER_NAME });
    addFurniture(closing, palette, {
        eyebrow: 'Grounded in',
        title: theme_1.SOURCES_SLIDE_TITLE,
        titleSize: 28,
        footer: (0, theme_1.footerText)(spec.title, total, total),
    });
    closing.addText(sources.map((source) => ({
        text: citationLine(source),
        options: { bullet: { code: '2022' }, breakLine: true },
    })), {
        x: theme_1.MARGIN_IN, y: theme_1.BODY_Y_IN, w: theme_1.CONTENT_WIDTH_IN, h: theme_1.BODY_HEIGHT_IN,
        fontFace: palette.fontFace, fontSize: 14, color: (0, theme_1.bare)(palette.text),
        lineSpacingMultiple: 1.3, valign: 'top', shrinkText: true,
    });
    closing.addNotes(`Sources:\n${sources.map((source) => `- ${citationLine(source)}`).join('\n')}`);
    const out = await pptx.write({ outputType: 'nodebuffer' });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
//# sourceMappingURL=renderPptx.js.map