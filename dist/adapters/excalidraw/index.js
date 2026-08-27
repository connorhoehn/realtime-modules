"use strict";
// realtime-modules/src/adapters/excalidraw/index.ts
//
// Excalidraw ↔ Yjs adapter. Behind its own subpath for the same reason the
// Tiptap adapter is: `./client` stays editor-agnostic, and consumers who never
// draw a diagram never resolve any of this.
//
// Note there is NO `@excalidraw/excalidraw` dependency here — the binding is
// typed structurally (see ./types). Excalidraw itself is imported once, in the
// ui-components component that renders the canvas.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIAGRAM_AWARENESS_KEY = exports.useCollaborativeDiagram = exports.diagramRootName = exports.DEFAULT_DIAGRAM_ROOT = exports.ExcalidrawYjsBinding = void 0;
var ExcalidrawYjsBinding_1 = require("./ExcalidrawYjsBinding");
Object.defineProperty(exports, "ExcalidrawYjsBinding", { enumerable: true, get: function () { return ExcalidrawYjsBinding_1.ExcalidrawYjsBinding; } });
Object.defineProperty(exports, "DEFAULT_DIAGRAM_ROOT", { enumerable: true, get: function () { return ExcalidrawYjsBinding_1.DEFAULT_DIAGRAM_ROOT; } });
Object.defineProperty(exports, "diagramRootName", { enumerable: true, get: function () { return ExcalidrawYjsBinding_1.diagramRootName; } });
var useCollaborativeDiagram_1 = require("./useCollaborativeDiagram");
Object.defineProperty(exports, "useCollaborativeDiagram", { enumerable: true, get: function () { return useCollaborativeDiagram_1.useCollaborativeDiagram; } });
Object.defineProperty(exports, "DIAGRAM_AWARENESS_KEY", { enumerable: true, get: function () { return useCollaborativeDiagram_1.DIAGRAM_AWARENESS_KEY; } });
//# sourceMappingURL=index.js.map