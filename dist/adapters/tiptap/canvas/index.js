"use strict";
// realtime-modules/src/adapters/tiptap/canvas/index.ts
//
// The canvas authoring surface: the Tiptap half of the white-page document.
//
// Placement, so the boundary stays honest:
//   distributed-core  format — DocModel, markdown serialise/parse, migration
//   THIS PACKAGE      Y.Doc and ProseMirror bindings
//   ui-components     <CanvasPage>, macro node views, paper styling
//   the app           document types, templates, routes
//
// Anything needing a Y.Doc, a ProseMirror view or a browser does not belong in
// the chassis. Everything here needs at least one of the three.
Object.defineProperty(exports, "__esModule", { value: true });
exports.pmToDocModel = exports.docModelToPm = exports.minimalEdit = exports.macroDataFromText = exports.macroTextFromData = exports.HeadingAnchor = exports.readMacroNode = exports.MACRO_NODE_NAME = exports.MacroNode = void 0;
var MacroNode_1 = require("./MacroNode");
Object.defineProperty(exports, "MacroNode", { enumerable: true, get: function () { return MacroNode_1.MacroNode; } });
Object.defineProperty(exports, "MACRO_NODE_NAME", { enumerable: true, get: function () { return MacroNode_1.MACRO_NODE_NAME; } });
Object.defineProperty(exports, "readMacroNode", { enumerable: true, get: function () { return MacroNode_1.readMacroNode; } });
var HeadingAnchor_1 = require("./HeadingAnchor");
Object.defineProperty(exports, "HeadingAnchor", { enumerable: true, get: function () { return HeadingAnchor_1.HeadingAnchor; } });
var macroText_1 = require("./macroText");
Object.defineProperty(exports, "macroTextFromData", { enumerable: true, get: function () { return macroText_1.macroTextFromData; } });
Object.defineProperty(exports, "macroDataFromText", { enumerable: true, get: function () { return macroText_1.macroDataFromText; } });
Object.defineProperty(exports, "minimalEdit", { enumerable: true, get: function () { return macroText_1.minimalEdit; } });
var pmModel_1 = require("./pmModel");
Object.defineProperty(exports, "docModelToPm", { enumerable: true, get: function () { return pmModel_1.docModelToPm; } });
Object.defineProperty(exports, "pmToDocModel", { enumerable: true, get: function () { return pmModel_1.pmToDocModel; } });
//# sourceMappingURL=index.js.map