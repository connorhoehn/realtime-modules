"use strict";
// realtime-modules/src/adapters/tiptap/canvas/nodeNames.ts
//
// The node names and variant vocabulary, with no Tiptap import.
//
// These live apart from the Node definitions that use them because pmModel.ts
// needs the names and nothing else. It used to read MACRO_NODE_NAME from
// MacroNode.ts and the callout constants from schema/callout.ts, and both of
// those import `@tiptap/core` to declare a Node — so `./client`, which reaches
// pmModel through useCanvasDocument, dragged `@tiptap/core` in behind a string
// constant. The `./client` barrel says in its own header that Tiptap lives
// behind `./adapters/tiptap` so consumers on Monaco or CodeMirror "don't pull
// in Tiptap or ProseMirror"; this file is part of making that true.
//
// Both Node modules re-export from here, so `./adapters/tiptap` and its canvas
// barrel keep the exact surface they had.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CALLOUT_VARIANT = exports.CALLOUT_VARIANTS = exports.CALLOUT_MACRO_NAME = exports.CALLOUT_NODE_NAME = exports.MACRO_NODE_NAME = void 0;
exports.normalizeCalloutVariant = normalizeCalloutVariant;
/** The macro leaf's node name. */
exports.MACRO_NODE_NAME = 'macro';
/** The callout node's name. */
exports.CALLOUT_NODE_NAME = 'callout';
/**
 * The macro name the marker leaf uses inside the blockquote.
 *
 * `pmModel.ts` is the intended consumer: `blockToPm` recognises a `blockquote`
 * whose first child is a `macro` with this name and emits a `callout` node
 * from the remaining children; `pmBlocksToModel` does the inverse.
 */
exports.CALLOUT_MACRO_NAME = 'callout';
exports.CALLOUT_VARIANTS = ['info', 'note', 'warning', 'success', 'error'];
/** The variant an unlabelled callout takes. */
exports.DEFAULT_CALLOUT_VARIANT = 'info';
/**
 * The variant a value denotes, or `info`.
 *
 * Applied on the way IN from the DOM and again on the way OUT to it. Both
 * matter: an imported document, a hand-edited markdown file or a CRDT merge
 * can all carry a variant this build has never heard of.
 */
function normalizeCalloutVariant(value) {
    return exports.CALLOUT_VARIANTS.includes(value)
        ? value
        : exports.DEFAULT_CALLOUT_VARIANT;
}
//# sourceMappingURL=nodeNames.js.map