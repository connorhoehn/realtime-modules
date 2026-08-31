import { type JsonObject } from 'distributed-core/applications/document';
/**
 * The YAML body for a macro payload — byte-identical to what
 * `serializeDocument` writes between the fences.
 *
 * Deliberately implemented by *calling* the chassis serializer and slicing the
 * fences off, rather than re-dumping the YAML here with a second copy of the
 * dump options (`sortKeys`, `lineWidth: -1`, `noRefs`, `noCompatMode`). A
 * second copy is a drift bug waiting to happen: the day the chassis changes an
 * option, every macro in every open editor would start disagreeing with its own
 * exported file. This cannot drift.
 *
 * Returns text WITHOUT a trailing newline, because a ProseMirror textblock's
 * content is the body and the closing fence supplies the final break.
 */
export declare function macroTextFromData(name: string, data: JsonObject): string;
/**
 * The payload a macro's editor text currently represents, or `null` when the
 * text is not valid YAML.
 *
 * `null` is a real state, not an error path: a CRDT merge of two concurrent
 * rewrites can produce text that no longer parses, and the honest response is
 * to show the user the source rather than to invent a payload or to throw
 * inside a React render.
 */
export declare function macroDataFromText(name: string, text: string): JsonObject | null;
export interface TextRangeEdit {
    /** Offset into the old text where the replacement starts. */
    from: number;
    /** Offset into the old text where the replacement ends. */
    to: number;
    /** Text to insert in that range. */
    insert: string;
}
/**
 * The smallest single-range edit that turns `before` into `after`.
 *
 * Toggling an action item's status rewrites the whole YAML body in principle,
 * but the only characters that differ are `pending` → `done`. Dispatching the
 * whole-body replacement would make two clients toggling different fields at
 * the same moment collide on every byte; dispatching the minimal range lets
 * Y.js merge them the way it merges any two edits to different parts of a
 * paragraph — cleanly.
 *
 * Returns `null` when the texts are identical, so callers can skip the
 * transaction entirely rather than dirtying the document.
 */
export declare function minimalEdit(before: string, after: string): TextRangeEdit | null;
//# sourceMappingURL=macroText.d.ts.map