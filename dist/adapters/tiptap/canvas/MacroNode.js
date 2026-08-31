"use strict";
// realtime-modules/src/adapters/tiptap/canvas/MacroNode.ts
//
// The canvas macro node — an embedded tool (action item, decision, typed
// field) living inline in the page body.
//
// See `macroText.ts` for why this is a **textblock holding literal YAML**
// rather than an atom holding attributes. The short version: a textblock makes
// block-level suggestions fall out of the existing mark-based machinery for
// free, and makes the markdown round trip exact by construction.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MacroNode = exports.MACRO_NODE_NAME = void 0;
exports.readMacroNode = readMacroNode;
const core_1 = require("@tiptap/core");
const macroText_1 = require("./macroText");
exports.MACRO_NODE_NAME = 'macro';
exports.MacroNode = core_1.Node.create({
    name: exports.MACRO_NODE_NAME,
    addOptions() {
        return { HTMLAttributes: {} };
    },
    group: 'block',
    // A textblock, exactly like `code_block`. `code: true` additionally gives us
    // `whitespace: 'pre'` for free from prosemirror-model, which is what keeps
    // the YAML's newlines and indentation intact.
    content: 'text*',
    code: true,
    // `marks: '_'` allows EVERY mark, and that is the whole point: the
    // suggestion fork marks deleted text with `suggestionDelete`, and a macro
    // whose text rejected marks would silently drop block-level suggestions.
    // `code_block` in StarterKit sets `marks: ''` — do not copy that here.
    marks: '_',
    // `defining` keeps the node (and its `macroName`) alive when its content is
    // replaced wholesale, which is exactly what `setMacroData` does on a field
    // edit. `isolating` stops a backspace at the start of the block from
    // half-merging YAML into the paragraph above.
    defining: true,
    isolating: true,
    addAttributes() {
        return {
            macroName: {
                default: 'unknown',
                parseHTML: (element) => element.getAttribute('data-macro') ?? 'unknown',
                renderHTML: (attributes) => ({ 'data-macro': attributes.macroName }),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'pre[data-macro]', preserveWhitespace: 'full' }];
    },
    renderHTML({ HTMLAttributes }) {
        return [
            'pre',
            (0, core_1.mergeAttributes)(this.options.HTMLAttributes, HTMLAttributes),
            ['code', 0],
        ];
    },
    addCommands() {
        return {
            insertMacro: (name, data) => ({ commands }) => {
                const text = (0, macroText_1.macroTextFromData)(name, data);
                return commands.insertContent({
                    type: this.name,
                    attrs: { macroName: name },
                    content: text === '' ? [] : [{ type: 'text', text }],
                });
            },
            setMacroData: (pos, data) => ({ state, dispatch, tr }) => {
                const node = state.doc.nodeAt(pos);
                if (!node || node.type.name !== this.name)
                    return false;
                const before = node.textContent;
                const after = (0, macroText_1.macroTextFromData)(String(node.attrs.macroName ?? 'unknown'), data);
                const edit = (0, macroText_1.minimalEdit)(before, after);
                if (!edit)
                    return true; // already correct — a no-op, not a failure
                if (!dispatch)
                    return true;
                // +1 skips the node's opening token, so offsets are into its text.
                const base = pos + 1;
                if (edit.insert === '') {
                    tr.delete(base + edit.from, base + edit.to);
                }
                else {
                    tr.replaceWith(base + edit.from, base + edit.to, state.schema.text(edit.insert));
                }
                dispatch(tr);
                return true;
            },
        };
    },
});
/**
 * The payload of a macro node, or `null` if its text is not valid YAML.
 *
 * A thin re-export shaped for node views, which hold a `node` rather than a
 * string. Kept here so a consumer never has to reach for `node.textContent`
 * and re-derive the name attribute itself.
 */
function readMacroNode(node) {
    const name = String(node.attrs.macroName ?? 'unknown');
    return { name, data: (0, macroText_1.macroDataFromText)(name, node.textContent), source: node.textContent };
}
//# sourceMappingURL=MacroNode.js.map