// realtime-modules/src/adapters/excalidraw/types.ts
//
// Structural types for the Excalidraw binding.
//
// This adapter deliberately does NOT import `@excalidraw/excalidraw`. The
// binding only needs three properties off an element (`id`, `version`,
// `versionNonce`) plus the fractional `index` for z-order, and every one of
// those is a plain JSON scalar. Typing structurally means:
//
//   - realtime-modules installs with no Excalidraw dependency at all, so the
//     `./client` surface stays as light as it is today;
//   - the binding is testable in Node with plain objects (no canvas, no DOM);
//   - an Excalidraw major bump cannot break this package's type-check.
//
// The consuming component (ui-components' CollaborativeExcalidraw) owns the
// real Excalidraw types and casts at that boundary — one cast in one file
// instead of a hard dep threaded through the library.

/**
 * The subset of an Excalidraw element this binding reasons about.
 *
 * `version` / `versionNonce` are Excalidraw's own per-element change counters.
 * They are what Excalidraw's `reconcileElements` uses to break ties, and they
 * are what lets `commitLocal` skip untouched elements in O(1) instead of
 * deep-comparing an entire scene on every pointer move.
 *
 * `index` is Excalidraw's fractional index (a lexicographically-sortable
 * string such as `"a1"`, added in 0.17). Because z-order is carried as a
 * regular element property, this binding needs NO ordering CRDT — a keyed
 * `Y.Map` plus a sort on read is sufficient and conflict-free.
 */
export interface DiagramElement {
    id: string;
    version: number;
    versionNonce: number;
    /** Fractional index; absent on elements from pre-0.17 scenes. */
    index?: string | null;
    /** Excalidraw tombstones rather than removing — so do we. */
    isDeleted?: boolean;
    [key: string]: unknown;
}

/** Awareness payload published under the top-level `diagram` key. */
export interface DiagramPresence {
    /**
     * Which diagram on the page this pointer belongs to. A page-level Y.Doc
     * can host several diagram blocks sharing one awareness channel, so every
     * pointer has to say which canvas it is over.
     */
    blockId: string;
    pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
    button?: 'up' | 'down';
    selectedElementIds?: Record<string, boolean>;
}

/** One remote participant, resolved from awareness into render-ready shape. */
export interface DiagramCollaborator {
    /** Yjs awareness clientID, stringified. Stable for the socket's lifetime. */
    clientId: string;
    /** Stable identity (Cognito sub) when the peer published one. */
    userId?: string;
    displayName: string;
    color: string;
    pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
    button?: 'up' | 'down';
    selectedElementIds?: Record<string, boolean>;
}
