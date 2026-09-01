import { Mark } from '@tiptap/core';
/**
 * The StarterKit options a canvas editor must use.
 *
 * Spread into `StarterKit.configure({ ...CANVAS_STARTER_KIT_OPTIONS, ... })`
 * wherever `CanvasLink` is registered. Turning StarterKit's link off is what
 * makes the two definitions unable to collide; everything else StarterKit
 * provides — heading, codeBlock, bold, the lists — is kept deliberately.
 *
 * A constant rather than a sentence in a comment so the requirement travels
 * with the import and a consumer can be tested against it.
 */
export declare const CANVAS_STARTER_KIT_OPTIONS: {
    link: false;
};
export interface CanvasLinkOptions {
    /** Extra attributes merged onto the rendered `<a>` — the styling hook for `ui-components`. */
    HTMLAttributes: Record<string, unknown>;
}
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        canvasLink: {
            /** Link the current selection. Refuses an href the scheme filter rejects. */
            setLink: (attributes: {
                href: string;
                title?: string | null;
            }) => ReturnType;
            /** Remove the link mark, including when the caret merely sits inside one. */
            unsetLink: () => ReturnType;
        };
    }
}
/**
 * Schemes that are never stored and never rendered as an `href`.
 *
 * `javascript:` and `vbscript:` execute on click. `data:` is here too despite
 * sounding inert: `data:text/html,...` and `data:image/svg+xml,...` carry script,
 * and no canvas document has a legitimate reason to hold one — a pasted image
 * belongs in the upload path, not in an href.
 *
 * A deny list rather than an allow list because internal schemes are load-bearing
 * (`mention:` above) and an allow list would need editing every time the product
 * invents one — which is exactly the edit that gets made in a hurry by widening
 * the list to everything.
 */
export declare const DANGEROUS_SCHEMES: readonly string[];
/**
 * The href to store and render, or `null` if it must be dropped.
 *
 * Called on parse, on `setLink` and again on render. The redundancy is
 * deliberate: a CRDT document can be written by an older client, by a merge, or
 * by a direct Y.Doc edit that never passed through a command, so the render path
 * cannot assume the stored value was ever checked.
 */
export declare function sanitizeHref(raw: unknown): string | null;
/**
 * Every attribute an `<a>` rendered from this mark is allowed to carry.
 *
 * The single place the security decision is made, which is why `href` and `title`
 * are declared `rendered: false` below — letting Tiptap render them per-attribute
 * would put the raw stored href into `HTMLAttributes` and give any later
 * `mergeAttributes` call a chance to reinstate it.
 *
 * `rel="noopener noreferrer"` is unconditional: `noopener` denies the target page
 * a handle on `window.opener` (tabnabbing), and `noreferrer` keeps the document's
 * own URL out of a third party's referer log — in this product a private
 * document's URL is itself the secret.
 */
export declare function linkTagAttributes(attrs: Record<string, unknown>): Record<string, string>;
/**
 * The href to apply when pasting over a selection, or `null` to paste normally.
 *
 * Stricter than the autolink pattern on purpose: the clipboard has to hold one
 * bare URL and nothing else. Pasting a sentence that merely contains a URL over
 * selected text means "replace this text", not "link it".
 */
export declare function linkHrefFromPastedText(text: string): string | null;
export declare const CanvasLink: Mark<CanvasLinkOptions, any>;
//# sourceMappingURL=link.d.ts.map