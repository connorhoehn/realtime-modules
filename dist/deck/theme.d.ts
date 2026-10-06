import type { DeckTheme } from './DeckSpec';
/** 16:9 at PowerPoint's widescreen size. */
export declare const SLIDE_WIDTH_IN = 13.333;
export declare const SLIDE_HEIGHT_IN = 7.5;
/** 96 px per inch → a 1280×720 preview. */
export declare const SVG_SCALE = 96;
export declare const SVG_WIDTH: number;
export declare const SVG_HEIGHT: number;
export declare const MARGIN_IN = 0.7;
export declare const CONTENT_WIDTH_IN: number;
/** The master's fixed furniture: eyebrow, title, accent rule, footer. */
export declare const EYEBROW_Y_IN = 0.52;
export declare const TITLE_Y_IN = 0.82;
export declare const TITLE_HEIGHT_IN = 0.9;
export declare const ACCENT_Y_IN = 1.78;
export declare const ACCENT_WIDTH_IN = 1.4;
export declare const ACCENT_HEIGHT_IN = 0.06;
export declare const BODY_Y_IN = 2.1;
export declare const BODY_HEIGHT_IN = 4.55;
export declare const FOOTER_Y_IN = 6.92;
export declare const FOOTER_HEIGHT_IN = 0.3;
export interface DeckPalette {
    /** Slide background. */
    background: string;
    /** Headline and body text. */
    text: string;
    /** Secondary text: eyebrow context, footer, attributions. */
    muted: string;
    /** The accent rule, bullet marks and the first chart series. */
    accent: string;
    /** Panels: the two-column dividers, the quote block, the image frame. */
    panel: string;
    /** Chart series, accent first. */
    series: string[];
    /** Typeface stack. Only families PowerPoint and every browser already have. */
    fontFace: string;
    /** The SVG font stack, which needs fallbacks spelled out. */
    svgFontStack: string;
}
/** Hex without the '#', which is what pptxgenjs wants. */
export declare function bare(color: string): string;
export declare function paletteFor(theme: DeckTheme | undefined): DeckPalette;
/** The footer every slide carries: `<deck title> · n / total`. */
export declare function footerText(deckTitle: string, position: number, total: number): string;
/** The last slide of every deck, and the reason the deck is allowed to exist. */
export declare const SOURCES_SLIDE_ID = "sources";
export declare const SOURCES_SLIDE_TITLE = "Sources";
//# sourceMappingURL=theme.d.ts.map