import { Extension } from '@tiptap/core';
export declare const TEXT_ALIGNMENTS: readonly ["left", "center", "right", "justify"];
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
export interface CanvasTextAlignOptions {
    /** Node names that gain the attribute. Must be textblocks `blocks.ts` defines. */
    types: string[];
}
export declare function isTextAlignment(value: unknown): value is TextAlignment;
/**
 * The stored value for a parsed `text-align`, or `null` for anything else.
 *
 * Pasted HTML carries `text-align: start`, `end`, `-webkit-center`, `inherit`
 * and worse. Storing those verbatim would put values in the CRDT that no
 * `setTextAlign` call can ever produce and that a future consumer would have to
 * defend against — narrowing to the four known values at the boundary keeps the
 * attribute a closed set.
 */
export declare function parseTextAlign(value: unknown): TextAlignment | null;
/**
 * The style attribute for an alignment, or nothing when unset.
 *
 * Unset MUST render no `style` at all rather than `text-align: left`. Emitting
 * the default would make every untouched paragraph in the document carry an
 * inline style that overrides the paper's own CSS — including in a
 * right-to-left locale, where the correct default is not `left`.
 */
export declare function textAlignStyle(value: unknown): Record<string, string>;
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        canvasTextAlign: {
            /** Align the blocks in the selection. Rejects a value outside `TEXT_ALIGNMENTS`. */
            setTextAlign: (alignment: TextAlignment) => ReturnType;
            /** Return the blocks in the selection to the document default. */
            unsetTextAlign: () => ReturnType;
        };
    }
}
export declare const CanvasTextAlign: Extension<CanvasTextAlignOptions, any>;
//# sourceMappingURL=textAlign.d.ts.map