import { type DeckSpec } from './DeckSpec';
export interface PreviewSlide {
    id: string;
    index: number;
    title: string;
    svg: string;
}
export interface DeckPreview {
    title: string;
    /** Every slide the .pptx would have, Sources last. */
    slides: PreviewSlide[];
    warnings: string[];
}
/** What a reader would notice. Advisory only — none of these stops a render. */
export declare function deckWarnings(spec: DeckSpec): string[];
/** One preview slide's identity — the deck's own slides, then the Sources slide. */
export declare function previewSlideIdentity(spec: DeckSpec, index: number): {
    id: string;
    title: string;
};
/** Renders every slide of a validated spec. Nothing is written anywhere. */
export declare function renderDeckPreview(spec: DeckSpec): DeckPreview;
export type PreviewOutcome = {
    ok: true;
    preview: DeckPreview;
    spec: DeckSpec;
} | {
    ok: false;
    status: 400 | 413;
    errors: string[];
};
/**
 * Validates and previews in one step, separating "too big to be a deck" from
 * "not a deck": the first is a 413 the editor can act on by cutting slides, the
 * second is a 400 listing what is wrong.
 */
export declare function previewDeckSpec(input: unknown): PreviewOutcome;
//# sourceMappingURL=preview.d.ts.map