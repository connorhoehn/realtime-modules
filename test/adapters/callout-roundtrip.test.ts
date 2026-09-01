// realtime-modules/test/adapters/callout-roundtrip.test.ts
//
// The callout's half of the contract in `canvas-roundtrip.test.ts`:
//
//   markdown → DocModel → ProseMirror → DocModel → markdown   is the identity
//
// A callout is the one construct in this schema that is not a single chassis
// block. It is a blockquote whose first child is a `macro:callout` marker, and
// the editor collapses that pair into ONE `callout` node — so the conversion has
// to take the wrapper apart on the way in and put it back together on the way
// out. Get either half wrong and nothing throws: `pmBlocksToModel`'s
// unknown-node branch keeps the inner paragraphs and quietly drops the panel and
// its variant, which is a bug the author only finds after saving.
//
// ## The canonical-markdown trap
//
// Every input here is markdown the CHASSIS already round-trips byte for byte,
// and `expectFixedPoint` asserts that FIRST. That guard is the point of the
// file: markdown has many spellings per document and the chassis has one, so an
// input the chassis itself normalises (a tight nested list, `---` for a
// thematic break, an unquoted YAML date) would fail this test for a reason that
// has nothing to do with the editor leg — or, worse, a sloppy assertion written
// to accommodate it would pass while the editor ate the panel.

import { parseDocument, serializeDocument } from 'distributed-core/applications/document';
import {
  CALLOUT_MACRO_NAME,
  CALLOUT_NODE_NAME,
  CALLOUT_VARIANTS,
  docModelToPm,
  pmToDocModel,
} from '../../src/adapters/tiptap/canvas';
import type { PmNode } from '../../src/adapters/tiptap/canvas';

/** markdown → DocModel → ProseMirror → DocModel → markdown */
function throughEditor(markdown: string): string {
  const model = parseDocument(markdown);
  const { doc } = docModelToPm(model);
  return serializeDocument(pmToDocModel(doc, model.frontMatter));
}

function expectFixedPoint(markdown: string): void {
  // Guard the guard, exactly as `canvas-roundtrip.test.ts` does: if the chassis
  // does not already consider this input canonical, the assertion below would
  // prove nothing about the editor leg.
  expect(serializeDocument(parseDocument(markdown))).toBe(markdown);
  expect(throughEditor(markdown)).toBe(markdown);
}

/**
 * A callout holding a paragraph AND a list — the two-block body is the case
 * that matters, because a one-paragraph body would still look right if the
 * conversion silently flattened the panel.
 */
function calloutMarkdown(variant: string): string {
  return [
    '> ```macro:callout',
    `> variant: ${variant}`,
    '> ```',
    '>',
    '> Heads up, this is the body.',
    '>',
    '> - first consequence',
    '> - second consequence',
    '',
  ].join('\n');
}

describe('callout round trip: markdown ⇄ ProseMirror', () => {
  it.each(CALLOUT_VARIANTS)('is a fixed point for a %s callout with a paragraph and a list', (variant) => {
    expectFixedPoint(calloutMarkdown(variant));
  });

  it('reaches ProseMirror as one callout node, not a quote wrapped round a macro', () => {
    // The byte check above can be satisfied by a conversion that never builds a
    // callout at all — a blockquote holding a macro node serialises to the same
    // markdown. So assert the SHAPE too: this is what proves the editor renders
    // a panel rather than a quote with YAML sitting at the top of it.
    const { doc, unsupported } = docModelToPm(parseDocument(calloutMarkdown('warning')));
    expect(unsupported).toEqual([]);
    expect(doc.content).toHaveLength(1);

    const callout = doc.content![0];
    expect(callout.type).toBe(CALLOUT_NODE_NAME);
    expect(callout.attrs).toEqual({ variant: 'warning' });
    // The marker is CONSUMED, not kept as a child. A leftover macro node would
    // show the user `variant: warning` as editable text inside their panel.
    expect(callout.content?.map((child) => child.type)).toEqual(['paragraph', 'bulletList']);
  });

  it('puts the marker back as a macro block, which is what makes the variant survive', () => {
    const model = pmToDocModel({
      type: 'doc',
      content: [
        {
          type: CALLOUT_NODE_NAME,
          attrs: { variant: 'success' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'shipped' }] }],
        },
      ],
    });
    expect(model.content).toEqual([
      {
        type: 'blockquote',
        content: [
          { type: 'macro', name: CALLOUT_MACRO_NAME, data: { variant: 'success' } },
          { type: 'paragraph', content: [{ type: 'text', value: 'shipped' }] },
        ],
      },
    ]);
  });

  it('normalises a variant a CRDT merge invented rather than writing it to the file', () => {
    // `data-variant` is echoed into the consuming app's CSS selectors, and a
    // Y.Doc can be written by an older client or by a direct edit that never
    // passed through `setCallout`. Falling back to `info` at the LAST point
    // before serialisation is what keeps the attribute a closed set on disk.
    const model = pmToDocModel({
      type: 'doc',
      content: [
        {
          type: CALLOUT_NODE_NAME,
          attrs: { variant: 'expando"><script>' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    });
    expect(serializeDocument(model)).toBe(
      '> ```macro:callout\n> variant: info\n> ```\n>\n> x\n',
    );
  });

  it('keeps inline marks and mentions intact inside the panel', () => {
    // The body is ordinary prose, not an opaque YAML scalar — that was the whole
    // argument for the blockquote form over stuffing the text into the fence.
    expectFixedPoint(
      [
        '> ```macro:callout',
        '> variant: error',
        '> ```',
        '>',
        '> **Do not** deploy this, ask [@Alice](mention:user-123) first.',
        '',
      ].join('\n'),
    );
  });

  it('round-trips a callout sitting between ordinary blocks', () => {
    expectFixedPoint(
      [
        '# Runbook',
        '',
        'Before you start:',
        '',
        '> ```macro:callout',
        '> variant: note',
        '> ```',
        '>',
        '> Take the lock first.',
        '',
        'Then run the migration.',
        '',
      ].join('\n'),
    );
  });

  it('leaves an ordinary blockquote, and a quote holding a non-callout macro, alone', () => {
    // The recogniser keys on the macro NAME. A blockquote that happens to open
    // with `macro:action-item` is a quote, and turning it into a panel would
    // eat the macro node the user is meant to be able to edit.
    expectFixedPoint('> quoted\n>\n> two paragraphs\n');

    const md = '> ```macro:action-item\n> id: a\n> status: pending\n> text: do\n> ```\n';
    expectFixedPoint(md);
    const { doc } = docModelToPm(parseDocument(md));
    expect(doc.content?.[0]?.type).toBe('blockquote');
  });

  it('leaves a bare marker with no body as a blockquote, and still a fixed point', () => {
    // A `callout` node is `block+`, so making one here would force ProseMirror
    // to invent the empty paragraph its schema demands — and that paragraph
    // would come back in the file as a body the author never wrote. Staying a
    // blockquote keeps a document that is already canonical canonical.
    const md = '> ```macro:callout\n> variant: info\n> ```\n';
    expectFixedPoint(md);
    const { doc } = docModelToPm(parseDocument(md));
    expect(doc.content?.[0]?.type).toBe('blockquote');
  });

  it('survives a callout nested inside a list item', () => {
    // Not a curiosity: "step 3, and mind the warning" is the shape a runbook
    // actually has. It exercises the recogniser from inside `blocksToPm`'s list
    // path rather than at the top level.
    const md = [
      '- step one',
      '- step two',
      '',
      '  > ```macro:callout',
      '  > variant: warning',
      '  > ```',
      '  >',
      '  > This one is destructive.',
      '',
    ].join('\n');
    expectFixedPoint(md);

    const { doc } = docModelToPm(parseDocument(md));
    const secondItem = doc.content?.[0]?.content?.[1] as PmNode;
    expect(secondItem.content?.map((child) => child.type)).toEqual([
      'paragraph',
      CALLOUT_NODE_NAME,
    ]);
  });

  it('survives a callout whose body contains a nested blockquote', () => {
    // The inner quote must NOT be mistaken for the callout wrapper on the way
    // back: only the OUTER blockquote's first child is a marker.
    expectFixedPoint(
      [
        '> ```macro:callout',
        '> variant: info',
        '> ```',
        '>',
        '> Context:',
        '>',
        '> > from the incident review',
        '',
      ].join('\n'),
    );
  });
});
