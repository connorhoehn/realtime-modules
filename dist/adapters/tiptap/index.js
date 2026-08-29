"use strict";
// realtime-modules/src/adapters/tiptap/index.ts
//
// Tiptap-coupled subpath. Re-exported from the package as
// `@connorhoehn/realtime-modules/adapters/tiptap` so consumers using
// Monaco, CodeMirror, or contentEditable don't pull in Tiptap or
// ProseMirror just to use the editor-agnostic CRDT client surface.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditorToolbar = exports.TiptapEditor = void 0;
var TiptapEditor_1 = require("./TiptapEditor");
Object.defineProperty(exports, "TiptapEditor", { enumerable: true, get: function () { return __importDefault(TiptapEditor_1).default; } });
var EditorToolbar_1 = require("./EditorToolbar");
Object.defineProperty(exports, "EditorToolbar", { enumerable: true, get: function () { return __importDefault(EditorToolbar_1).default; } });
//# sourceMappingURL=index.js.map