// realtime-modules/test/adapters/canvas-plain-range.test.ts
//
// `plainRangeFromPm` is the write half of the anchor story: without it a user
// can select words but nothing can turn that selection into an anchor.
//
// The bug it exists to prevent is an off-by-N, and an off-by-N is invisible in
// paragraph one — ProseMirror's position space and the plain-text space differ
// by exactly 1 there, so a lazily written `from - 1` passes every test that
// only ever looks at the first sentence. It goes wrong by 2 more at every
// block boundary. So every case below reaches into the SECOND or THIRD block,
// and every assertion is written against the resolved TEXT rather than against
// a number: a number test passes just as happily when the conversion and the
// expectation drifted together.

import { Schema, type Node as PmNode } from '@tiptap/pm/model';
import { plainRangeFromPm, pmRangesFromPlain } from '../../src/adapters/tiptap/canvas';

/**
 * The smallest schema that can express the shape under test: blocks that carry
 * text, and one inline atom that carries none.
 *
 * `image` is not decoration. It is the case where the two number lines move at
 * different rates WITHIN a block — an inline atom is one ProseMirror position
 * and zero characters — so it is the one thing a per-block constant offset
 * could never model.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    image: { group: 'inline', inline: true, atom: true },
    text: { group: 'inline' },
  },
});

const P1 = 'The cache expired for every key at once.';
const P2 = 'The origin took the full read volume for ninety seconds.';
const P3 = 'Nothing paged, because the dashboards average over five minutes.';

function paragraphs(...texts: string[]): PmNode {
  return schema.node(
    'doc',
    null,
    texts.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])),
  );
}

/** The plain-text space the anchors live in: every text run, concatenated. */
function plainTextOf(doc: PmNode): string {
  let out = '';
  doc.descendants((node) => {
    if (node.isText) {
      out += node.text ?? '';
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The whole point, in one helper: take a ProseMirror range, convert it, and
 * read what the converted range actually covers.
 */
function textForPmRange(doc: PmNode, from: number, to: number): string | null {
  const range = plainRangeFromPm(doc, from, to);
  if (!range) return null;
  return plainTextOf(doc).slice(range.from, range.to);
}

/** Where `needle` sits in ProseMirror positions, found rather than hand-counted. */
function pmRangeOf(doc: PmNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText || found) return !found;
    const index = (node.text ?? '').indexOf(needle);
    if (index >= 0) found = { from: pos + index, to: pos + index + needle.length };
    return false;
  });
  if (!found) throw new Error(`no text node contains ${JSON.stringify(needle)}`);
  return found;
}

describe('plainRangeFromPm', () => {
  it('converts a selection in the FIRST block', () => {
    const doc = paragraphs(P1, P2);
    const pm = pmRangeOf(doc, 'cache');
    expect(textForPmRange(doc, pm.from, pm.to)).toBe('cache');
  });

  it('converts a selection in a LATER block, where a constant offset breaks', () => {
    const doc = paragraphs(P1, P2, P3);
    const pm = pmRangeOf(doc, 'ninety seconds');
    expect(textForPmRange(doc, pm.from, pm.to)).toBe('ninety seconds');

    // The naive conversion, shown failing, so the test says WHY it exists: by
    // the third block the two number lines are four apart, and `from - 1`
    // lands on someone else's words rather than on nothing.
    const plain = plainTextOf(doc);
    expect(plain.slice(pm.from - 1, pm.to - 1)).not.toBe('ninety seconds');
  });

  it('is unaffected by how many blocks precede the selection', () => {
    // Same sentence, once with two blocks in front of it and once with none.
    // If the conversion carried any per-document constant, these would differ.
    const near = paragraphs(P3);
    const far = paragraphs(P1, P2, P3);
    const nearPm = pmRangeOf(near, 'dashboards');
    const farPm = pmRangeOf(far, 'dashboards');
    expect(textForPmRange(near, nearPm.from, nearPm.to)).toBe('dashboards');
    expect(textForPmRange(far, farPm.from, farPm.to)).toBe('dashboards');
  });

  it('spans a block boundary as ONE contiguous plain range', () => {
    // A paragraph break contributes no characters, so selecting the tail of
    // one paragraph and the head of the next yields the two pieces with
    // nothing between them — not a gap the size of the boundary.
    const doc = paragraphs(P1, P2);
    const start = pmRangeOf(doc, 'at once.');
    const end = pmRangeOf(doc, 'The origin');
    expect(textForPmRange(doc, start.from, end.to)).toBe('at once.The origin');
  });

  it('counts an inline atom as zero characters', () => {
    // The image is one ProseMirror position and no text. A selection that
    // steps over it must not shift by one.
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(P1)]),
      schema.node('paragraph', null, [
        schema.text('before '),
        schema.node('image'),
        schema.text(' after'),
      ]),
    ]);
    const pm = pmRangeOf(doc, 'after');
    expect(textForPmRange(doc, pm.from, pm.to)).toBe('after');
  });

  it('ignores block types — a heading is text like any other', () => {
    const doc = schema.node('doc', null, [
      schema.node('heading', null, [schema.text('Blast radius')]),
      schema.node('paragraph', null, [schema.text(P2)]),
    ]);
    const pm = pmRangeOf(doc, 'full read volume');
    expect(textForPmRange(doc, pm.from, pm.to)).toBe('full read volume');
  });

  it('returns null for a caret — there is nothing to comment ON', () => {
    const doc = paragraphs(P1, P2);
    const pm = pmRangeOf(doc, 'cache');
    expect(plainRangeFromPm(doc, pm.from, pm.from)).toBeNull();
    expect(plainRangeFromPm(doc, pm.to, pm.from)).toBeNull();
  });

  it('round-trips through pmRangesFromPlain — the two directions agree', () => {
    // The property that actually matters. The gutter converts one way to place
    // a card and the highlight converts the other way to paint a span; if the
    // two disagreed by even one character they would point at different words,
    // and the reader would be told the comment is about the wrong sentence.
    const doc = paragraphs(P1, P2, P3);
    for (const needle of ['cache', 'ninety seconds', 'dashboards', 'average over five']) {
      const pm = pmRangeOf(doc, needle);
      const plain = plainRangeFromPm(doc, pm.from, pm.to);
      expect(plain).not.toBeNull();
      const back = pmRangesFromPlain(doc, plain!.from, plain!.to);
      expect(back).toEqual([{ from: pm.from, to: pm.to }]);
    }
  });

  it('returns SEVERAL pm ranges for an anchor spanning a block boundary', () => {
    // The paragraph break is not text, so it must not be painted — one range
    // per text node the anchor touches.
    const doc = paragraphs(P1, P2);
    const start = pmRangeOf(doc, 'at once.');
    const end = pmRangeOf(doc, 'The origin');
    const plain = plainRangeFromPm(doc, start.from, end.to)!;
    const back = pmRangesFromPlain(doc, plain.from, plain.to);
    expect(back).toEqual([
      { from: start.from, to: start.to },
      { from: end.from, to: end.to },
    ]);
  });

  it('returns null for a range that covers no text', () => {
    // The gap between two paragraphs: two ProseMirror positions wide, zero
    // characters. A comment here would have nothing to point at, and the
    // caller needs to hear that rather than store an empty anchor.
    const doc = paragraphs(P1, '', P2);
    const emptyParagraphStart = P1.length + 2;
    expect(plainRangeFromPm(doc, emptyParagraphStart, emptyParagraphStart + 2)).toBeNull();
  });
});
