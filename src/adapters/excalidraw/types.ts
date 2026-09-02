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

/** Local identity as it should be labelled on a peer's canvas. */
export interface DiagramIdentity {
    /** Stable identity (Cognito sub) when the host has one. */
    userId?: string;
    displayName: string;
    /** Hex colour. The host supplies it so one person is one colour everywhere. */
    color: string;
}

/**
 * Awareness payload published under the top-level `diagram` key.
 *
 * ## This is ONE object, written whole
 *
 * `setLocalStateField` replaces the value at a key — it does not merge into it.
 * So every field a peer needs has to be present on every write, and the hook
 * keeps a local mirror it merges partial updates into before publishing. The
 * earlier code wrote `{ pointer, button }` from the pointer handler and
 * `{ selectedElementIds }` from the change handler, and the two clobbered each
 * other several times a second: whichever fired last won, so a peer's cursor
 * vanished the moment they selected something and their selection vanished the
 * moment they moved the mouse.
 *
 * ## It carries identity, deliberately
 *
 * `useAwarenessState` publishes `user` on the same awareness state and is its
 * single writer, so the obvious move is to read a peer's name and colour from
 * there. That works in a DOCUMENT, which mounts `useAwarenessState`, and fails
 * on the STANDALONE board, which builds its own provider and has no
 * `useAwarenessState` at all — every peer renders as "Anonymous" in the default
 * blue.
 *
 * Carrying identity here fixes the standalone case without breaking the
 * single-writer rule, and costs almost nothing: `GatewayProvider` encodes the
 * ENTIRE local awareness state on every flush (`encodeAwarenessUpdate` JSON
 * -stringifies the whole thing rather than sending a delta), so in a document
 * the `user` object is already on every frame this adds ~40 bytes to.
 * Readers prefer this field and fall back to `user`.
 */
export interface DiagramPresence {
    /**
     * Which diagram on the page this pointer belongs to. A page-level Y.Doc
     * can host several diagram blocks sharing one awareness channel, so every
     * pointer has to say which canvas it is over.
     */
    blockId: string;
    /** Who this is. See the note above on why it rides the diagram key. */
    user?: DiagramIdentity;
    pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
    button?: 'up' | 'down';
    selectedElementIds?: Record<string, boolean>;
    /**
     * Liveness stamp, epoch ms, refreshed by the heartbeat.
     *
     * Exists because nothing else tells a peer you are gone promptly. The
     * gateway does not broadcast an awareness removal when a socket drops
     * (`CRDTService.onClientDisconnect` clears only its own bookkeeping), so a
     * closed tab would otherwise sit on everyone's canvas until y-protocols'
     * own 30s `outdatedTimeout` sweep noticed. Readers drop a peer whose stamp
     * has gone stale. See `PRESENCE_STALE_MS`.
     */
    t?: number;
}

/** One participant on the board, resolved from awareness into render-ready shape. */
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
    /** True for the local user. Only ever set on entries in `participants`. */
    isSelf?: boolean;
}
