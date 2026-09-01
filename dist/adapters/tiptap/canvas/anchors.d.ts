import * as Y from 'yjs';
/**
 * Bumped when the encoding changes. `resolveAnchor` refuses versions it does
 * not understand rather than decoding them wrong — persisted anchors outlive
 * the code that wrote them.
 */
export declare const CANVAS_ANCHOR_VERSION = 1;
/**
 * A comment's position in a canvas document. Plain JSON: safe to put straight
 * into a DynamoDB item, a WebSocket frame, or a snapshot.
 */
export interface CanvasAnchor {
    /** Encoding version. See `CANVAS_ANCHOR_VERSION`. */
    v: number;
    /**
     * The Y.js root the anchor lives in. In practice `CANVAS_BODY_KEY`
     * (`'body'`) from `useCanvasDocument` — passed in rather than imported
     * because that module is a React hook and imports this one's neighbour.
     */
    key: string;
    /** base64 of `Y.encodeRelativePosition` for the start of the range. */
    start: string;
    /** base64 of `Y.encodeRelativePosition` for the end of the range. */
    end: string;
    /**
     * The text the range covered when the anchor was made.
     *
     * Never used to resolve — it is not a fallback search, because a fuzzy
     * re-match is exactly the kind of confident wrong answer this file exists to
     * avoid. It is here so an orphaned thread can still say what it was about.
     */
    quote: string;
}
/** A resolved range in the plain-text offset space described above. */
export interface AnchorRange {
    from: number;
    to: number;
}
/**
 * The document's plain text — the offset space `from`/`to` live in.
 *
 * Exported because a caller creating an anchor needs to find the offsets of
 * the span the user selected, and because it makes an anchor's meaning
 * checkable: `canvasPlainText(doc, key).slice(from, to)` is the comment's text.
 */
export declare function canvasPlainText(ydoc: Y.Doc, fragmentKey: string): string;
/**
 * Anchors a range of the document.
 *
 * `from`/`to` are plain-text offsets (see `canvasPlainText`), half-open, and
 * must be non-empty — a comment refers to a span of text, and a collapsed
 * range cannot be told apart from an orphan once the document has moved on.
 * Invalid input throws, because a caller that computed a bad offset wants to
 * know now rather than store an anchor that resolves to nothing forever.
 *
 * Association is chosen so the range does not swallow adjacent typing: the
 * start binds to its first character and the end binds to its last, so text
 * typed immediately before or after the comment stays outside it, while text
 * typed inside it extends it.
 */
export declare function createAnchor(ydoc: Y.Doc, fragmentKey: string, from: number, to: number): CanvasAnchor;
/** Cheap shape check for an anchor that came back out of storage. */
export declare function isCanvasAnchor(value: unknown): value is CanvasAnchor;
/**
 * Resolves an anchor against the CURRENT state of the document.
 *
 * Returns `null` — never a throw, never a `0` — when the anchor cannot be
 * placed. That covers four genuinely different orphan stories, all of which
 * the gutter renders the same way:
 *
 *   • the anchored characters were deleted (the range collapses to a point)
 *   • the whole block holding them was deleted
 *   • this `Y.Doc` has not received the update that created the anchored text
 *   • the stored anchor is malformed or from a future encoding version
 */
export declare function resolveAnchor(ydoc: Y.Doc, anchor: CanvasAnchor): AnchorRange | null;
/**
 * The text an anchor currently covers, or `null` if it is orphaned.
 *
 * The honest way to check an anchor, and the one the gutter wants when it
 * renders a thread's quoted context: it reads what the anchor points at NOW
 * rather than trusting `anchor.quote`, which is a snapshot of creation time.
 */
export declare function anchorText(ydoc: Y.Doc, anchor: CanvasAnchor): string | null;
//# sourceMappingURL=anchors.d.ts.map