"use strict";
// realtime-modules/src/adapters/tiptap/canvas/schema/link.ts
//
// The `link` mark, owned outright.
//
// Two reasons this is not `@tiptap/starter-kit`'s Link, and the second is the
// load-bearing one:
//
//   1. The mark name and its attribute shape are a CONTRACT with `../pmModel.ts`.
//      `wrapMark` reads `link` with `href` plus an optional `title`, because the
//      chassis serialises `[text](url "title")`. A preset that renames an
//      attribute or drops `title` does not throw — it falls through `wrapMark`'s
//      default branch, keeps the text and silently loses the URL on the next
//      markdown export.
//   2. `href` is a replicated, CRDT-merged string that every future reader of the
//      document hands to a browser. Scheme filtering is therefore a security
//      boundary, and a security boundary belongs in code a reviewer can read, not
//      in a transitive dependency's default option list that a minor bump can
//      widen.
//
// `Mark.create` and `markPasteRule` are the framework, not a preset — what we
// decline is somebody else's curated extension list, not `@tiptap/core`.
//
// ## Mentions ride on this mark
//
// `pmModel.ts` represents `@Alice` as a link with `href: 'mention:u1'` rather
// than a dedicated node, because `[@Alice](mention:u1)` is already the chassis's
// canonical markdown. `mention:` must therefore stay allowed: the scheme filter
// below is a DENY list precisely so internal schemes keep working without this
// file having to know about every one of them.
//
// That is also the concrete reason this file survives now that StarterKit is
// staying. StarterKit's `link` is not insecure — it runs its own scheme check —
// but that check is an ALLOW list (`http|https|ftp|ftps|mailto|tel|callto|sms|
// cid|xmpp`) with no way to name `mention:` except a `protocols` option every
// consumer must remember to pass. Measured, not assumed: StarterKit's
// `isAllowedUri('mention:user-123', [])` is `false`, so every mention in the
// document would render with `href=""` and every `setLink` on one would return
// `false`. Its link is also `inclusive` by default, which means typing after a
// link extends the URL — in a markdown-backed document that rewrites the file,
// not just the view. Both are silent, both are exactly the failure mode this
// codebase keeps re-learning, and both cost a config line a reviewer cannot see.
//
// ## Registering both is not an option — use `CANVAS_STARTER_KIT_OPTIONS`
//
// Tiptap does not error on a duplicate extension name; it warns and then MERGES
// the attribute sets while keeping only one node spec. Registering StarterKit
// alongside this mark really produces `{ href, target, rel, class, title }` —
// StarterKit's render-only attributes leak into the stored mark — and leaves
// StarterKit's autolink/click/paste plugins running against it, `mention:`
// rejection included. `schema-link-align.test.ts` pins that hybrid so it stays a
// demonstrated hazard rather than a claim.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanvasLink = exports.DANGEROUS_SCHEMES = exports.CANVAS_STARTER_KIT_OPTIONS = void 0;
exports.sanitizeHref = sanitizeHref;
exports.linkTagAttributes = linkTagAttributes;
exports.linkHrefFromPastedText = linkHrefFromPastedText;
const core_1 = require("@tiptap/core");
const state_1 = require("@tiptap/pm/state");
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
exports.CANVAS_STARTER_KIT_OPTIONS = { link: false };
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
exports.DANGEROUS_SCHEMES = ['javascript', 'data', 'vbscript'];
/**
 * Removes the characters a browser ignores when resolving a URL attribute.
 *
 * This is the whole trick. The HTML parser strips ASCII whitespace and C0/C1
 * control characters out of URL attributes before resolving them, so
 * `java<TAB>script:alert(1)` navigates exactly like `javascript:alert(1)` while
 * defeating any check written as `startsWith('javascript:')`. Comparing against
 * the same normal form the browser uses is what makes the filter honest rather
 * than decorative.
 */
function stripUrlNoise(value) {
    let out = '';
    for (const char of value) {
        const code = char.charCodeAt(0);
        const isControlOrSpace = code <= 0x20 || (code >= 0x7f && code <= 0x9f);
        if (!isControlOrSpace)
            out += char;
    }
    return out;
}
/**
 * The normalised scheme of `href`, or `null` when the URL is relative.
 *
 * A colon appearing after a `/`, `?` or `#` is not a scheme separator
 * (`/docs/a:b`, `?q=a:b`), so those stay relative and stay allowed.
 */
function schemeOf(href) {
    const colon = href.indexOf(':');
    if (colon === -1)
        return null;
    const candidate = href.slice(0, colon);
    if (/[/?#]/.test(candidate))
        return null;
    return stripUrlNoise(candidate).toLowerCase();
}
/**
 * The href to store and render, or `null` if it must be dropped.
 *
 * Called on parse, on `setLink` and again on render. The redundancy is
 * deliberate: a CRDT document can be written by an older client, by a merge, or
 * by a direct Y.Doc edit that never passed through a command, so the render path
 * cannot assume the stored value was ever checked.
 */
function sanitizeHref(raw) {
    if (typeof raw !== 'string')
        return null;
    const href = raw.trim();
    if (href === '')
        return null;
    const scheme = schemeOf(href);
    if (scheme !== null && exports.DANGEROUS_SCHEMES.includes(scheme))
        return null;
    return href;
}
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
function linkTagAttributes(attrs) {
    const href = sanitizeHref(attrs.href);
    const title = typeof attrs.title === 'string' && attrs.title !== '' ? attrs.title : null;
    return {
        ...(href ? { href } : {}),
        ...(title ? { title } : {}),
        rel: 'noopener noreferrer',
    };
}
// Autolink targets: an absolute http(s) URL or a mailto. Trailing sentence
// punctuation is excluded from the match so "see https://x.dev." does not swallow
// the full stop into the link.
const AUTOLINK_PASTE = /(?:https?:\/\/|mailto:)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g;
/**
 * The href to apply when pasting over a selection, or `null` to paste normally.
 *
 * Stricter than the autolink pattern on purpose: the clipboard has to hold one
 * bare URL and nothing else. Pasting a sentence that merely contains a URL over
 * selected text means "replace this text", not "link it".
 */
function linkHrefFromPastedText(text) {
    const candidate = text.trim();
    if (candidate === '' || /\s/.test(candidate))
        return null;
    if (!/^(?:https?:\/\/|mailto:)/i.test(candidate))
        return null;
    return sanitizeHref(candidate);
}
exports.CanvasLink = core_1.Mark.create({
    name: 'link',
    addOptions() {
        return { HTMLAttributes: {} };
    },
    // Typing immediately after a link must produce plain text. The default
    // (`inclusive: true`) leaves the mark on the caret at a link's right edge, so
    // continuing a sentence silently extends the URL's clickable range — and in a
    // markdown-backed document that is not a rendering quirk, it rewrites the file.
    inclusive: false,
    // A link around inline code has no stable markdown spelling and re-nests on
    // every round trip; `CodeMark` already declares `excludes: '_'` from its side.
    excludes: '_',
    addAttributes() {
        return {
            href: {
                default: null,
                // Sanitising on parse as well as on render keeps a hostile href out of the
                // STORED document, so it never reaches a consumer that reads the Y.Doc
                // directly instead of going through `renderHTML`.
                parseHTML: (element) => sanitizeHref(element.getAttribute('href')),
                rendered: false,
            },
            title: {
                default: null,
                parseHTML: (element) => element.getAttribute('title'),
                rendered: false,
            },
        };
    },
    parseHTML() {
        // `a[href]` only: a bare `<a name="x">` from imported HTML is a link TARGET,
        // not a link, and marking it would serialise as `[text]()`.
        return [{ tag: 'a[href]' }];
    },
    renderHTML({ HTMLAttributes, mark }) {
        return [
            'a',
            (0, core_1.mergeAttributes)(this.options.HTMLAttributes, HTMLAttributes, linkTagAttributes(mark.attrs)),
            0,
        ];
    },
    addCommands() {
        return {
            setLink: (attributes) => ({ commands }) => {
                const href = sanitizeHref(attributes.href);
                // Refusing rather than linking to nothing: a toolbar that gets `false`
                // back can tell the user the URL was rejected, whereas an `<a>` with no
                // href looks like it worked until somebody clicks it.
                if (!href)
                    return false;
                const title = typeof attributes.title === 'string' && attributes.title !== ''
                    ? attributes.title
                    : null;
                return commands.setMark(this.name, { href, title });
            },
            unsetLink: () => ({ commands }) => 
            // `extendEmptyMarkRange` lets an unset work from a caret inside the link
            // instead of demanding the user select the whole thing first, which is
            // what every editor's "remove link" button does.
            commands.unsetMark(this.name, { extendEmptyMarkRange: true }),
        };
    },
    addPasteRules() {
        return [
            (0, core_1.markPasteRule)({
                find: AUTOLINK_PASTE,
                type: this.type,
                getAttributes: (match) => {
                    const href = sanitizeHref(match[0]);
                    return href ? { href, title: null } : false;
                },
            }),
        ];
    },
    addProseMirrorPlugins() {
        const type = this.type;
        return [
            new state_1.Plugin({
                key: new state_1.PluginKey('canvasLinkPasteOverSelection'),
                props: {
                    // Paste rules cannot express this case. They run in an
                    // `appendTransaction` over the diff a paste has already produced, so by
                    // the time one fires the selected text is gone and only the pasted URL
                    // remains to mark. Linking the SELECTION means intercepting the paste
                    // before ProseMirror replaces it.
                    handlePaste: (view, event) => {
                        const { state } = view;
                        if (state.selection.empty)
                            return false;
                        const href = linkHrefFromPastedText(event.clipboardData?.getData('text/plain') ?? '');
                        if (!href)
                            return false;
                        const { from, to } = state.selection;
                        view.dispatch(state.tr.addMark(from, to, type.create({ href, title: null })));
                        return true;
                    },
                },
            }),
        ];
    },
});
//# sourceMappingURL=link.js.map