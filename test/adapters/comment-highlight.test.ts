/** @jest-environment jsdom */
//
// realtime-modules/test/adapters/comment-highlight.test.ts
//
// A real editor, bound to a real Y.Doc through the real Collaboration
// extension, asserted against the real DOM. Every shortcut available here
// removes the thing being tested:
//
//   • asserting on decoration INDICES passes just as happily when the
//     plain-text-to-ProseMirror mapping is off by a constant, so every
//     assertion is on the highlighted TEXT instead
//   • building the ProseMirror doc by hand instead of letting y-tiptap build it
//     would test a document whose text nodes happen to line up with the Y
//     fragment, which is exactly the assumption under test
//   • a mounted editor is unavoidable: decorations exist only in a view

import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import * as Y from 'yjs';
import {
  canvasPlainText,
  createAnchor,
  type CanvasAnchor,
} from '../../src/adapters/tiptap/canvas/anchors';
import {
  CommentHighlight,
  commentHighlightPluginKey,
  type CommentHighlightOptions,
  type CommentHighlightRef,
} from '../../src/adapters/tiptap/canvas/CommentHighlight';

/** Matches `CANVAS_BODY_KEY` in `useCanvasDocument`. */
const BODY = 'body';

const PARA_1 = 'The cache expired for every key at once.';
const PARA_2 = 'The origin took the full read volume for ninety seconds.';

interface Fixture {
  editor: Editor;
  ydoc: Y.Doc;
}

const editors: Editor[] = [];

function makeEditor(
  options: Partial<CommentHighlightOptions> = {},
  paragraphs: string[] = [PARA_1, PARA_2],
): Fixture {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(BODY);
  ydoc.transact(() => {
    for (const content of paragraphs) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, content);
      p.insert(0, [t]);
      fragment.push([p]);
    }
  });

  const element = document.createElement('div');
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      Collaboration.configure({ document: ydoc, fragment }),
      CommentHighlight.configure({ ydoc, fragmentKey: BODY, ...options }),
    ],
  });
  editors.push(editor);
  return { editor, ydoc };
}

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  document.body.innerHTML = '';
});

/** Anchors the first occurrence of `phrase` in the document's plain text. */
function anchorPhrase(ydoc: Y.Doc, phrase: string): CanvasAnchor {
  const from = canvasPlainText(ydoc, BODY).indexOf(phrase);
  expect(from).toBeGreaterThanOrEqual(0);
  return createAnchor(ydoc, BODY, from, from + phrase.length);
}

function thread(
  id: string,
  anchor: CanvasAnchor,
  state: CommentHighlightRef['state'] = 'open',
): CommentHighlightRef {
  return { id, anchor, state };
}

/** Every span the extension painted, in document order. */
function spans(editor: Editor, id?: string): HTMLElement[] {
  const selector = id ? `[data-comment-id="${id}"]` : '.canvas-comment';
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>(selector));
}

/**
 * The text one thread's highlight covers.
 *
 * Concatenated across spans on purpose: ProseMirror splits a decoration at
 * every block boundary and wherever another decoration overlaps it, so one
 * thread can legitimately own several spans. None of them nest inside another
 * span of the SAME id, so concatenation reproduces the range exactly.
 */
function coveredText(editor: Editor, id: string): string {
  return spans(editor, id)
    .map((element) => element.textContent ?? '')
    .join('');
}

/** Decoration ranges straight from plugin state, for the few position assertions. */
function ranges(editor: Editor, id: string): Array<{ from: number; to: number }> {
  const set = commentHighlightPluginKey.getState(editor.state)?.decorations;
  return (set?.find() ?? [])
    .filter((d) => (d.spec as { commentId?: string }).commentId === id)
    .map((d) => ({ from: d.from, to: d.to }));
}

describe('the highlight lands on the anchored words', () => {
  it('covers exactly the anchored phrase and nothing either side of it', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);

    expect(spans(editor)).toHaveLength(1);
    expect(coveredText(editor, 'c1')).toBe('every key');
  });

  // The mapping's whole reason for existing. A ProseMirror position counts the
  // paragraph tokens a plain-text offset does not, so a comment in the SECOND
  // paragraph is where a naive implementation first goes visibly wrong.
  it('covers the right phrase in the second paragraph, where the number lines have diverged', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'read volume'))]);

    expect(coveredText(editor, 'c1')).toBe('read volume');
    // And the offset really did need translating — the raw plain-text offset
    // points somewhere else entirely by now.
    const plainFrom = canvasPlainText(ydoc, BODY).indexOf('read volume');
    expect(ranges(editor, 'c1')[0].from).not.toBe(plainFrom);
  });

  it('splits across a block boundary instead of painting the gap between paragraphs', () => {
    const { editor, ydoc } = makeEditor();
    // A range that starts in paragraph one and ends in paragraph two.
    const plain = canvasPlainText(ydoc, BODY);
    const from = plain.indexOf('at once.');
    const to = plain.indexOf('took');
    const anchor = createAnchor(ydoc, BODY, from, to);

    editor.commands.setCommentHighlights([thread('c1', anchor)]);

    expect(spans(editor, 'c1')).toHaveLength(2);
    expect(coveredText(editor, 'c1')).toBe(plain.slice(from, to));
    expect(coveredText(editor, 'c1')).toBe('at once.The origin ');
  });

  it('paints two threads independently', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'every key')),
      thread('c2', anchorPhrase(ydoc, 'ninety seconds')),
    ]);

    expect(coveredText(editor, 'c1')).toBe('every key');
    expect(coveredText(editor, 'c2')).toBe('ninety seconds');
  });
});

describe('editing the document', () => {
  // The property that makes the feature correct rather than merely present.
  // An implementation that stores ProseMirror positions and never maps them
  // fails exactly here, and fails silently: the highlight stays put and starts
  // pointing at someone else's words.
  it('still covers the same words after text is inserted BEFORE the anchor', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);
    const before = ranges(editor, 'c1')[0];

    editor.commands.insertContentAt(1, 'Under load, ');

    expect(coveredText(editor, 'c1')).toBe('every key');
    // And it genuinely MOVED — otherwise the assertion above would also pass
    // for an implementation that is measuring nothing at all.
    expect(ranges(editor, 'c1')[0].from).toBe(before.from + 'Under load, '.length);
  });

  it('still covers the same words after a whole paragraph is inserted above', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);
    const before = ranges(editor, 'c1')[0];

    editor.commands.insertContentAt(0, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'A collaborator typed this above you.' }],
    });

    expect(coveredText(editor, 'c1')).toBe('every key');
    expect(ranges(editor, 'c1')[0].from).toBeGreaterThan(before.from);
  });

  // Mapping and re-resolving must AGREE. If they did not, a highlight would
  // jump the moment the gutter refreshed its thread list.
  it('agrees with a rebuild from the Y.Doc after the edit has been flushed', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);

    editor.commands.insertContentAt(1, 'Under load, ');
    const mapped = ranges(editor, 'c1');

    editor.commands.refreshCommentHighlights();

    expect(ranges(editor, 'c1')).toEqual(mapped);
    expect(coveredText(editor, 'c1')).toBe('every key');
  });

  it('does not creep over text typed against either edge of the highlight', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);
    const { from, to } = ranges(editor, 'c1')[0];

    editor.commands.insertContentAt(to, '!!');
    editor.commands.insertContentAt(from, '**');

    expect(coveredText(editor, 'c1')).toBe('every key');
  });

  it('drops the highlight when the anchored text is deleted', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);
    const { from, to } = ranges(editor, 'c1')[0];

    editor.commands.deleteRange({ from, to });

    expect(spans(editor, 'c1')).toHaveLength(0);
    // And it stays gone after a rebuild — the anchor is a genuine orphan now.
    editor.commands.refreshCommentHighlights();
    expect(spans(editor, 'c1')).toHaveLength(0);
  });
});

describe('anchors that no longer resolve', () => {
  it('renders nothing, and does not throw, for a deleted range', () => {
    const { editor, ydoc } = makeEditor();
    const anchor = anchorPhrase(ydoc, 'every key');
    const from = canvasPlainText(ydoc, BODY).indexOf('every key');

    // Deleted through Y.js, the way a remote peer would delete it.
    const paragraph = ydoc.getXmlFragment(BODY).get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).delete(from, 'every key'.length);

    expect(() => editor.commands.setCommentHighlights([thread('c1', anchor)])).not.toThrow();
    expect(spans(editor)).toHaveLength(0);
  });

  it('renders nothing for a malformed, foreign or wrong-fragment anchor', () => {
    const { editor, ydoc } = makeEditor();
    const good = anchorPhrase(ydoc, 'every key');

    const other = new Y.Doc();
    other.getXmlFragment(BODY).push([new Y.XmlElement('paragraph')]);

    expect(() =>
      editor.commands.setCommentHighlights([
        thread('malformed', {} as CanvasAnchor),
        thread('missing', null as unknown as CanvasAnchor),
        thread('future', { ...good, v: 99 }),
        thread('garbled', { ...good, start: 'not base64 at all' }),
        thread('other-root', { ...good, key: 'some-other-root' }),
      ]),
    ).not.toThrow();

    expect(spans(editor)).toHaveLength(0);
  });

  it('keeps painting the healthy threads when one is orphaned', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('broken', {} as CanvasAnchor),
      thread('c2', anchorPhrase(ydoc, 'read volume')),
    ]);

    expect(coveredText(editor, 'c2')).toBe('read volume');
    expect(spans(editor)).toHaveLength(1);
  });
});

describe('thread state reaches the class name', () => {
  it('gives open, active and resolved different classes on the same base', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('open', anchorPhrase(ydoc, 'cache'), 'open'),
      thread('active', anchorPhrase(ydoc, 'every key'), 'active'),
      thread('resolved', anchorPhrase(ydoc, 'read volume'), 'resolved'),
    ]);

    const classOf = (id: string) => spans(editor, id)[0].className;

    expect(classOf('open')).toBe('canvas-comment canvas-comment--open');
    expect(classOf('active')).toBe('canvas-comment canvas-comment--active');
    expect(classOf('resolved')).toBe('canvas-comment canvas-comment--resolved');
    // The base class is shared, so the app can style "a comment" once and then
    // only override what differs.
    expect(spans(editor)).toHaveLength(3);
  });

  it('hides resolved threads entirely when the app asks it to', () => {
    const { editor, ydoc } = makeEditor({ hideResolved: true });
    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'every key'), 'resolved'),
      thread('c2', anchorPhrase(ydoc, 'read volume'), 'open'),
    ]);

    expect(spans(editor, 'c1')).toHaveLength(0);
    expect(coveredText(editor, 'c2')).toBe('read volume');
  });

  it('sanitises a state that arrived from storage before it reaches the class attribute', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'every key'), 'needs review" onclick="x'),
    ]);

    expect(spans(editor, 'c1')[0].className).toBe(
      'canvas-comment canvas-comment--needs-review-onclick-x',
    );
  });
});

describe('overlapping threads', () => {
  it('renders both, each covering its own full range', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'expired for every')),
      thread('c2', anchorPhrase(ydoc, 'every key at once')),
    ]);

    expect(coveredText(editor, 'c1')).toBe('expired for every');
    expect(coveredText(editor, 'c2')).toBe('every key at once');
    // The shared word belongs to both, so it is split off into its own span.
    expect(spans(editor, 'c1').length).toBeGreaterThan(1);
  });

  // Pins the reason each decoration asks for its own `nodeName`. Without it
  // ProseMirror flattens the overlap into ONE element and the second thread's
  // `data-comment-id` is overwritten — the highlight is still visible, so the
  // regression only shows up as a gutter link that silently stops working.
  it('keeps a separate span per thread where they overlap', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'expired for every'), 'open'),
      thread('c2', anchorPhrase(ydoc, 'every key at once'), 'active'),
    ]);

    const shared = spans(editor, 'c1').find((element) => element.textContent === 'every');
    expect(shared).toBeDefined();
    // The two spans NEST — one thread inside the other — rather than one span
    // wearing a single id that silently won. Which is inside which is
    // ProseMirror's business; that both are present is the contract.
    expect(shared!.closest('[data-comment-id="c2"]')).not.toBeNull();
    expect(shared!.className).toBe('canvas-comment canvas-comment--open');
  });

  it('renders a thread fully contained inside another', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setCommentHighlights([
      thread('outer', anchorPhrase(ydoc, 'expired for every key')),
      thread('inner', anchorPhrase(ydoc, 'every')),
    ]);

    expect(coveredText(editor, 'outer')).toBe('expired for every key');
    expect(coveredText(editor, 'inner')).toBe('every');
  });
});

describe('clicking a highlight', () => {
  /** What ProseMirror does on a click, without needing real coordinates in jsdom. */
  function click(editor: Editor, pos: number): void {
    editor.view.someProp('handleClick', (handler) =>
      handler(editor.view, pos, new MouseEvent('click')),
    );
  }

  it('reports the comment id so the gutter can focus that thread', () => {
    const clicked: string[] = [];
    const { editor, ydoc } = makeEditor({ onCommentClick: (id) => clicked.push(id) });
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);

    const { from, to } = ranges(editor, 'c1')[0];
    click(editor, Math.floor((from + to) / 2));

    expect(clicked).toEqual(['c1']);
  });

  it('stays silent outside every highlight', () => {
    const clicked: string[] = [];
    const { editor, ydoc } = makeEditor({ onCommentClick: (id) => clicked.push(id) });
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);

    click(editor, 1);

    expect(clicked).toEqual([]);
  });

  it('picks the narrower thread where two overlap', () => {
    const clicked: string[] = [];
    const { editor, ydoc } = makeEditor({ onCommentClick: (id) => clicked.push(id) });
    editor.commands.setCommentHighlights([
      thread('outer', anchorPhrase(ydoc, 'expired for every key')),
      thread('inner', anchorPhrase(ydoc, 'every')),
    ]);

    const inner = ranges(editor, 'inner')[0];
    click(editor, Math.floor((inner.from + inner.to) / 2));

    expect(clicked).toEqual(['inner']);
  });

  it('leaves the click unhandled, so the caret still lands in the commented word', () => {
    const { editor, ydoc } = makeEditor({ onCommentClick: () => undefined });
    editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]);
    const { from, to } = ranges(editor, 'c1')[0];

    const handled = editor.view.someProp('handleClick', (handler) =>
      handler(editor.view, Math.floor((from + to) / 2), new MouseEvent('click')),
    );

    // `someProp` returns the handler's value; a truthy one would mean the
    // editor never gets to place the selection.
    expect(handled).toBeFalsy();
  });
});

describe('the document the highlights are resolved against', () => {
  it('paints nothing until it has a Y.Doc', () => {
    const { editor, ydoc } = makeEditor({ ydoc: null });
    expect(() =>
      editor.commands.setCommentHighlights([thread('c1', anchorPhrase(ydoc, 'every key'))]),
    ).not.toThrow();
    expect(spans(editor)).toHaveLength(0);

    editor.commands.setCommentHighlightDocument(ydoc);

    expect(coveredText(editor, 'c1')).toBe('every key');
  });

  it('never writes the highlight into the document', () => {
    const { editor, ydoc } = makeEditor();
    const before = canvasPlainText(ydoc, BODY);
    const beforeJson = JSON.stringify(editor.getJSON());

    editor.commands.setCommentHighlights([
      thread('c1', anchorPhrase(ydoc, 'every key'), 'active'),
    ]);

    // The whole point of a decoration over a mark: the prose, the Y.Doc and
    // therefore the markdown are byte-for-byte untouched by commenting.
    expect(canvasPlainText(ydoc, BODY)).toBe(before);
    expect(JSON.stringify(editor.getJSON())).toBe(beforeJson);
    expect(JSON.stringify(editor.getJSON())).not.toContain('c1');
  });
});
