import { type DeckSlide, type DeckSpec } from './DeckSpec';
export declare const PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** One line per citation, the way it reads in the speaker notes. */
export declare function citationLine(source: {
    title: string;
    documentId: string;
    anchor?: string;
}): string;
/** The speaker notes a slide ships with: what to say, then what it stands on. */
export declare function slideNotes(slide: DeckSlide): string;
/**
 * Renders the whole deck, Sources slide included, and hands back the file's
 * bytes. `spec` must already have been through `validateDeckSpec`.
 */
export declare function renderPptx(spec: DeckSpec): Promise<Buffer>;
//# sourceMappingURL=renderPptx.d.ts.map