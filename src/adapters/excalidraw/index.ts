// realtime-modules/src/adapters/excalidraw/index.ts
//
// Excalidraw ↔ Yjs adapter. Behind its own subpath for the same reason the
// Tiptap adapter is: `./client` stays editor-agnostic, and consumers who never
// draw a diagram never resolve any of this.
//
// Note there is NO `@excalidraw/excalidraw` dependency here — the binding is
// typed structurally (see ./types). Excalidraw itself is imported once, in the
// ui-components component that renders the canvas.

export {
    ExcalidrawYjsBinding,
    DEFAULT_DIAGRAM_ROOT,
    diagramRootName,
} from './ExcalidrawYjsBinding';
export type { ExcalidrawYjsBindingOptions } from './ExcalidrawYjsBinding';

export {
    useCollaborativeDiagram,
    DIAGRAM_AWARENESS_KEY,
} from './useCollaborativeDiagram';
export type {
    AwarenessLike,
    UseCollaborativeDiagramOptions,
    UseCollaborativeDiagramReturn,
} from './useCollaborativeDiagram';

export type {
    DiagramElement,
    DiagramPresence,
    DiagramCollaborator,
} from './types';
