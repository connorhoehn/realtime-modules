"use strict";
// realtime-modules/src/adapters/excalidraw/useCollaborativeDiagram.ts
//
// The hook a host app (or a ui-components composite) consumes to make an
// Excalidraw canvas collaborative. It owns the binding lifecycle and the
// awareness read/write for pointers — and nothing else.
//
// ---------------------------------------------------------------------------
// It does not create a Y.Doc, a provider, or a socket
// ---------------------------------------------------------------------------
// Those already exist and are already generic: `useYjsDoc` + `GatewayProvider`
// in `./client`, `CRDTService` + `SnapshotManager` in `./server`. That stack is
// schema-agnostic — it applies opaque Yjs updates and snapshots opaque Yjs
// state — so a diagram inherits transport, snapshots, hot cache, idle
// eviction, cross-node fan-out and authz without one line of new sync code.
// Nothing here is diagram-specific except the shape of the data.
//
// ---------------------------------------------------------------------------
// Awareness: a sibling key, never nested under `user`
// ---------------------------------------------------------------------------
// `useAwarenessState` is the single writer of the `user` awareness field and
// flushes it as a WHOLE OBJECT, so anything merged into `user` from elsewhere
// gets clobbered on the next identity change. Pointers therefore live under a
// top-level `diagram` key, exactly as document carets live under `cursor` and
// call state lives under `call`.
//
// This reuses the ONE awareness channel the document editor already uses. No
// second presence path, no second socket.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIAGRAM_AWARENESS_KEY = void 0;
exports.useCollaborativeDiagram = useCollaborativeDiagram;
const react_1 = require("react");
const ExcalidrawYjsBinding_1 = require("./ExcalidrawYjsBinding");
/** Awareness top-level key. Sibling of `user` / `cursor` / `call`. */
exports.DIAGRAM_AWARENESS_KEY = 'diagram';
/**
 * Pointer publish interval.
 *
 * The gateway rate-limits `crdt` awareness frames to 60/s per client and
 * `GatewayProvider` already debounces its awareness send by 50ms. Throttling
 * the local write to the same 50ms keeps us at ~20 frames/s — a third of
 * budget, with room for the document editor's carets on the same channel.
 */
const POINTER_THROTTLE_MS = 50;
/** Collaborator-list recompute coalesce window. Keeps React renders bounded. */
const COLLAB_COALESCE_MS = 60;
const DEFAULT_COLOR = '#3b82f6';
function useCollaborativeDiagram(options) {
    const { ydoc, awareness, blockId, user, onRemoteElements } = options;
    const rootName = blockId ? (0, ExcalidrawYjsBinding_1.diagramRootName)(blockId) : ExcalidrawYjsBinding_1.DEFAULT_DIAGRAM_ROOT;
    const scopeId = blockId ?? ExcalidrawYjsBinding_1.DEFAULT_DIAGRAM_ROOT;
    const [binding, setBinding] = (0, react_1.useState)(null);
    const [collaborators, setCollaborators] = (0, react_1.useState)([]);
    const onRemoteRef = (0, react_1.useRef)(onRemoteElements);
    onRemoteRef.current = onRemoteElements;
    // ---- Binding lifecycle -------------------------------------------------
    (0, react_1.useEffect)(() => {
        if (!ydoc) {
            setBinding(null);
            return;
        }
        const b = new ExcalidrawYjsBinding_1.ExcalidrawYjsBinding({ ydoc, rootName });
        setBinding(b);
        const unobserve = b.observe((elements) => {
            onRemoteRef.current?.(elements);
        });
        return () => {
            unobserve();
            b.destroy();
            setBinding(null);
        };
    }, [ydoc, rootName]);
    // ---- Local identity onto awareness -------------------------------------
    // Only the diagram-scoped fields. Identity itself (`user`) is owned by
    // useAwarenessState; we read it back off peers rather than duplicating it.
    const userRef = (0, react_1.useRef)(user);
    userRef.current = user;
    // ---- Pointer publishing (throttled) ------------------------------------
    const lastSentAtRef = (0, react_1.useRef)(0);
    const pendingRef = (0, react_1.useRef)(null);
    const flushTimerRef = (0, react_1.useRef)(null);
    const flushPointer = (0, react_1.useCallback)(() => {
        flushTimerRef.current = null;
        const pending = pendingRef.current;
        if (!pending || !awareness)
            return;
        pendingRef.current = null;
        lastSentAtRef.current = Date.now();
        awareness.setLocalStateField(exports.DIAGRAM_AWARENESS_KEY, pending);
    }, [awareness]);
    const publishPointer = (0, react_1.useCallback)((presence) => {
        if (!awareness)
            return;
        pendingRef.current = { ...presence, blockId: scopeId };
        const since = Date.now() - lastSentAtRef.current;
        if (since >= POINTER_THROTTLE_MS) {
            if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            flushPointer();
            return;
        }
        if (flushTimerRef.current)
            return; // trailing flush already queued
        flushTimerRef.current = setTimeout(flushPointer, POINTER_THROTTLE_MS - since);
    }, [awareness, flushPointer, scopeId]);
    // Clear our pointer on unmount so peers do not render a ghost cursor.
    (0, react_1.useEffect)(() => {
        if (!awareness)
            return;
        return () => {
            if (flushTimerRef.current)
                clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
            pendingRef.current = null;
            try {
                awareness.setLocalStateField(exports.DIAGRAM_AWARENESS_KEY, null);
            }
            catch {
                /* provider already destroyed — nothing to clear */
            }
        };
    }, [awareness]);
    // ---- Reading peers off awareness ---------------------------------------
    (0, react_1.useEffect)(() => {
        if (!awareness) {
            setCollaborators([]);
            return;
        }
        let timer = null;
        const recompute = () => {
            timer = null;
            const next = [];
            awareness.getStates().forEach((state, clientId) => {
                if (clientId === awareness.clientID)
                    return;
                const diagram = state?.[exports.DIAGRAM_AWARENESS_KEY];
                if (!diagram || diagram.blockId !== scopeId)
                    return;
                const peer = (state?.user ?? {});
                next.push({
                    clientId: String(clientId),
                    userId: typeof peer.userId === 'string' ? peer.userId : undefined,
                    displayName: (typeof peer.displayName === 'string' && peer.displayName) ||
                        (typeof peer.name === 'string' && peer.name) ||
                        'Anonymous',
                    color: typeof peer.color === 'string' && peer.color
                        ? peer.color
                        : DEFAULT_COLOR,
                    pointer: diagram.pointer,
                    button: diagram.button,
                    selectedElementIds: diagram.selectedElementIds,
                });
            });
            setCollaborators(next);
        };
        const schedule = () => {
            if (timer)
                return;
            timer = setTimeout(recompute, COLLAB_COALESCE_MS);
        };
        recompute();
        awareness.on('change', schedule);
        return () => {
            awareness.off('change', schedule);
            if (timer)
                clearTimeout(timer);
        };
    }, [awareness, scopeId]);
    const commitLocal = (0, react_1.useCallback)((elements) => {
        binding?.commitLocal(elements);
    }, [binding]);
    const readAll = (0, react_1.useCallback)(() => binding?.readAll() ?? [], [binding]);
    return (0, react_1.useMemo)(() => ({
        binding,
        ready: binding !== null,
        collaborators,
        commitLocal,
        publishPointer,
        readAll,
    }), [binding, collaborators, commitLocal, publishPointer, readAll]);
}
//# sourceMappingURL=useCollaborativeDiagram.js.map