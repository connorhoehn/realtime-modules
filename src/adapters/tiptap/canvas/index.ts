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
export {
  Callout,
  CALLOUT_NODE_NAME,
  CALLOUT_MACRO_NAME,
  CALLOUT_VARIANTS,
  CALLOUT_INPUT_RULE,
  normalizeCalloutVariant,
} from './schema/callout';
export type { CalloutVariant, CalloutOptions } from './schema/callout';

// Block alignment. A CRDT-only property: markdown cannot express it, so it does
// not survive export — the tradeoff is written out in `schema/textAlign.ts`.
export {
  CanvasTextAlign,
  TEXT_ALIGNMENTS,
  isTextAlignment,
  parseTextAlign,
  textAlignStyle,
} from './schema/textAlign';
export type { TextAlignment, CanvasTextAlignOptions } from './schema/textAlign';

// The `link` mark, replacing StarterKit's. Registering it REQUIRES
// `StarterKit.configure({ ...CANVAS_STARTER_KIT_OPTIONS })` — StarterKit's link
// rejects the `mention:` scheme `pmModel.ts` stores mentions under.
export {
  CanvasLink,
  CANVAS_STARTER_KIT_OPTIONS,
  DANGEROUS_SCHEMES,
  sanitizeHref,
  linkTagAttributes,
  linkHrefFromPastedText,
} from './schema/link';
export type { CanvasLinkOptions } from './schema/link';

// Comment decorations — seeing WHERE the comments are, in the text itself.
// A view concern, never a stored mark: a mark would write comment state into
// the document and therefore into the markdown file, and deleting a comment
// would have to edit the prose to remove it.
export { CommentHighlight } from './CommentHighlight';
export { CANVAS_COMMENT_CLASS, commentHighlightPluginKey } from './CommentHighlight';
// The write direction: a ProseMirror selection as the plain-text range
// `createAnchor` wants. Lives beside the painting code so both directions walk
// one segment table — see `plainRangeFromPm`.
// ...and the read direction, for a consumer that has to place something of its
// own (a gutter card) beside the anchored text.
export { plainRangeFromPm, pmRangesFromPlain } from './CommentHighlight';
export type {
  CommentHighlightOptions,
  CommentHighlightRef,
  CommentHighlightState,
} from './CommentHighlight';

// Anchors — what a comment refers to, surviving edits by collaborators.
export {
  createAnchor,
  resolveAnchor,
  anchorText,
  canvasPlainText,
  isCanvasAnchor,
} from './anchors';
export type { CanvasAnchor, AnchorRange } from './anchors';
