// realtime-modules/src/adapters/tiptap/canvas/MacroNode.ts
//
// The canvas macro node — an embedded tool (action item, decision, typed
// field) living inline in the page body.
//
// See `macroText.ts` for why this is a **textblock holding literal YAML**
// rather than an atom holding attributes. The short version: a textblock makes
// block-level suggestions fall out of the existing mark-based machinery for
// free, and makes the markdown round trip exact by construction.

import { Node, mergeAttributes } from '@tiptap/core';
import type { JsonObject } from 'distributed-core/applications/document';
import { macroDataFromText, macroTextFromData, minimalEdit } from './macroText';

export interface MacroNodeOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Commands<ReturnType> {
    macro: {
      /** Insert a macro block at the current selection. */
      insertMacro: (name: string, data: JsonObject) => ReturnType;
      /**
       * Rewrite the payload of the macro at `pos` (the position of the macro
       * node itself, as returned by a node view's `getPos()`).
       */
      setMacroData: (pos: number, data: JsonObject) => ReturnType;
    };
  }
}

export const MACRO_NODE_NAME = 'macro';

export const MacroNode = Node.create<MacroNodeOptions>({
  name: MACRO_NODE_NAME,

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
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      ['code', 0],
    ];
  },

  addCommands() {
    return {
      insertMacro:
        (name, data) =>
        ({ commands }) => {
          const text = macroTextFromData(name, data);
          return commands.insertContent({
            type: this.name,
            attrs: { macroName: name },
            content: text === '' ? [] : [{ type: 'text', text }],
          });
        },

      setMacroData:
        (pos, data) =>
        ({ state, dispatch, tr }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== this.name) return false;

          const before = node.textContent;
          const after = macroTextFromData(
            String(node.attrs.macroName ?? 'unknown'),
            data,
          );
          const edit = minimalEdit(before, after);
          if (!edit) return true; // already correct — a no-op, not a failure
          if (!dispatch) return true;

          // +1 skips the node's opening token, so offsets are into its text.
          const base = pos + 1;
          if (edit.insert === '') {
            tr.delete(base + edit.from, base + edit.to);
          } else {
            tr.replaceWith(
              base + edit.from,
              base + edit.to,
              state.schema.text(edit.insert),
            );
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
export function readMacroNode(node: {
  attrs: Record<string, unknown>;
  textContent: string;
}): { name: string; data: JsonObject | null; source: string } {
  const name = String(node.attrs.macroName ?? 'unknown');
  return { name, data: macroDataFromText(name, node.textContent), source: node.textContent };
}
