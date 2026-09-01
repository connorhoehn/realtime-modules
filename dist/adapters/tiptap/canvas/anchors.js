"use strict";
// realtime-modules/src/adapters/tiptap/canvas/anchors.ts
//
// Comment anchors that survive editing.
//
// The gutter needs to know WHERE a comment lives, and the legacy answer —
// `sectionId` — died with sections. The two obvious replacements are both
// wrong in the same way:
//
//   • a pixel offset  → stale the moment a font loads or a window resizes
//   • a character index → stale the moment anyone types above the comment,
//     and it fails SILENTLY: the comment does not disappear, it points at
//     someone else's sentence.
//
// Y.js already solves this. A `RelativePosition` names a position by the ID of
// the character it sits beside, not by counting from the start of the document.
// Insert ten paragraphs above it and the ID does not move; the absolute index
// you get back when you resolve it does. That is the entire feature, and it is
// why this could not be done before the document became a CRDT.
//
// ## What a caller stores
//
// One `CanvasAnchor` per comment, as an ordinary JSON object beside the
// comment row. Y.js encodes a relative position to a `Uint8Array`, which JSON
// does not survive (`JSON.parse(JSON.stringify(new Uint8Array([1])))` is
// `{"0":1}`, an object, not bytes), so both endpoints are base64 strings here.
// Base64 rather than a number array because this sits in a DynamoDB item next
// to the comment body and a 40-byte position should cost ~56 bytes, not ~200.
//
// ## The offset space
//
// `from`/`to` are offsets into the document's PLAIN TEXT — every text run in
// the body fragment concatenated in document order, block boundaries
// contributing nothing, each embed counting as one character (so an offset
// here is always a valid Y.js index inside exactly one text run). This is
// deliberately NOT the ProseMirror position space: ProseMirror positions count
// node boundaries, and reproducing that count requires a live editor and its
// schema. The gutter does not have one at persistence time, and an anchor that
// can only be created while an editor is mounted is an anchor a server-side
// migration or an AI proposal cannot make.
//
// ## Orphans are a real state
//
// `resolveAnchor` returns `null` when the anchored text is gone. It does not
// throw, and it emphatically does not return `0`: a `0` would pin every
// orphaned comment to the top of the document, which reads as a confident
// answer and is the worst available lie. `null` is the UI's cue to render the
// thread as orphaned — `anchor.quote` is kept precisely so it can still show
// what the comment used to be about.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANVAS_ANCHOR_VERSION = void 0;
exports.canvasPlainText = canvasPlainText;
exports.createAnchor = createAnchor;
exports.isCanvasAnchor = isCanvasAnchor;
exports.resolveAnchor = resolveAnchor;
exports.anchorText = anchorText;
const Y = __importStar(require("yjs"));
/**
 * Bumped when the encoding changes. `resolveAnchor` refuses versions it does
 * not understand rather than decoding them wrong — persisted anchors outlive
 * the code that wrote them.
 */
exports.CANVAS_ANCHOR_VERSION = 1;
// --------------------------------------------------------------------------
// base64
//
// Hand-rolled rather than `Buffer` (absent in the browser, and this runs in
// the editor) or `btoa` (absent in Node's older globals, and byte-vs-char
// confusing). Anchors are ~40 bytes; the loop cost is irrelevant.
// --------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
    let out = '';
    const n = bytes.length;
    for (let i = 0; i < n; i += 3) {
        const rest = n - i;
        const b0 = bytes[i];
        const b1 = rest > 1 ? bytes[i + 1] : 0;
        const b2 = rest > 2 ? bytes[i + 2] : 0;
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | (b1 >> 4)];
        out += rest > 1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += rest > 2 ? B64[b2 & 63] : '=';
    }
    return out;
}
function base64ToBytes(value) {
    const out = new Uint8Array((value.length * 3) >> 2);
    let written = 0;
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '=')
            break;
        const v = B64.indexOf(ch);
        if (v < 0)
            throw new Error(`not base64: ${JSON.stringify(ch)}`);
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[written++] = (acc >> bits) & 0xff;
        }
    }
    // `slice`, not `subarray`: a view keeps the oversized parent buffer alive and
    // some decoders read `.buffer` rather than the view.
    return out.slice(0, written);
}
/**
 * Every text run in the fragment, in document order, with its offset.
 *
 * Recomputed on every call rather than cached: the fragment is a live CRDT
 * that a remote peer can rewrite between two statements, and a cache keyed on
 * anything cheaper than "the current state" is a stale-anchor bug waiting to
 * happen.
 */
function textRuns(fragment) {
    const runs = [];
    let offset = 0;
    const walk = (node) => {
        // XmlText first: `Y.XmlElement` extends `Y.XmlFragment`, and `Y.XmlText`
        // is a Text, so the fragment branch below covers elements and the root.
        if (node instanceof Y.XmlText) {
            runs.push({ text: node, start: offset, length: node.length });
            offset += node.length;
            return;
        }
        if (node instanceof Y.XmlFragment) {
            for (const child of node.toArray())
                walk(child);
        }
        // Anything else (a Y.XmlHook, a bare embed) holds no addressable text.
    };
    walk(fragment);
    return runs;
}
/** U+FFFC OBJECT REPLACEMENT CHARACTER, written as an escape so no editor eats it. */
const EMBED_PLACEHOLDER = String.fromCharCode(0xfffc);
function runText(text) {
    let out = '';
    for (const op of text.toDelta()) {
        // An embed is one Y.js index unit, so it must be one character here or
        // every offset after it is wrong. U+FFFC is the Unicode object replacement
        // character — the standard stand-in for "a thing that is not text".
        out += typeof op.insert === 'string' ? op.insert : EMBED_PLACEHOLDER;
    }
    return out;
}
/**
 * The document's plain text — the offset space `from`/`to` live in.
 *
 * Exported because a caller creating an anchor needs to find the offsets of
 * the span the user selected, and because it makes an anchor's meaning
 * checkable: `canvasPlainText(doc, key).slice(from, to)` is the comment's text.
 */
function canvasPlainText(ydoc, fragmentKey) {
    return textRuns(ydoc.getXmlFragment(fragmentKey)).map((run) => runText(run.text)).join('');
}
// --------------------------------------------------------------------------
// Create / resolve
// --------------------------------------------------------------------------
/**
 * Anchors a range of the document.
 *
 * `from`/`to` are plain-text offsets (see `canvasPlainText`), half-open, and
 * must be non-empty — a comment refers to a span of text, and a collapsed
 * range cannot be told apart from an orphan once the document has moved on.
 * Invalid input throws, because a caller that computed a bad offset wants to
 * know now rather than store an anchor that resolves to nothing forever.
 *
 * Association is chosen so the range does not swallow adjacent typing: the
 * start binds to its first character and the end binds to its last, so text
 * typed immediately before or after the comment stays outside it, while text
 * typed inside it extends it.
 */
function createAnchor(ydoc, fragmentKey, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new RangeError(`anchor offsets must be integers, got ${from}..${to}`);
    }
    if (to <= from) {
        throw new RangeError(`anchor must cover a non-empty range, got ${from}..${to}`);
    }
    const runs = textRuns(ydoc.getXmlFragment(fragmentKey));
    const total = runs.reduce((sum, run) => sum + run.length, 0);
    if (from < 0 || to > total) {
        throw new RangeError(`anchor ${from}..${to} is outside the document (length ${total})`);
    }
    // The start sits before the character at `from`; the end sits after the
    // character at `to - 1`. Picking runs that way also skips empty runs, which
    // would otherwise be an ambiguous home for a boundary offset.
    const startRun = runs.find((run) => from >= run.start && from < run.start + run.length);
    const endRun = runs.find((run) => to > run.start && to <= run.start + run.length);
    if (!startRun || !endRun) {
        throw new RangeError(`anchor ${from}..${to} does not land inside any text run`);
    }
    const start = Y.createRelativePositionFromTypeIndex(startRun.text, from - startRun.start, 1);
    const end = Y.createRelativePositionFromTypeIndex(endRun.text, to - endRun.start, -1);
    return {
        v: exports.CANVAS_ANCHOR_VERSION,
        key: fragmentKey,
        start: bytesToBase64(Y.encodeRelativePosition(start)),
        end: bytesToBase64(Y.encodeRelativePosition(end)),
        quote: canvasPlainText(ydoc, fragmentKey).slice(from, to),
    };
}
/** Cheap shape check for an anchor that came back out of storage. */
function isCanvasAnchor(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const a = value;
    return (typeof a.v === 'number' &&
        typeof a.key === 'string' &&
        typeof a.start === 'string' &&
        typeof a.end === 'string' &&
        typeof a.quote === 'string');
}
/** Where a resolved endpoint landed in the plain-text space, or null. */
function offsetOf(runs, type, index) {
    for (const run of runs) {
        if (run.text === type) {
            return run.start + Math.min(index, run.length);
        }
    }
    // The text run is no longer part of this fragment — its whole block was
    // deleted, or the anchor was written against a different root.
    return null;
}
/**
 * Resolves an anchor against the CURRENT state of the document.
 *
 * Returns `null` — never a throw, never a `0` — when the anchor cannot be
 * placed. That covers four genuinely different orphan stories, all of which
 * the gutter renders the same way:
 *
 *   • the anchored characters were deleted (the range collapses to a point)
 *   • the whole block holding them was deleted
 *   • this `Y.Doc` has not received the update that created the anchored text
 *   • the stored anchor is malformed or from a future encoding version
 */
function resolveAnchor(ydoc, anchor) {
    if (!isCanvasAnchor(anchor) || anchor.v !== exports.CANVAS_ANCHOR_VERSION)
        return null;
    let startRel;
    let endRel;
    try {
        startRel = Y.decodeRelativePosition(base64ToBytes(anchor.start));
        endRel = Y.decodeRelativePosition(base64ToBytes(anchor.end));
    }
    catch {
        return null;
    }
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc);
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc);
    if (!startAbs || !endAbs)
        return null;
    const runs = textRuns(ydoc.getXmlFragment(anchor.key));
    const from = offsetOf(runs, startAbs.type, startAbs.index);
    const to = offsetOf(runs, endAbs.type, endAbs.index);
    if (from === null || to === null)
        return null;
    // Both endpoints resolved, but they have collapsed onto each other: Y.js
    // reports a deleted character's position as the gap it left behind, so an
    // empty range here means the anchored text is gone. Orphan, not position 0.
    if (to <= from)
        return null;
    return { from, to };
}
/**
 * The text an anchor currently covers, or `null` if it is orphaned.
 *
 * The honest way to check an anchor, and the one the gutter wants when it
 * renders a thread's quoted context: it reads what the anchor points at NOW
 * rather than trusting `anchor.quote`, which is a snapshot of creation time.
 */
function anchorText(ydoc, anchor) {
    const range = resolveAnchor(ydoc, anchor);
    if (!range)
        return null;
    return canvasPlainText(ydoc, anchor.key).slice(range.from, range.to);
}
//# sourceMappingURL=anchors.js.map