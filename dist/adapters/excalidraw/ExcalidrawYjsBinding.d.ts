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
    /**
     * Last element state this binding wrote or observed, keyed by element id.
     * Lets `commitLocal` skip untouched elements without deep comparison.
     */
    private readonly _stamps;
    private readonly _observers;
    private readonly _deepHandler;
    private _destroyed;
    constructor(options: ExcalidrawYjsBindingOptions);
    /**
     * The elements container, re-read every time, or `undefined` when the
     * scene is genuinely cold.
     *
     * ## Why this is a getter and not a field
     *
     * It used to be captured in the constructor, and the constructor CREATED
     * the container when it was missing. Both halves were wrong, and together
     * they lost a whole diagram every time one was reloaded.
     *
     * `getMap` on a Y.Doc root is conflict-free, but `map.set('elements', new
     * Y.Map())` is an ordinary keyed write. Two clients — or, far more often,
     * ONE client and the server snapshot it has not received yet — write that
     * key concurrently, and Yjs keeps exactly one of the two maps. The loser is
     * DETACHED: still a live Y.Map, still writable, no longer reachable from
     * the document root.
     *
     * A cold-open client therefore did this, every single time:
     *
     *   1. mount with an empty Y.Doc (the provider hands one over immediately,
     *      before the snapshot lands),
     *   2. see no container, create one, capture it,
     *   3. receive the snapshot carrying the REAL container,
     *   4. lose the tie — and spend the rest of the session reading from and
     *      writing into an orphan.
     *
     * The user's shapes were still in the document and still on the server;
     * they were simply hanging off a map nothing pointed at. Verified live: the
     * `crdt:snapshot` frame for a document contained three rectangles under
     * `excalidraw:<id> -> elements` while the canvas on screen was blank.
     *
     * Re-reading fixes the read side, and `_ensureElements` fixes the write
     * side by never creating the container speculatively.
     */
    private get _elements();
    /**
     * The elements container, created if absent.
     *
     * ONLY called from inside `commitLocal`'s transaction — i.e. only when
     * there is actually a shape to store. Creating it on open is what made the
     * race above reachable on every load; creating it on first write narrows
     * the window to "two people drew on a genuinely empty diagram in the same
     * instant", which is the case the CRDT can honestly only pick one answer
     * for anyway.
     */
    private _ensureElements;
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