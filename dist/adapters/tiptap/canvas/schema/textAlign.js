"use strict";
// realtime-modules/src/adapters/tiptap/canvas/schema/textAlign.ts
//
// Block alignment for `paragraph` and `heading`.
//
// Owned here rather than pulled from `@tiptap/extension-text-align` for the same
// reason as the rest of `schema/`: what a canvas document can express is a
// contract, and a contract that lives in somebody else's package is one a minor
// bump can change without a compile error. This is ~40 lines of `Extension.create`
// — a dependency buys nothing and hides the tradeoff below.
//
// ## THE TRADEOFF: alignment does not survive markdown export
//
// Markdown has no alignment. Not in CommonMark, not in GFM — the only alignment
// syntax that exists anywhere is a table column marker, which does not apply to a
// paragraph. So `textAlign` behaves exactly like `UnderlineMark` in `marks.ts`:
// it lives in the Y.Doc, replicates to every collaborator, survives undo and
// reload, renders for everyone in the session — and is GONE the moment the
// document is serialised to markdown. `pmModel.ts` reads `paragraph` and
// `heading` content and never looks at their attributes, so a centred heading
// exports as a plain heading and comes back left-aligned on the next parse.
//
// That is a CRDT-only property, deliberately. The alternatives are worse:
// emitting `<p style="text-align:center">` puts raw HTML in a file the chassis
// then degrades to a code block, and inventing a `:::center` fence produces files
// other markdown tools render as literal colons. Losing a decorative property at
// the export boundary beats corrupting the file — but "why did my centring
// disappear after export" is otherwise a long hunt through the CRDT layer, so it
// is written down here.
//
// Implemented as a global attribute rather than forked Paragraph/Heading nodes so
// `blocks.ts` keeps sole ownership of those node definitions and this file adds
// exactly one thing to them.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanvasTextAlign = exports.TEXT_ALIGNMENTS = void 0;
exports.isTextAlignment = isTextAlignment;
exports.parseTextAlign = parseTextAlign;
exports.textAlignStyle = textAlignStyle;
const core_1 = require("@tiptap/core");
exports.TEXT_ALIGNMENTS = ['left', 'center', 'right', 'justify'];
function isTextAlignment(value) {
    return typeof value === 'string' && exports.TEXT_ALIGNMENTS.includes(value);
}
/**
 * The stored value for a parsed `text-align`, or `null` for anything else.
 *
 * Pasted HTML carries `text-align: start`, `end`, `-webkit-center`, `inherit`
 * and worse. Storing those verbatim would put values in the CRDT that no
 * `setTextAlign` call can ever produce and that a future consumer would have to
 * defend against — narrowing to the four known values at the boundary keeps the
 * attribute a closed set.
 */
function parseTextAlign(value) {
    return isTextAlignment(value) ? value : null;
}
/**
 * The style attribute for an alignment, or nothing when unset.
 *
 * Unset MUST render no `style` at all rather than `text-align: left`. Emitting
 * the default would make every untouched paragraph in the document carry an
 * inline style that overrides the paper's own CSS — including in a
 * right-to-left locale, where the correct default is not `left`.
 */
function textAlignStyle(value) {
    const alignment = parseTextAlign(value);
    return alignment ? { style: `text-align: ${alignment}` } : {};
}
exports.CanvasTextAlign = core_1.Extension.create({
    name: 'textAlign',
    addOptions() {
        return { types: ['paragraph', 'heading'] };
    },
    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    textAlign: {
                        default: null,
                        parseHTML: (element) => parseTextAlign(element.style.textAlign),
                        renderHTML: (attributes) => textAlignStyle(attributes.textAlign),
                    },
                },
            },
        ];
    },
    addCommands() {
        return {
            setTextAlign: (alignment) => ({ commands }) => {
                if (!isTextAlignment(alignment))
                    return false;
                // `some`, not `every`. A selection sits in paragraphs or in headings,
                // essentially never in both, and `updateAttributes` reports `false` for
                // a type it found nothing to update — so `every` would report failure
                // for the ordinary case of aligning one paragraph.
                return this.options.types
                    .map((type) => commands.updateAttributes(type, { textAlign: alignment }))
                    .some(Boolean);
            },
            unsetTextAlign: () => ({ commands }) => this.options.types
                .map((type) => commands.resetAttributes(type, 'textAlign'))
                .some(Boolean),
        };
    },
});
//# sourceMappingURL=textAlign.js.map