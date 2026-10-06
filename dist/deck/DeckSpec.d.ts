export type DeckTheme = 'product' | 'engineering' | 'plain';
export type SlideLayout = 'title' | 'section' | 'bullets' | 'two-column' | 'chart' | 'quote' | 'image';
/** A citation: the document the claim came from, and (optionally) where in it. */
export interface DeckSource {
    documentId: string;
    anchor?: string;
    title: string;
}
export interface DeckChart {
    kind: 'bar' | 'line';
    labels: string[];
    series: Array<{
        name: string;
        values: number[];
    }>;
}
export interface DeckQuote {
    text: string;
    by: string;
}
/**
 * An image slide carries only its alt text. Nothing is fetched at render time —
 * neither the .pptx nor the SVG preview reaches the network — so the slide is a
 * framed caption until a real asset pipeline puts bytes behind it.
 */
export interface DeckImage {
    alt: string;
}
export interface DeckSlide {
    id: string;
    layout: SlideLayout;
    title: string;
    eyebrow?: string;
    bullets?: string[];
    columns?: [string[], string[]];
    chart?: DeckChart;
    quote?: DeckQuote;
    image?: DeckImage;
    notes?: string;
    sources: DeckSource[];
}
export interface DeckSpec {
    title: string;
    subtitle?: string;
    theme?: DeckTheme;
    slides: DeckSlide[];
}
export declare const MAX_SLIDES = 40;
export declare const MAX_BULLETS_PER_SLIDE = 8;
export declare const MAX_BULLET_CHARS = 200;
export declare const MAX_TITLE_CHARS = 120;
export declare const MAX_SUBTITLE_CHARS = 200;
export declare const MAX_EYEBROW_CHARS = 60;
export declare const MAX_NOTES_CHARS = 2000;
export declare const MAX_CHART_LABELS = 24;
export declare const MAX_CHART_SERIES = 6;
export declare const MAX_QUOTE_CHARS = 400;
export declare const MAX_SOURCES_PER_SLIDE = 10;
/** Slide ids stay filename- and handle-safe: they end up in preview handles and blob keys. */
export declare const SLIDE_ID_PATTERN: RegExp;
export type DeckSpecValidation = {
    ok: true;
    spec: DeckSpec;
} | {
    ok: false;
    errors: string[];
};
/**
 * Validates one deck. Returns every problem it found rather than the first, so
 * a draft that has to be re-asked for can be re-asked for once.
 */
export declare function validateDeckSpec(input: unknown): DeckSpecValidation;
/** Validate or throw. The message lists every problem, in order. */
export declare function assertDeckSpec(input: unknown): DeckSpec;
/**
 * Pulls the deck out of whatever a model said: a bare object, a fenced block,
 * or prose with the JSON somewhere inside it. Returns `undefined` when there is
 * nothing parseable — the caller reports that, it does not improvise a deck.
 */
export declare function parseDeckSpecJson(text: string): unknown;
/** Every distinct document a deck cites, first-cited first — the Sources slide's content. */
export declare function deckSources(spec: DeckSpec): DeckSource[];
export type DeckReviseTargetField = 'title' | 'eyebrow' | 'subtitle' | 'bullets' | 'columns' | 'chart' | 'quote' | 'image' | 'notes';
export interface DeckReviseTarget {
    field: DeckReviseTargetField;
    /**
     * `bullets`: the bullet (0-based) to change — it must exist. `columns`: the
     * column, 0 or 1. Omitted: the whole field. Not allowed on any other field.
     */
    index?: number;
}
export declare const REVISE_TARGET_FIELDS: readonly DeckReviseTargetField[];
export type DeckReviseTargetValidation = {
    ok: true;
    target: DeckReviseTarget;
} | {
    ok: false;
    error: string;
};
/**
 * Checks a target against the deck it will be applied to. `slideId` must
 * already name a slide of `spec` (the caller checks that first) unless the
 * target is the deck's `subtitle`.
 */
export declare function validateReviseTarget(raw: unknown, spec: DeckSpec, slideId: string | undefined): DeckReviseTargetValidation;
/** How a target reads in a prompt, a log line or an event: "bullets[2]", "columns[1]", "notes". */
export declare function describeReviseTarget(target: DeckReviseTarget): string;
//# sourceMappingURL=DeckSpec.d.ts.map