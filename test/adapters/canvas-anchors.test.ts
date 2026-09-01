// realtime-modules/test/adapters/canvas-anchors.test.ts
//
// The property under test is not "the numbers are right" — it is "the comment
// still points at the same sentence". So every assertion that could be written
// against an offset is written against the RESOLVED TEXT instead. An offset
// test passes just as happily when the anchor and the document have drifted
// together into the wrong place; a text test does not.
//
// Real `Y.Doc`s throughout. A mock of `createAbsolutePositionFromRelativePosition`
// would be a mock of the only thing that makes this feature work.

import * as Y from 'yjs';
import {
  CANVAS_ANCHOR_VERSION,
  anchorText,
  canvasPlainText,
  createAnchor,
  isCanvasAnchor,
  resolveAnchor,
  type CanvasAnchor,
} from '../../src/adapters/tiptap/canvas/anchors';

/** Matches `CANVAS_BODY_KEY` in `useCanvasDocument`; not imported — that module is a React hook. */
const BODY = 'body';

const PARA_1 = 'The cache expired for every key at once.';
const PARA_2 = 'The origin took the full read volume for ninety seconds.';

interface Fixture {
  doc: Y.Doc;
  body: Y.XmlFragment;
  /** The `Y.XmlText` inside each paragraph, so a test can edit it directly. */
  texts: Y.XmlText[];
}

/** A two-paragraph canvas body, built the way `prosemirrorJSONToYXmlFragment` builds one. */
function makeDoc(paragraphs: string[] = [PARA_1, PARA_2]): Fixture {
  const doc = new Y.Doc();
  const body = doc.getXmlFragment(BODY);
  const texts: Y.XmlText[] = [];
  doc.transact(() => {
    for (const content of paragraphs) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, content);
      p.insert(0, [t]);
      body.push([p]);
      texts.push(t);
    }
  });
  return { doc, body, texts };
}

function addParagraph(fixture: Fixture, content: string, at: number): void {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, content);
  p.insert(0, [t]);
  fixture.body.insert(at, [p]);
}

/** Anchors the first occurrence of `phrase` in the document's plain text. */
function anchorPhrase(doc: Y.Doc, phrase: string): CanvasAnchor {
  const from = canvasPlainText(doc, BODY).indexOf(phrase);
  expect(from).toBeGreaterThanOrEqual(0);
  return createAnchor(doc, BODY, from, from + phrase.length);
}

describe('canvas comment anchors', () => {
  describe('the plain-text offset space', () => {
    it('concatenates every paragraph, so an offset spans the whole page', () => {
      const { doc } = makeDoc();
      expect(canvasPlainText(doc, BODY)).toBe(PARA_1 + PARA_2);
    });

    it('round-trips an anchor to the exact text it was made from', () => {
      const { doc } = makeDoc();
      const anchor = anchorPhrase(doc, 'every key');
      expect(anchor.quote).toBe('every key');
      expect(anchorText(doc, anchor)).toBe('every key');
    });

    it('refuses a collapsed range — a comment is about a span, not a point', () => {
      const { doc } = makeDoc();
      expect(() => createAnchor(doc, BODY, 4, 4)).toThrow(/non-empty/);
    });

    it('refuses a range that runs off the end of the document', () => {
      const { doc } = makeDoc();
      const total = canvasPlainText(doc, BODY).length;
      expect(() => createAnchor(doc, BODY, 0, total + 1)).toThrow(/outside the document/);
    });
  });

  describe('surviving edits', () => {
    // The core property. A stale character index fails exactly here.
    it('still resolves to the same text after a paragraph is inserted ABOVE it', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const before = resolveAnchor(fixture.doc, anchor);

      addParagraph(fixture, 'A collaborator typed this whole paragraph above you.', 0);

      expect(anchorText(fixture.doc, anchor)).toBe('every key');
      // And it genuinely MOVED — otherwise the assertion above would pass for
      // a broken implementation that happened to be measuring nothing.
      const after = resolveAnchor(fixture.doc, anchor);
      expect(after!.from).toBeGreaterThan(before!.from);
    });

    it('still resolves to the same text after typing inside the same paragraph, above it', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const before = resolveAnchor(fixture.doc, anchor)!;

      fixture.texts[0].insert(0, 'Under load, ');

      expect(anchorText(fixture.doc, anchor)).toBe('every key');
      expect(resolveAnchor(fixture.doc, anchor)!.from).toBe(before.from + 'Under load, '.length);
    });

    it('still resolves to the same text after content is inserted BELOW it', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const before = resolveAnchor(fixture.doc, anchor)!;

      addParagraph(fixture, 'A postscript nobody asked for.', fixture.body.length);
      fixture.texts[1].insert(fixture.texts[1].length, ' Roughly.');

      expect(anchorText(fixture.doc, anchor)).toBe('every key');
      expect(resolveAnchor(fixture.doc, anchor)).toEqual(before);
    });

    it('does not swallow text typed immediately before or after the range', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const { from, to } = resolveAnchor(fixture.doc, anchor)!;

      fixture.doc.transact(() => {
        fixture.texts[0].insert(to, '!!');
        fixture.texts[0].insert(from, '**');
      });

      expect(anchorText(fixture.doc, anchor)).toBe('every key');
    });

    it('grows when text is typed INSIDE the range', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const { from } = resolveAnchor(fixture.doc, anchor)!;

      fixture.texts[0].insert(from + 'every'.length, ' single');

      expect(anchorText(fixture.doc, anchor)).toBe('every single key');
    });

    it('survives a delete elsewhere in the document', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');

      fixture.texts[1].delete(0, 'The origin '.length);

      expect(anchorText(fixture.doc, anchor)).toBe('every key');
    });

    it('shrinks, but stays alive, when only part of the range is deleted', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const { from } = resolveAnchor(fixture.doc, anchor)!;

      fixture.texts[0].delete(from, 'every '.length);

      expect(anchorText(fixture.doc, anchor)).toBe('key');
    });
  });

  describe('orphans', () => {
    it('resolves to null once the anchored text is deleted', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');
      const { from, to } = resolveAnchor(fixture.doc, anchor)!;

      fixture.texts[0].delete(from, to - from);

      // null, and specifically NOT 0 — a 0 would park the thread at the top of
      // the gutter and read as a real position.
      expect(resolveAnchor(fixture.doc, anchor)).toBeNull();
      expect(anchorText(fixture.doc, anchor)).toBeNull();
      // The thread can still say what it was about.
      expect(anchor.quote).toBe('every key');
    });

    it('resolves to null when the whole block holding the text is deleted', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');

      fixture.body.delete(0, 1);

      expect(resolveAnchor(fixture.doc, anchor)).toBeNull();
    });

    it('resolves to null in a document that has never seen the anchored text', () => {
      const { doc } = makeDoc();
      const anchor = anchorPhrase(doc, 'every key');

      expect(resolveAnchor(new Y.Doc(), anchor)).toBeNull();
    });

    it('resolves to null for a malformed or future-version anchor, without throwing', () => {
      const { doc } = makeDoc();
      const anchor = anchorPhrase(doc, 'every key');

      expect(resolveAnchor(doc, { ...anchor, v: CANVAS_ANCHOR_VERSION + 1 })).toBeNull();
      expect(resolveAnchor(doc, { ...anchor, start: 'not base64 at all' })).toBeNull();
      expect(resolveAnchor(doc, {} as CanvasAnchor)).toBeNull();
      expect(resolveAnchor(doc, null as unknown as CanvasAnchor)).toBeNull();
    });

    it('resolves to null when the anchor names a fragment it does not live in', () => {
      const { doc } = makeDoc();
      const anchor = anchorPhrase(doc, 'every key');

      expect(resolveAnchor(doc, { ...anchor, key: 'some-other-root' })).toBeNull();
    });
  });

  describe('persistence', () => {
    it('survives a JSON round trip', () => {
      const { doc } = makeDoc();
      const anchor = anchorPhrase(doc, 'every key');

      const stored = JSON.parse(JSON.stringify(anchor)) as CanvasAnchor;

      // Uint8Array would have become `{"0":1,"1":2,...}` here. Base64 does not.
      expect(typeof stored.start).toBe('string');
      expect(typeof stored.end).toBe('string');
      expect(stored).toEqual(anchor);
      expect(isCanvasAnchor(stored)).toBe(true);
      expect(anchorText(doc, stored)).toBe('every key');
    });

    it('survives a JSON round trip AND a subsequent edit', () => {
      const fixture = makeDoc();
      const stored = JSON.parse(JSON.stringify(anchorPhrase(fixture.doc, 'every key'))) as CanvasAnchor;

      addParagraph(fixture, 'Written after the anchor was stored.', 0);

      expect(anchorText(fixture.doc, stored)).toBe('every key');
    });
  });

  describe('collaboration', () => {
    it('resolves in a SECOND doc synced from the first', () => {
      const fixture = makeDoc();
      const anchor = anchorPhrase(fixture.doc, 'every key');

      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(fixture.doc));

      expect(canvasPlainText(peer, BODY)).toBe(canvasPlainText(fixture.doc, BODY));
      expect(anchorText(peer, anchor)).toBe('every key');
      expect(resolveAnchor(peer, anchor)).toEqual(resolveAnchor(fixture.doc, anchor));
    });

    it('tracks an edit made by the peer, in both docs, after sync back', () => {
      const author = makeDoc();
      const anchor = anchorPhrase(author.doc, 'every key');

      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(author.doc));

      // The peer types a whole paragraph above the comment and syncs back.
      const peerBody = peer.getXmlFragment(BODY);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'The peer wrote this first, above everything.');
      p.insert(0, [t]);
      peerBody.insert(0, [p]);
      Y.applyUpdate(author.doc, Y.encodeStateAsUpdate(peer));

      expect(anchorText(peer, anchor)).toBe('every key');
      expect(anchorText(author.doc, anchor)).toBe('every key');
      expect(resolveAnchor(peer, anchor)).toEqual(resolveAnchor(author.doc, anchor));
    });

    it('orphans in both docs when the peer deletes the anchored text', () => {
      const author = makeDoc();
      const anchor = anchorPhrase(author.doc, 'every key');
      const { from, to } = resolveAnchor(author.doc, anchor)!;

      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(author.doc));

      const peerText = peer.getXmlFragment(BODY).get(0) as Y.XmlElement;
      (peerText.get(0) as Y.XmlText).delete(from, to - from);
      Y.applyUpdate(author.doc, Y.encodeStateAsUpdate(peer));

      expect(resolveAnchor(peer, anchor)).toBeNull();
      expect(resolveAnchor(author.doc, anchor)).toBeNull();
    });

    it('an anchor created on the peer resolves on the author, after sync', () => {
      const author = makeDoc();
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(author.doc));

      const anchor = anchorPhrase(peer, 'read volume');
      Y.applyUpdate(author.doc, Y.encodeStateAsUpdate(peer));

      expect(anchorText(author.doc, anchor)).toBe('read volume');
    });
  });
});
