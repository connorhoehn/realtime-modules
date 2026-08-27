import type * as Y from 'yjs';
import { type DocModel } from 'distributed-core/applications/document';
import { type UnsupportedForm } from '../adapters/tiptap/canvas/pmModel';
/** The Y.js root that holds the canvas body. */
export declare const CANVAS_BODY_KEY = "body";
/**
 * A ProseMirror `Schema`, structurally. Typed loosely on purpose: importing
 * `prosemirror-model` here would put a SECOND copy of it in the module graph
 * for any consumer that pre-bundles this package, and two copies of
 * prosemirror-model is the exact failure the app's `optimizeDeps.exclude`
 * entries exist to prevent (`instanceof DecorationSet` across the boundary).
 * Callers pass `editor.schema` — the one the live editor already built.
 */
export type PmSchemaLike = {
    nodes: unknown;
    marks: unknown;
};
export interface CanvasDocument {
    /** True when `meta.schemaVersion >= 2`. The one gate. */
    isCanvas: boolean;
    schemaVersion: number;
    /** The page body. Hand this straight to `TiptapEditor`'s `fragment`. */
    body: Y.XmlFragment | null;
    /**
     * The current page as markdown — the exchange format, and the thing the
     * operator actually asked for.
     *
     * Reads the CRDT, not the editor, so it works with no editor mounted (an
     * export endpoint, a dry-run script, a test).
     */
    exportMarkdown: () => string;
    /**
     * Writes a `DocModel` into the empty canvas body and sets `schemaVersion` in
     * the SAME Y.js transaction, so no peer and no snapshot can ever observe a
     * document that claims to be a canvas but has no body.
     *
     * Refuses when the body is already non-empty. Materialising twice is how a
     * document ends up with its content duplicated, and two clients racing to
     * convert the same document is a realistic way to get there.
     */
    materialize: (schema: PmSchemaLike, model: DocModel) => MaterializeResult;
    /** Replaces the body from a markdown source. Same atomicity, same refusal. */
    importMarkdown: (schema: PmSchemaLike, markdown: string) => MaterializeResult;
}
export interface MaterializeResult {
    ok: boolean;
    /** Why it refused, when `ok` is false. */
    reason?: string;
    /** Forms the ProseMirror schema could not express. Never silent. */
    unsupported: UnsupportedForm[];
}
/**
 * Reads the canvas body straight out of the CRDT as a `DocModel`.
 *
 * Exported separately from the hook so a non-React caller — a migration dry
 * run, an export route, a test — can use it without mounting anything.
 */
export declare function canvasToDocModel(ydoc: Y.Doc): DocModel;
/** The canvas body as markdown. */
export declare function canvasToMarkdown(ydoc: Y.Doc): string;
export interface UseCanvasDocumentOptions {
    ydoc: Y.Doc | null | undefined;
}
export declare function useCanvasDocument({ ydoc }: UseCanvasDocumentOptions): CanvasDocument;
//# sourceMappingURL=useCanvasDocument.d.ts.map