"use strict";
// realtime-modules/src/adapters/tiptap/canvas/pmModel.ts
//
// `DocModel` ⇄ ProseMirror JSON.
//
// The chassis owns the *format* (`DocModel`, markdown serialise/parse) and has
// no idea ProseMirror exists — that is the boundary rule, and it is why this
// file lives here rather than in `distributed-core`. This is the only place
// that knows both the chassis block schema and the Tiptap node names, and it is
// deliberately the ONLY place, so the mapping cannot drift into three copies.
//
// ## The three conversions and why they are separate
//
//   markdown ⇄ DocModel     chassis (`serializeDocument` / `parseDocument`)
//   DocModel ⇄ ProseMirror  this file
//   ProseMirror ⇄ Y.Doc     y-prosemirror (`useCanvasDocument`)
//
// Composing the first two gives markdown ⇄ editor, which is the round trip the
// operator actually asked for ("markdown native storage with high
// interoperability"). Keeping them separate is what makes each one testable
// without a browser.
//
// ## Inline text: a tree on one side, a flat run on the other
//
// `DocModel` nests inline nodes (`strong` *contains* `emphasis` contains
// `text`). ProseMirror flattens them (one text node carrying `[bold, italic]`).
// Converting one way is easy; converting back without producing `**a****b**`
// requires regrouping adjacent runs that share a mark. `groupByMark` below does
// that, and `MARK_ORDER` fixes a canonical outer→inner ordering so the two
// directions are exact inverses rather than merely similar.
Object.defineProperty(exports, "__esModule", { value: true });
exports.docModelToPm = docModelToPm;
exports.pmToDocModel = pmToDocModel;
const document_1 = require("distributed-core/applications/document");
const MacroNode_1 = require("./MacroNode");
const macroText_1 = require("./macroText");
const callout_1 = require("./schema/callout");
// `code` must be innermost: `inlineCode` is a LEAF in the chassis model, so any
// mark that survives alongside it has to wrap it. `link` is outermost because
// markdown cannot express a link inside emphasis inside the same run without
// re-nesting. Everything between is conventional.
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'];
const MENTION_SCHEME = 'mention:';
// ---------------------------------------------------------------------------
// DocModel → ProseMirror
// ---------------------------------------------------------------------------
function inlineToPm(nodes, unsupported) {
    const out = [];
    const walk = (list, marks) => {
        for (const node of list) {
            switch (node.type) {
                case 'text': {
                    if (node.value === '')
                        break;
                    out.push({ type: 'text', text: node.value, ...(marks.length ? { marks } : {}) });
                    break;
                }
                case 'strong':
                    walk(node.content, [...marks, { type: 'bold' }]);
                    break;
                case 'emphasis':
                    walk(node.content, [...marks, { type: 'italic' }]);
                    break;
                case 'strike':
                    walk(node.content, [...marks, { type: 'strike' }]);
                    break;
                case 'inlineCode':
                    if (node.value === '')
                        break;
                    out.push({ type: 'text', text: node.value, marks: [...marks, { type: 'code' }] });
                    break;
                case 'link':
                    walk(node.content, [
                        ...marks,
                        {
                            type: 'link',
                            attrs: { href: node.url, ...(node.title ? { title: node.title } : {}) },
                        },
                    ]);
                    break;
                case 'mention':
                    // Deliberately a link mark, not a `mention` node. `[@Alice](mention:u1)`
                    // is already the chassis's canonical serialisation, so representing it
                    // as a link is LOSSLESS in both directions and costs no extra Tiptap
                    // extension. A dedicated mention node would only add a way to drift.
                    out.push({
                        type: 'text',
                        text: `@${node.label}`,
                        marks: [...marks, { type: 'link', attrs: { href: `${MENTION_SCHEME}${node.id}` } }],
                    });
                    break;
                case 'break':
                    out.push({ type: 'hardBreak' });
                    break;
                case 'image':
                    unsupported.push({
                        kind: 'image',
                        reason: 'no Image node in the canvas schema; inline images are a Phase 5 import concern',
                    });
                    out.push({ type: 'text', text: node.alt || node.url, ...(marks.length ? { marks } : {}) });
                    break;
            }
        }
    };
    walk(nodes, []);
    return out;
}
/** Sorts inline marks into `MARK_ORDER` so regrouping is deterministic. */
function orderMarks(marks) {
    if (!marks || marks.length === 0)
        return [];
    const rank = (m) => {
        const i = MARK_ORDER.indexOf(m.type);
        return i === -1 ? MARK_ORDER.length : i;
    };
    return [...marks].sort((a, b) => rank(a) - rank(b));
}
/**
 * Splits a chassis list into runs of same-kind items.
 *
 * A GFM list may legitimately mix `- [ ] task` and `- bullet` items in one
 * list; ProseMirror's `taskList` and `bulletList` are different nodes and
 * cannot. Splitting into runs keeps the rendering honest, and `pmToDocModel`
 * merges adjacent same-`ordered` lists back into one block, which makes the two
 * directions exact inverses instead of nearly-inverses.
 */
function listRuns(items) {
    const runs = [];
    for (const item of items) {
        const task = item.checked !== null;
        const last = runs[runs.length - 1];
        if (last && last.task === task)
            last.items.push(item);
        else
            runs.push({ task, items: [item] });
    }
    return runs;
}
function degrade(block, kind, reason, unsupported) {
    unsupported.push({ kind, reason });
    return {
        type: 'codeBlock',
        attrs: { language: 'markdown' },
        content: [
            {
                type: 'text',
                text: (0, document_1.serializeDocument)({ frontMatter: {}, content: [block] }).trimEnd(),
            },
        ],
    };
}
function blockToPm(block, unsupported) {
    switch (block.type) {
        case 'heading': {
            const attrs = { level: block.level };
            if (block.id !== undefined)
                attrs.anchorId = block.id;
            const content = inlineToPm(block.content, unsupported);
            return { type: 'heading', attrs, ...(content.length ? { content } : {}) };
        }
        case 'paragraph': {
            const content = inlineToPm(block.content, unsupported);
            return { type: 'paragraph', ...(content.length ? { content } : {}) };
        }
        case 'code':
            return {
                type: 'codeBlock',
                attrs: { language: block.lang },
                ...(block.value === ''
                    ? {}
                    : { content: [{ type: 'text', text: block.value.replace(/\n$/, '') }] }),
            };
        case 'blockquote': {
            // A callout is stored as a blockquote whose FIRST child is a
            // `macro:callout` marker (see `schema/callout.ts` for why that shape and
            // not `:::info`). Recognising it here is what stops the panel from
            // evaporating: without this case the marker becomes a visible macro node
            // and the variant is only recoverable by reading YAML off screen.
            const [marker, ...body] = block.content;
            // `body.length > 0` on purpose. A marker with nothing after it has no
            // panel to draw, and turning it into a `callout` would force ProseMirror
            // to invent the empty paragraph its `block+` content demands — which
            // comes back as a paragraph the author never typed, breaking the fixed
            // point for a document that is already one today.
            if (marker !== undefined &&
                marker.type === 'macro' &&
                marker.name === callout_1.CALLOUT_MACRO_NAME &&
                body.length > 0) {
                return {
                    type: callout_1.CALLOUT_NODE_NAME,
                    attrs: { variant: (0, callout_1.normalizeCalloutVariant)(marker.data.variant) },
                    content: blocksToPm(body, unsupported),
                };
            }
            return {
                type: 'blockquote',
                content: blocksToPm(block.content, unsupported),
            };
        }
        case 'thematicBreak':
            return { type: 'horizontalRule' };
        case 'macro': {
            const text = (0, macroText_1.macroTextFromData)(block.name, block.data);
            return {
                type: MacroNode_1.MACRO_NODE_NAME,
                attrs: { macroName: block.name },
                ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
            };
        }
        case 'list':
            // Handled by `blocksToPm` so a multi-run list can emit several nodes.
            throw new Error('list must be expanded by blocksToPm');
        case 'table':
            return degrade(block, 'table', 'no Table node in the canvas schema; preserved verbatim as a markdown code block', unsupported);
        case 'html':
            return degrade(block, 'html', 'raw HTML from an imported file; preserved verbatim as a markdown code block', unsupported);
    }
}
function listToPm(ordered, start, items, unsupported) {
    return listRuns(items).map((run) => {
        if (run.task) {
            return {
                type: 'taskList',
                content: run.items.map((item) => ({
                    type: 'taskItem',
                    attrs: { checked: item.checked === true },
                    content: blocksToPm(item.content, unsupported),
                })),
            };
        }
        return {
            type: ordered ? 'orderedList' : 'bulletList',
            ...(ordered ? { attrs: { start } } : {}),
            content: run.items.map((item) => ({
                type: 'listItem',
                content: blocksToPm(item.content, unsupported),
            })),
        };
    });
}
function blocksToPm(blocks, unsupported) {
    const out = [];
    for (const block of blocks) {
        if (block.type === 'list') {
            out.push(...listToPm(block.ordered, block.start, block.items, unsupported));
        }
        else {
            out.push(blockToPm(block, unsupported));
        }
    }
    // ProseMirror's `doc` and every block container require at least one child in
    // practice — an empty list item or an empty blockquote is not representable.
    return out.length ? out : [{ type: 'paragraph' }];
}
/** Materialises a chassis document as a ProseMirror `doc` node. */
function docModelToPm(model) {
    const unsupported = [];
    return { doc: { type: 'doc', content: blocksToPm(model.content, unsupported) }, unsupported };
}
function sameMark(a, b) {
    if (a.type !== b.type)
        return false;
    return JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
}
/**
 * Wraps a run in the chassis inline node a ProseMirror mark corresponds to, or
 * returns `null` when the mark has no markdown form and the run should simply
 * be unwrapped.
 */
function wrapMark(mark, content) {
    switch (mark.type) {
        case 'bold':
            return { type: 'strong', content };
        case 'italic':
            return { type: 'emphasis', content };
        case 'strike':
            return { type: 'strike', content };
        case 'link': {
            const href = String(mark.attrs?.href ?? '');
            const title = mark.attrs?.title;
            if (href.startsWith(MENTION_SCHEME)) {
                const first = content[0];
                const label = first && first.type === 'text' ? first.value.replace(/^@/, '') : href.slice(MENTION_SCHEME.length);
                return { type: 'mention', id: href.slice(MENTION_SCHEME.length), label };
            }
            return {
                type: 'link',
                url: href,
                ...(typeof title === 'string' && title ? { title } : {}),
                content,
            };
        }
        default:
            // An unknown mark (underline, highlight, a suggestion mark) has no
            // markdown form. Unwrapping keeps the TEXT — dropping the run would lose
            // the user's words, which is never the right trade. Suggestion marks in
            // particular must not survive into an exported file: an export is the
            // accepted text, not the review state.
            return null;
    }
}
function groupByMark(items) {
    const out = [];
    let i = 0;
    while (i < items.length) {
        const head = items[i];
        if (head.marks.length === 0) {
            out.push(head.leaf);
            i += 1;
            continue;
        }
        const mark = head.marks[0];
        let j = i + 1;
        while (j < items.length && items[j].marks.length > 0 && sameMark(items[j].marks[0], mark))
            j += 1;
        const inner = groupByMark(items.slice(i, j).map((x) => ({ marks: x.marks.slice(1), leaf: x.leaf })));
        if (mark.type === 'code' && inner.length === 1 && inner[0].type === 'text') {
            out.push({ type: 'inlineCode', value: inner[0].value });
        }
        else if (mark.type === 'code') {
            out.push({ type: 'inlineCode', value: inner.map(plainText).join('') });
        }
        else {
            const wrapped = wrapMark(mark, inner);
            if (wrapped)
                out.push(wrapped);
            else
                out.push(...inner);
        }
        i = j;
    }
    return out;
}
function plainText(node) {
    switch (node.type) {
        case 'text':
            return node.value;
        case 'inlineCode':
            return node.value;
        case 'strong':
        case 'emphasis':
        case 'strike':
        case 'link':
            return node.content.map(plainText).join('');
        case 'mention':
            return `@${node.label}`;
        default:
            return '';
    }
}
function pmInlineToModel(nodes) {
    if (!nodes || nodes.length === 0)
        return [];
    const leaves = [];
    for (const node of nodes) {
        if (node.type === 'hardBreak') {
            leaves.push({ marks: [], leaf: { type: 'break' } });
            continue;
        }
        if (node.type !== 'text' || node.text === undefined)
            continue;
        leaves.push({ marks: orderMarks(node.marks), leaf: { type: 'text', value: node.text } });
    }
    return groupByMark(leaves);
}
function pmListItems(node) {
    const items = node.content ?? [];
    return items.map((item) => ({
        checked: item.type === 'taskItem' ? item.attrs?.checked === true : null,
        content: pmBlocksToModel(item.content),
    }));
}
function pmBlocksToModel(nodes) {
    const out = [];
    for (const node of nodes ?? []) {
        switch (node.type) {
            case 'heading': {
                const rawLevel = Number(node.attrs?.level ?? 1);
                const level = Math.min(6, Math.max(1, rawLevel));
                const anchor = node.attrs?.anchorId;
                out.push({
                    type: 'heading',
                    level,
                    ...(typeof anchor === 'string' && anchor ? { id: anchor } : {}),
                    content: pmInlineToModel(node.content),
                });
                break;
            }
            case 'paragraph':
                out.push({ type: 'paragraph', content: pmInlineToModel(node.content) });
                break;
            case 'codeBlock': {
                const lang = node.attrs?.language;
                const value = (node.content ?? []).map((c) => c.text ?? '').join('');
                out.push({
                    type: 'code',
                    lang: typeof lang === 'string' && lang ? lang : null,
                    value: value === '' ? '' : `${value}\n`,
                });
                break;
            }
            case 'blockquote':
                out.push({ type: 'blockquote', content: pmBlocksToModel(node.content) });
                break;
            case callout_1.CALLOUT_NODE_NAME:
                // The exact inverse of the `blockquote` case in `blockToPm`: re-emit
                // the marker leaf ahead of the body. `normalizeCalloutVariant` runs
                // again rather than trusting the attribute, because a CRDT merge or a
                // direct Y.Doc write can put an arbitrary string there and this is the
                // last point before it is written to a file.
                out.push({
                    type: 'blockquote',
                    content: [
                        {
                            type: 'macro',
                            name: callout_1.CALLOUT_MACRO_NAME,
                            data: { variant: (0, callout_1.normalizeCalloutVariant)(node.attrs?.variant) },
                        },
                        ...pmBlocksToModel(node.content),
                    ],
                });
                break;
            case 'horizontalRule':
                out.push({ type: 'thematicBreak' });
                break;
            case MacroNode_1.MACRO_NODE_NAME: {
                const name = String(node.attrs?.macroName ?? 'unknown');
                const text = (node.content ?? []).map((c) => c.text ?? '').join('');
                const data = (0, macroText_1.macroDataFromText)(name, text);
                // A macro whose YAML no longer parses (a CRDT merge of two concurrent
                // rewrites can do this) is exported as a plain fenced block rather than
                // dropped, so the user's bytes survive to be fixed by hand.
                out.push(data
                    ? { type: 'macro', name, data }
                    : { type: 'code', lang: `macro:${name}`, value: text === '' ? '' : `${text}\n` });
                break;
            }
            case 'bulletList':
            case 'orderedList':
            case 'taskList': {
                const ordered = node.type === 'orderedList';
                const start = ordered ? Number(node.attrs?.start ?? 1) : 1;
                const items = pmListItems(node);
                // Merge into the previous list when it is the same kind. This is the
                // inverse of `listRuns` splitting a mixed list into task/bullet runs;
                // without it, a mixed list would come back as two lists and the
                // markdown round trip would not be a fixed point.
                const prev = out[out.length - 1];
                if (prev && prev.type === 'list' && prev.ordered === ordered) {
                    prev.items.push(...items);
                }
                else {
                    out.push({ type: 'list', ordered, start, items });
                }
                break;
            }
            default:
                // Unknown node type — keep its text rather than dropping the content.
                if (node.content)
                    out.push(...pmBlocksToModel(node.content));
                break;
        }
    }
    return out;
}
/** Reads a ProseMirror `doc` node back into the chassis document model. */
function pmToDocModel(doc, frontMatter = {}) {
    return { frontMatter, content: pmBlocksToModel(doc.content) };
}
//# sourceMappingURL=pmModel.js.map