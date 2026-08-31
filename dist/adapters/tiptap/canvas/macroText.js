"use strict";
// realtime-modules/src/adapters/tiptap/canvas/macroText.ts
//
// The bridge between a macro's *editor* representation and its *data*.
//
// ## Why a macro's editor content is literal YAML text
//
// A macro node in ProseMirror is a **textblock** — like `code_block` — whose
// single text child is exactly the YAML body that markdown serialisation would
// emit. It is NOT an atom carrying its payload in node attributes.
//
// That choice is load-bearing and it buys two things:
//
//  1. **Block-level suggestions work with no new machinery.** Deleting a macro
//     is deleting the text inside a textblock, which the suggestion fork
//     already handles: the `ReplaceStep` gets wrapped in `suggestionDelete`
//     marks on the text, `listSuggestions` walks `doc.descendants` and finds
//     them, and the review panel renders them. An atom node would have needed
//     node marks (`AddNodeMarkStep`), a decision the schema does not have to
//     make.
//
//  2. **The markdown round trip is exact by construction.** The bytes between
//     the fences in the exported file are the bytes in the editor. There is no
//     second serialiser to keep in sync with `distributed-core`'s.
//
// The cost is that two clients editing the same field concurrently merge as
// *text* rather than last-write-wins. `replaceRange` below keeps that damage
// small by rewriting only the characters that actually changed, and
// `macroDataFromText` returns `null` rather than throwing when a merge does
// produce invalid YAML — the node view then falls back to showing the raw
// source so the user can fix it. Nothing is ever silently dropped.
Object.defineProperty(exports, "__esModule", { value: true });
exports.macroTextFromData = macroTextFromData;
exports.macroDataFromText = macroDataFromText;
exports.minimalEdit = minimalEdit;
const document_1 = require("distributed-core/applications/document");
/**
 * Longest run of backticks at line-start decides the fence width, mirroring
 * `fenceFor` in the chassis serializer. Kept in step by construction: both
 * sides of this file route through `serializeDocument`/`parseBlocks`, so the
 * fence only has to be *wide enough*, never identical.
 */
function fenceFor(content) {
    const runs = content.match(/^`{3,}/gm) ?? [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
}
/**
 * The YAML body for a macro payload — byte-identical to what
 * `serializeDocument` writes between the fences.
 *
 * Deliberately implemented by *calling* the chassis serializer and slicing the
 * fences off, rather than re-dumping the YAML here with a second copy of the
 * dump options (`sortKeys`, `lineWidth: -1`, `noRefs`, `noCompatMode`). A
 * second copy is a drift bug waiting to happen: the day the chassis changes an
 * option, every macro in every open editor would start disagreeing with its own
 * exported file. This cannot drift.
 *
 * Returns text WITHOUT a trailing newline, because a ProseMirror textblock's
 * content is the body and the closing fence supplies the final break.
 */
function macroTextFromData(name, data) {
    const md = (0, document_1.serializeDocument)({
        frontMatter: {},
        content: [{ type: 'macro', name, data }],
    });
    const lines = md.split('\n');
    // First line is the opening fence + info string; last non-empty line is the
    // closing fence; `split` leaves a trailing '' from the final newline.
    const body = lines.slice(1, -2);
    return body.join('\n');
}
/**
 * The payload a macro's editor text currently represents, or `null` when the
 * text is not valid YAML.
 *
 * `null` is a real state, not an error path: a CRDT merge of two concurrent
 * rewrites can produce text that no longer parses, and the honest response is
 * to show the user the source rather than to invent a payload or to throw
 * inside a React render.
 */
function macroDataFromText(name, text) {
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    const fence = fenceFor(body);
    try {
        const blocks = (0, document_1.parseBlocks)(`${fence}macro:${name}\n${body}${fence}\n`);
        const first = blocks[0];
        if (!first || first.type !== 'macro')
            return null;
        return first.data;
    }
    catch {
        return null;
    }
}
/**
 * The smallest single-range edit that turns `before` into `after`.
 *
 * Toggling an action item's status rewrites the whole YAML body in principle,
 * but the only characters that differ are `pending` → `done`. Dispatching the
 * whole-body replacement would make two clients toggling different fields at
 * the same moment collide on every byte; dispatching the minimal range lets
 * Y.js merge them the way it merges any two edits to different parts of a
 * paragraph — cleanly.
 *
 * Returns `null` when the texts are identical, so callers can skip the
 * transaction entirely rather than dirtying the document.
 */
function minimalEdit(before, after) {
    if (before === after)
        return null;
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before[start] === after[start])
        start += 1;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start &&
        endAfter > start &&
        before[endBefore - 1] === after[endAfter - 1]) {
        endBefore -= 1;
        endAfter -= 1;
    }
    return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}
//# sourceMappingURL=macroText.js.map