// realtime-modules/src/adapters/tiptap/canvas/MarkdownClipboard.ts
//
// Markdown in and out of the clipboard.
//
// The canvas STORES markdown, so the clipboard is the one place a user can
// tell whether that is real. Without this extension, copying a heading and a
// bullet list out of the page yields flat unstructured text, and pasting
// markdown in yields a single paragraph with visible `##` and `-` characters
// — a markdown-native document that cannot exchange markdown with anything.
//
// Both directions go through the chassis rather than a second markdown
// implementation: `parseDocument` / `serializeDocument` from
// distributed-core, and `docModelToPm` / `pmToDocModel` next door. A separate
// parser here would drift from the one that writes the file, which is exactly
// how a round trip starts losing content.
//
// ## What is deliberately NOT intercepted
//
// - A paste that carries `text/html`. Copying from a web page or another
//   editor gives both HTML and a plain-text fallback; the HTML is richer, so
//   Tiptap's own handling wins. Only a plain-text-only paste — a markdown
//   file, a terminal, a chat message — is treated as markdown.
// - Anything pasted INTO a code block. There, `# foo` is code and must stay
//   literal. Transforming it would silently rewrite the user's source.
// - An empty selection on copy, which has nothing to serialise.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PmProseMirrorNode, Slice } from '@tiptap/pm/model';
import { parseDocument, serializeDocument } from 'distributed-core/applications/document';
import { docModelToPm, pmToDocModel, type PmNode } from './pmModel';

export const MARKDOWN_CLIPBOARD_KEY = new PluginKey('markdownClipboard');

/**
 * True when the text carries at least one BLOCK-level markdown construct.
 *
 * Inline-only markers are deliberately not enough. A sentence containing
 * `2 * 3 * 4` or a filename like `some_file_name` would otherwise be parsed
 * as emphasis and come back with characters removed — silent corruption of
 * ordinary prose, which is far worse than failing to convert a bold run.
 * Block markers (`#`, `-`, `1.`, `>`, fences, tables) are unambiguous enough
 * to act on.
 */
export function looksLikeMarkdown(text: string): boolean {
  return /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\|.*\|)/m.test(text);
}

/** ProseMirror JSON for a document fragment, as the adapter produces it. */
function fragmentFromMarkdown(markdown: string): PmNode[] {
  const { doc } = docModelToPm(parseDocument(markdown));
  return doc.content ?? [];
}

export const MarkdownClipboard = Extension.create({
  name: 'markdownClipboard',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: MARKDOWN_CLIPBOARD_KEY,
        props: {
          handlePaste(view, event) {
            const clipboard = event.clipboardData;
            if (!clipboard) return false;

            // HTML is richer than our plain-text fallback — let Tiptap have it.
            if (clipboard.types.includes('text/html')) return false;

            const text = clipboard.getData('text/plain');
            if (!text || !looksLikeMarkdown(text)) return false;

            // Inside a code block the markers are content, not syntax.
            if (editor.isActive('codeBlock')) return false;

            let content: PmNode[];
            try {
              content = fragmentFromMarkdown(text);
            } catch {
              // A parse failure must fall back to the normal plain-text paste
              // rather than dropping what the user pasted.
              return false;
            }
            if (content.length === 0) return false;

            editor.chain().focus().insertContent(content as never).run();
            return true;
          },

          /**
           * What lands on the clipboard as `text/plain`.
           *
           * ProseMirror's default flattens to textContent, losing every
           * structure the document had. Serialising through the chassis means
           * a heading pastes into a markdown file AS a heading.
           */
          clipboardTextSerializer(slice: Slice) {
            try {
              const json = sliceToJson(slice);
              if (!json.content || json.content.length === 0) return '';
              return serializeDocument(pmToDocModel(json, {})).trimEnd();
            } catch {
              return slice.content.textBetween(0, slice.content.size, '\n\n');
            }
          },
        },
      }),
    ];
  },
});

/**
 * A copied SLICE is not a document: it can start and end mid-node, and its
 * open depths describe how. Wrapping the fragment in a doc-shaped object is
 * what lets the model converter treat it as blocks. Partial nodes at the
 * edges serialise as their own block, which is the same thing every markdown
 * editor does with a half-copied paragraph.
 */
function sliceToJson(slice: Slice): PmNode {
  const content: PmNode[] = [];
  slice.content.forEach((node: PmProseMirrorNode) => {
    content.push(node.toJSON() as PmNode);
  });
  return { type: 'doc', content };
}
