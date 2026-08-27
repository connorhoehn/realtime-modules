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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
    ExcalidrawYjsBinding,
    DEFAULT_DIAGRAM_ROOT,
    diagramRootName,
} from './ExcalidrawYjsBinding';
import type { DiagramCollaborator, DiagramElement, DiagramPresence } from './types';

/**
 * Structural view of a `y-protocols` Awareness instance.
 *
 * Typed structurally so this module compiles (and ships) without `y-protocols`
 * installed — it is an optional peer, and a consumer using the binding
 * headlessly should not be forced to install it.
 */
export interface AwarenessLike {
    clientID: number;
    getStates(): Map<number, Record<string, unknown>>;
    getLocalState(): Record<string, unknown> | null;
    setLocalStateField(field: string, value: unknown): void;
    on(event: 'change' | 'update', cb: (...args: unknown[]) => void): void;
    off(event: 'change' | 'update', cb: (...args: unknown[]) => void): void;
}

/** Awareness top-level key. Sibling of `user` / `cursor` / `call`. */
export const DIAGRAM_AWARENESS_KEY = 'diagram';

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

export interface UseCollaborativeDiagramOptions {
    /** Shared document. `null` while the provider is still bootstrapping. */
    ydoc: Y.Doc | null;
    /** Awareness from the same provider. Omit to run without live pointers. */
    awareness?: AwarenessLike | null;
    /**
     * Which diagram on the page this is.
     *
     * Omit for a standalone diagram that owns its whole Y.Doc. Pass a block id
     * when the diagram is one macro among many on a page — it namespaces both
     * the Y.Doc root type and the awareness pointers.
     */
    blockId?: string;
    /** Local identity, echoed to peers so they can label your cursor. */
    user?: { userId?: string; displayName: string; color: string };
    /**
     * Fires when REMOTE changes land. Never fires for this client's own
     * `commitLocal` writes, so there is no echo to guard against.
     */
    onRemoteElements?: (elements: DiagramElement[]) => void;
}

export interface UseCollaborativeDiagramReturn {
    binding: ExcalidrawYjsBinding | null;
    /** True once the binding exists and the scene can be read/written. */
    ready: boolean;
    /** Remote participants over THIS diagram, self excluded. */
    collaborators: DiagramCollaborator[];
    /** Push the local scene into the shared doc. Safe to call every onChange. */
    commitLocal: (elements: readonly DiagramElement[]) => void;
    /** Publish the local pointer. Throttled internally. */
    publishPointer: (presence: Omit<DiagramPresence, 'blockId'>) => void;
    /** Current shared scene, in z-order. */
    readAll: () => DiagramElement[];
}

export function useCollaborativeDiagram(
    options: UseCollaborativeDiagramOptions,
): UseCollaborativeDiagramReturn {
    const { ydoc, awareness, blockId, user, onRemoteElements } = options;

    const rootName = blockId ? diagramRootName(blockId) : DEFAULT_DIAGRAM_ROOT;
    const scopeId = blockId ?? DEFAULT_DIAGRAM_ROOT;

    const [binding, setBinding] = useState<ExcalidrawYjsBinding | null>(null);
    const [collaborators, setCollaborators] = useState<DiagramCollaborator[]>([]);

    const onRemoteRef = useRef(onRemoteElements);
    onRemoteRef.current = onRemoteElements;

    // ---- Binding lifecycle -------------------------------------------------
    useEffect(() => {
        if (!ydoc) {
            setBinding(null);
            return;
        }
        const b = new ExcalidrawYjsBinding({ ydoc, rootName });
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
    const userRef = useRef(user);
    userRef.current = user;

    // ---- Pointer publishing (throttled) ------------------------------------
    const lastSentAtRef = useRef(0);
    const pendingRef = useRef<DiagramPresence | null>(null);
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushPointer = useCallback(() => {
        flushTimerRef.current = null;
        const pending = pendingRef.current;
        if (!pending || !awareness) return;
        pendingRef.current = null;
        lastSentAtRef.current = Date.now();
        awareness.setLocalStateField(DIAGRAM_AWARENESS_KEY, pending);
    }, [awareness]);

    const publishPointer = useCallback(
        (presence: Omit<DiagramPresence, 'blockId'>) => {
            if (!awareness) return;
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
            if (flushTimerRef.current) return; // trailing flush already queued
            flushTimerRef.current = setTimeout(flushPointer, POINTER_THROTTLE_MS - since);
        },
        [awareness, flushPointer, scopeId],
    );

    // Clear our pointer on unmount so peers do not render a ghost cursor.
    useEffect(() => {
        if (!awareness) return;
        return () => {
            if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
            pendingRef.current = null;
            try {
                awareness.setLocalStateField(DIAGRAM_AWARENESS_KEY, null);
            } catch {
                /* provider already destroyed — nothing to clear */
            }
        };
    }, [awareness]);

    // ---- Reading peers off awareness ---------------------------------------
    useEffect(() => {
        if (!awareness) {
            setCollaborators([]);
            return;
        }

        let timer: ReturnType<typeof setTimeout> | null = null;

        const recompute = () => {
            timer = null;
            const next: DiagramCollaborator[] = [];
            awareness.getStates().forEach((state, clientId) => {
                if (clientId === awareness.clientID) return;
                const diagram = state?.[DIAGRAM_AWARENESS_KEY] as
                    | DiagramPresence
                    | null
                    | undefined;
                if (!diagram || diagram.blockId !== scopeId) return;

                const peer = (state?.user ?? {}) as Record<string, unknown>;
                next.push({
                    clientId: String(clientId),
                    userId: typeof peer.userId === 'string' ? peer.userId : undefined,
                    displayName:
                        (typeof peer.displayName === 'string' && peer.displayName) ||
                        (typeof peer.name === 'string' && peer.name) ||
                        'Anonymous',
                    color:
                        typeof peer.color === 'string' && peer.color
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
            if (timer) return;
            timer = setTimeout(recompute, COLLAB_COALESCE_MS);
        };

        recompute();
        awareness.on('change', schedule);
        return () => {
            awareness.off('change', schedule);
            if (timer) clearTimeout(timer);
        };
    }, [awareness, scopeId]);

    const commitLocal = useCallback(
        (elements: readonly DiagramElement[]) => {
            binding?.commitLocal(elements);
        },
        [binding],
    );

    const readAll = useCallback((): DiagramElement[] => binding?.readAll() ?? [], [binding]);

    return useMemo(
        () => ({
            binding,
            ready: binding !== null,
            collaborators,
            commitLocal,
            publishPointer,
            readAll,
        }),
        [binding, collaborators, commitLocal, publishPointer, readAll],
    );
}
