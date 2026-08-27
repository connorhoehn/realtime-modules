import * as Y from 'yjs';
import { ExcalidrawYjsBinding } from './ExcalidrawYjsBinding';
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
export declare const DIAGRAM_AWARENESS_KEY = "diagram";
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
    user?: {
        userId?: string;
        displayName: string;
        color: string;
    };
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
export declare function useCollaborativeDiagram(options: UseCollaborativeDiagramOptions): UseCollaborativeDiagramReturn;
//# sourceMappingURL=useCollaborativeDiagram.d.ts.map