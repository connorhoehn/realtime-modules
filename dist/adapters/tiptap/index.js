"use strict";
// realtime-modules/src/adapters/tiptap/index.ts
//
// Tiptap-coupled subpath. Re-exported from the package as
// `@connorhoehn/realtime-modules/adapters/tiptap` so consumers using
// Monaco, CodeMirror, or contentEditable don't pull in Tiptap or
// ProseMirror just to use the editor-agnostic CRDT client surface.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditorToolbar = exports.TiptapEditor = void 0;
var TiptapEditor_1 = require("./TiptapEditor");
Object.defineProperty(exports, "TiptapEditor", { enumerable: true, get: function () { return __importDefault(TiptapEditor_1).default; } });
var EditorToolbar_1 = require("./EditorToolbar");
Object.defineProperty(exports, "EditorToolbar", { enumerable: true, get: function () { return __importDefault(EditorToolbar_1).default; } });
// v0.32.0 — the canvas authoring surface. The white-page document: one
// continuous body of blocks, macros as embedded tools, markdown as the
// exchange format. See ./canvas/index.ts for the cross-repo placement rule.
__exportStar(require("./canvas"), exports);
//# sourceMappingURL=index.js.map