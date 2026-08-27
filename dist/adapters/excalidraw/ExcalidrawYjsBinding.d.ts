import * as Y from 'yjs';
import type { DiagramElement } from './types';
/** Default root type name on the Y.Doc. */
export declare const DEFAULT_DIAGRAM_ROOT = "excalidraw";
export interface ExcalidrawYjsBindingOptions {
    ydoc: Y.Doc;
    /**
     * Y.Doc root-type name. Defaults to `'excalidraw'`.
     *
     * When a diagram is hosted as a BLOCK on a page, the page owns the Y.Doc
     * and every block needs its own namespace — pass `excalidraw:<blockId>`.
     * See `diagramRootName()`.
     */
    rootName?: string;
}
/** Root-type name for a diagram block inside a page-level Y.Doc. */
export declare function diagramRootName(blockId: string): string;
/**
 * Two-way binding between an Excalidraw element list and a Y.Doc subtree.
 *
 * Transport is not this class's problem. Whatever provider owns the Y.Doc
 * (here: `GatewayProvider`, base64 over the gateway's JSON WebSocket frames)
 * ships the updates; the binding only ever touches the document.
 */
export declare class ExcalidrawYjsBinding {
    readonly ydoc: Y.Doc;
    readonly rootName: string;
    private readonly _root;
    private readonly _elements;
    /**
     * Last element state this binding wrote or observed, keyed by element id.
     * Lets `commitLocal` skip untouched elements without deep comparison.
     */
    private readonly _stamps;
    private readonly _observers;
    private readonly _deepHandler;
    private _destroyed;
    constructor(options: ExcalidrawYjsBindingOptions);
    /** Number of elements currently in the shared scene, tombstones included. */
    get size(): number;
    /**
     * Read the whole scene out of the Y.Doc, sorted into z-order.
     *
     * Sort is by the fractional `index` string (lexicographic — that is the
     * ordering fractional indices are designed for). Elements with no index
     * (pre-0.17 scenes, or an element mid-creation) sort last, tie-broken by
     * id so the result is deterministic across peers.
     */
    readAll(): DiagramElement[];
    /**
     * Push the local scene into the Y.Doc.
     *
     * Call this from Excalidraw's `onChange`. It is cheap on the common path:
     * elements whose `version`/`versionNonce` are unchanged since the last
     * commit are skipped without touching their properties at all.
     *
     * Returns `true` when anything was actually written.
     */
    commitLocal(elements: readonly DiagramElement[]): boolean;
    /**
     * Subscribe to remote changes. The callback fires with the full sorted
     * scene and NEVER fires for this binding's own `commitLocal` writes.
     */
    observe(callback: (elements: DiagramElement[]) => void): () => void;
    destroy(): void;
    /** Write only the properties that actually differ. Returns true if any did. */
    private _applyProps;
}
//# sourceMappingURL=ExcalidrawYjsBinding.d.ts.map