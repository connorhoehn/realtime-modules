import { type DeckSpec } from './DeckSpec';
export declare const SVG_CONTENT_TYPE = "image/svg+xml";
/**
 * Escapes text for SVG — and escapes '=' along with the five XML characters.
 *
 * The '=' is not an XML problem; it is an inertness one. The preview route
 * refuses any markup matching ` on<word>=` or `href=`, and it applies that test
 * to the whole document, so a bullet that merely QUOTES `<img onerror="…">`
 * would get the slide refused even though the angle brackets are escaped.
 * `&#61;` renders as '=' in every browser and matches neither pattern.
 */
export declare function escapeXml(value: string): string;
/**
 * Greedy wrap by estimated width. SVG has no layout engine to ask, and this
 * renderer refuses to load a font to measure with, so widths come from a
 * per-size average advance — good to a few percent for the Latin text a slide
 * carries, and identical on every machine.
 */
export declare function wrapText(text: string, fontSize: number, maxWidth: number): string[];
/**
 * Renders one slide of the deck. `index` addresses the same slides the .pptx
 * has: `0…spec.slides.length - 1` are the deck's own, and `spec.slides.length`
 * is the Sources slide that closes every deck.
 */
export declare function renderSlideSvg(spec: DeckSpec, index: number): string;
/** Every slide of the deck, in order, Sources last. */
export declare function renderAllSlideSvgs(spec: DeckSpec): string[];
//# sourceMappingURL=renderSlideSvg.d.ts.map