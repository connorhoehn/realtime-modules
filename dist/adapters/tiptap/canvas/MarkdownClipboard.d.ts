import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
export declare const MARKDOWN_CLIPBOARD_KEY: PluginKey<any>;
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
export declare function looksLikeMarkdown(text: string): boolean;
export declare const MarkdownClipboard: Extension<any, any>;
//# sourceMappingURL=MarkdownClipboard.d.ts.map