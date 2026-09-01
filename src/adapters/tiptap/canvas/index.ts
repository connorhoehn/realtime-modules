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

export { MacroNode, MACRO_NODE_NAME, readMacroNode } from './MacroNode';
export type { MacroNodeOptions } from './MacroNode';
export { HeadingAnchor } from './HeadingAnchor';
export {
  macroTextFromData,
  macroDataFromText,
  minimalEdit,
} from './macroText';
export type { TextRangeEdit } from './macroText';
export { docModelToPm, pmToDocModel } from './pmModel';
export type { PmNode, PmMark, ToPmResult, UnsupportedForm } from './pmModel';

// Markdown on the clipboard — the direction that makes "markdown-native"
// observable. Paste a markdown file in, copy a heading out AS a heading.
export { MarkdownClipboard, looksLikeMarkdown, MARKDOWN_CLIPBOARD_KEY } from './MarkdownClipboard';
