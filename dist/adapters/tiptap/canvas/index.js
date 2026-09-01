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
exports.linkHrefFromPastedText = exports.linkTagAttributes = exports.sanitizeHref = exports.DANGEROUS_SCHEMES = exports.CANVAS_STARTER_KIT_OPTIONS = exports.CanvasLink = exports.textAlignStyle = exports.parseTextAlign = exports.isTextAlignment = exports.TEXT_ALIGNMENTS = exports.CanvasTextAlign = exports.normalizeCalloutVariant = exports.CALLOUT_INPUT_RULE = exports.CALLOUT_VARIANTS = exports.CALLOUT_MACRO_NAME = exports.CALLOUT_NODE_NAME = exports.Callout = exports.MARKDOWN_CLIPBOARD_KEY = exports.looksLikeMarkdown = exports.MarkdownClipboard = exports.pmToDocModel = exports.docModelToPm = exports.minimalEdit = exports.macroDataFromText = exports.macroTextFromData = exports.HeadingAnchor = exports.readMacroNode = exports.MACRO_NODE_NAME = exports.MacroNode = void 0;
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
// Markdown on the clipboard — the direction that makes "markdown-native"
// observable. Paste a markdown file in, copy a heading out AS a heading.
var MarkdownClipboard_1 = require("./MarkdownClipboard");
Object.defineProperty(exports, "MarkdownClipboard", { enumerable: true, get: function () { return MarkdownClipboard_1.MarkdownClipboard; } });
Object.defineProperty(exports, "looksLikeMarkdown", { enumerable: true, get: function () { return MarkdownClipboard_1.looksLikeMarkdown; } });
Object.defineProperty(exports, "MARKDOWN_CLIPBOARD_KEY", { enumerable: true, get: function () { return MarkdownClipboard_1.MARKDOWN_CLIPBOARD_KEY; } });
// ---------------------------------------------------------------------------
// Schema additions
//
// Only what `@tiptap/starter-kit` does NOT provide. Heading, codeBlock, the
// marks and the lists come from StarterKit and are deliberately not redefined
// here: two definitions of one node name is a merged attribute set and a
// duplicate-name warning, not a choice between them.
// ---------------------------------------------------------------------------
// Confluence-style panels. StarterKit has no equivalent, and this one reaches
// markdown — see `pmModel.ts`.
var callout_1 = require("./schema/callout");
Object.defineProperty(exports, "Callout", { enumerable: true, get: function () { return callout_1.Callout; } });
Object.defineProperty(exports, "CALLOUT_NODE_NAME", { enumerable: true, get: function () { return callout_1.CALLOUT_NODE_NAME; } });
Object.defineProperty(exports, "CALLOUT_MACRO_NAME", { enumerable: true, get: function () { return callout_1.CALLOUT_MACRO_NAME; } });
Object.defineProperty(exports, "CALLOUT_VARIANTS", { enumerable: true, get: function () { return callout_1.CALLOUT_VARIANTS; } });
Object.defineProperty(exports, "CALLOUT_INPUT_RULE", { enumerable: true, get: function () { return callout_1.CALLOUT_INPUT_RULE; } });
Object.defineProperty(exports, "normalizeCalloutVariant", { enumerable: true, get: function () { return callout_1.normalizeCalloutVariant; } });
// Block alignment. A CRDT-only property: markdown cannot express it, so it does
// not survive export — the tradeoff is written out in `schema/textAlign.ts`.
var textAlign_1 = require("./schema/textAlign");
Object.defineProperty(exports, "CanvasTextAlign", { enumerable: true, get: function () { return textAlign_1.CanvasTextAlign; } });
Object.defineProperty(exports, "TEXT_ALIGNMENTS", { enumerable: true, get: function () { return textAlign_1.TEXT_ALIGNMENTS; } });
Object.defineProperty(exports, "isTextAlignment", { enumerable: true, get: function () { return textAlign_1.isTextAlignment; } });
Object.defineProperty(exports, "parseTextAlign", { enumerable: true, get: function () { return textAlign_1.parseTextAlign; } });
Object.defineProperty(exports, "textAlignStyle", { enumerable: true, get: function () { return textAlign_1.textAlignStyle; } });
// The `link` mark, replacing StarterKit's. Registering it REQUIRES
// `StarterKit.configure({ ...CANVAS_STARTER_KIT_OPTIONS })` — StarterKit's link
// rejects the `mention:` scheme `pmModel.ts` stores mentions under.
var link_1 = require("./schema/link");
Object.defineProperty(exports, "CanvasLink", { enumerable: true, get: function () { return link_1.CanvasLink; } });
Object.defineProperty(exports, "CANVAS_STARTER_KIT_OPTIONS", { enumerable: true, get: function () { return link_1.CANVAS_STARTER_KIT_OPTIONS; } });
Object.defineProperty(exports, "DANGEROUS_SCHEMES", { enumerable: true, get: function () { return link_1.DANGEROUS_SCHEMES; } });
Object.defineProperty(exports, "sanitizeHref", { enumerable: true, get: function () { return link_1.sanitizeHref; } });
Object.defineProperty(exports, "linkTagAttributes", { enumerable: true, get: function () { return link_1.linkTagAttributes; } });
Object.defineProperty(exports, "linkHrefFromPastedText", { enumerable: true, get: function () { return link_1.linkHrefFromPastedText; } });
//# sourceMappingURL=index.js.map