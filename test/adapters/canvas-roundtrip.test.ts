// realtime-modules/test/adapters/canvas-roundtrip.test.ts
//
// The contract this whole feature rests on:
//
//   markdown → DocModel → ProseMirror → DocModel → markdown   is the identity
//
// The chassis already proves `markdown ⇄ DocModel` over 5000 generated
// documents and five real ones. What it CANNOT prove, because it has no
// ProseMirror, is the middle leg — and the middle leg is where a canvas
// silently eats content. A macro that becomes a paragraph, a heading anchor
// that gets dropped, an inline run that regroups into `**a****b**`: each of
// those is a data-loss bug that only shows up after a user has edited and
// saved, which is far too late.
//
// So this file works in the direction that matters: start from markdown that is
// already a serializer fixed point, push it all the way through the editor
// representation, and demand the same bytes back.

import {
  parseDocument,
  serializeDocument,
  actionItem,
  decision,
  field,
} from 'distributed-core/applications/document';
import {
  docModelToPm,
  pmToDocModel,
  macroTextFromData,
  macroDataFromText,
  minimalEdit,
} from '../../src/adapters/tiptap/canvas';

/** markdown → DocModel → ProseMirror → DocModel → markdown */
function throughEditor(markdown: string): string {
  const model = parseDocument(markdown);
  const { doc } = docModelToPm(model);
  return serializeDocument(pmToDocModel(doc, model.frontMatter));
}

function expectFixedPoint(markdown: string): void {
  // Guard the guard: if the chassis does not already consider this input a
  // fixed point, a passing assertion below would prove nothing about the
  // editor leg. This is the "revert the fix and watch the gate fail" habit,
  // applied to the input rather than the code.
  expect(serializeDocument(parseDocument(markdown))).toBe(markdown);
  expect(throughEditor(markdown)).toBe(markdown);
}

describe('canvas round trip: markdown ⇄ ProseMirror', () => {
  it('carries a whole realistic page unchanged', () => {
    expectFixedPoint(
      [
        '# Incident Report: cache stampede',
        '',
        '## Summary {#sec-summary}',
        '',
        'The cache expired for **every** key at once, and the origin took the',
        'full read volume for ~90 seconds.',
        '',
        '## Action items {#sec-actions}',
        '',
        '```macro:action-item',
        'assignee: alice@example.dev',
        'dueDate: 2026-09-01',
        'id: ai-1',
        'priority: high',
        'status: pending',
        'text: Add jitter to the cache TTL',
        '```',
        '',
        '```macro:action-item',
        'id: ai-2',
        'status: done',
        'text: Page the on-call earlier',
        '```',
        '',
        '## Decision {#sec-decision}',
        '',
        '```macro:decision',
        'decidedBy: bo@example.dev',
        'id: d-1',
        'status: accepted',
        'text: Ship jitter before the next launch',
        '```',
        '',
        '```macro:field',
        'fieldType: date',
        'key: review-date',
        'label: Review date',
        'value: 2026-09-15',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('keeps heading anchors, which is what makes existing deep links survive', () => {
    const md = '## Findings {#legacy-section-0a1b}\n\ntext\n';
    expectFixedPoint(md);

    const { doc } = docModelToPm(parseDocument(md));
    // Not just "the markdown matches" — assert the anchor actually reached the
    // ProseMirror node, because a serializer that re-derived it from the text
    // would pass the byte check while losing the legacy section id.
    expect(doc.content?.[0]?.attrs).toMatchObject({ level: 2, anchorId: 'legacy-section-0a1b' });
  });

  it('keeps a macro as a macro node, not a code block', () => {
    const { doc } = docModelToPm({
      frontMatter: {},
      content: [actionItem({ id: 'a', text: 'ship it', status: 'pending' })],
    });
    const node = doc.content?.[0];
    expect(node?.type).toBe('macro');
    expect(node?.attrs).toEqual({ macroName: 'action-item' });
    // The payload lives in the node's TEXT, not its attrs. That is the choice
    // that makes block-level suggestions work with the existing mark-based
    // machinery instead of needing node marks.
    expect(node?.content?.[0]?.text).toBe('id: a\nstatus: pending\ntext: ship it');
  });

  it('survives every inline form, including nesting and mentions', () => {
    expectFixedPoint(
      [
        'Plain, **bold**, *italic*, ~~struck~~, `code`, and [a link](https://example.dev).',
        '',
        '**Bold with *italic* inside** and [@Alice](mention:user-123) was assigned.',
        '',
        'A [labelled link](https://example.dev "the title") too.',
        '',
      ].join('\n'),
    );
  });

  it('does not fuse two adjacent runs of the same mark into one', () => {
    // The regression: ProseMirror stores `**a**` and `**b**` as two text nodes
    // with the same bold mark. Regrouping them naively emits `**a****b**`,
    // which markdown re-parses as a single run — the document changed.
    const md = '**alpha** and **beta**\n';
    expectFixedPoint(md);
  });

  it('round-trips lists, including a list that mixes tasks and bullets', () => {
    expectFixedPoint('- one\n- two\n  - nested\n');
    expectFixedPoint('1. first\n2. second\n');
    // ProseMirror has separate taskList and bulletList nodes and cannot hold a
    // mixed list in one node; the model can. The split-and-remerge is what
    // keeps this a fixed point rather than turning one list into two.
    expectFixedPoint('- [ ] todo\n- [x] done\n- plain bullet\n');
  });

  it('round-trips code blocks, blockquotes and rules', () => {
    expectFixedPoint('```sql\nselect 1;\n```\n');
    expectFixedPoint('```\nbare fence\n```\n');
    expectFixedPoint('> quoted\n>\n> two paragraphs\n');
    expectFixedPoint('before\n\n---\n\nafter\n');
  });

  it('preserves front matter through the editor leg untouched', () => {
    const md = '---\nstatus: draft\nwatchers:\n  - alice\n---\n\n# Title\n';
    expectFixedPoint(md);
  });

  it('degrades an inexpressible block visibly instead of dropping it', () => {
    // No Table node in the canvas schema yet. The requirement is not that it
    // renders perfectly — it is that the content is still ON THE PAGE and the
    // caller is told, rather than the row quietly disappearing.
    const model = parseDocument('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    const { doc, unsupported } = docModelToPm(model);
    expect(unsupported).toEqual([
      expect.objectContaining({ kind: 'table' }),
    ]);
    expect(doc.content?.[0]?.type).toBe('codeBlock');
    expect(doc.content?.[0]?.content?.[0]?.text).toContain('| a | b |');
  });
});

describe('macro payload ⇄ editor text', () => {
  it('produces exactly the bytes the chassis writes between the fences', () => {
    const block = actionItem({ id: 'x', text: 'do', status: 'done', assignee: 'a@b.dev' });
    const md = serializeDocument({ frontMatter: {}, content: [block] });
    const body = md.split('\n').slice(1, -2).join('\n');
    expect(macroTextFromData(block.name, block.data)).toBe(body);
  });

  it('reads back what it wrote, for every shipped macro', () => {
    for (const block of [
      actionItem({ id: '1', text: 'a', status: 'pending', priority: 'high' }),
      decision({ id: '2', text: 'b', decidedBy: 'c@d.dev' }),
      field({ key: 'sev', label: 'Severity', fieldType: 'text', value: 'SEV-2' }),
    ]) {
      const text = macroTextFromData(block.name, block.data);
      expect(macroDataFromText(block.name, text)).toEqual(block.data);
    }
  });

  it('returns null rather than throwing when a CRDT merge broke the YAML', () => {
    // Two clients rewriting the same field concurrently really can produce
    // this. A throw here would blank the editor; null lets the node view fall
    // back to showing the raw source so the user can repair it.
    expect(macroDataFromText('action-item', 'status: [unclosed\n  text: x')).toBeNull();
  });

  it('preserves an unknown macro verbatim — the most important format property', () => {
    // A document authored by a NEWER client must survive an OLDER one. If an
    // unrecognised macro round-trips, an old client can open, edit and save a
    // document full of macros it has never heard of without destroying them.
    expectFixedPoint('```macro:diagram\nid: dg-1\nsource: excalidraw\n```\n');
  });
});

describe('minimalEdit', () => {
  it('narrows a whole-body rewrite down to the characters that changed', () => {
    // Why it matters: toggling a status is conceptually a full YAML re-dump.
    // Dispatching the full replacement makes two clients editing DIFFERENT
    // fields of the same macro collide on every byte. The minimal range lets
    // Y.js merge them the way it merges edits to different words.
    const before = 'id: a\nstatus: pending\ntext: ship\n';
    const after = 'id: a\nstatus: done\ntext: ship\n';
    const edit = minimalEdit(before, after)!;
    expect(before.slice(edit.from, edit.to)).toBe('pending');
    expect(edit.insert).toBe('done');
    expect(before.slice(0, edit.from) + edit.insert + before.slice(edit.to)).toBe(after);
  });

  it('is null for a no-op, so an unchanged field never dirties the document', () => {
    expect(minimalEdit('same', 'same')).toBeNull();
  });

  it('handles pure insertion and pure deletion', () => {
    const ins = minimalEdit('ab', 'axb')!;
    expect('ab'.slice(0, ins.from) + ins.insert + 'ab'.slice(ins.to)).toBe('axb');
    const del = minimalEdit('axb', 'ab')!;
    expect('axb'.slice(0, del.from) + del.insert + 'axb'.slice(del.to)).toBe('ab');
  });
});
