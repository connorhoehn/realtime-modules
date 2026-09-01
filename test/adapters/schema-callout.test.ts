/**
 * @jest-environment jsdom
 */
//
// realtime-modules/test/adapters/schema-callout.test.ts
//
// The callout is a *schema* claim, so it is tested as one: the extension is
// compiled into a real ProseMirror schema and driven through prosemirror-model's
// own DOM parser and serializer. No editor is mounted — an EditorView would put
// a browser between the assertion and the thing being asserted, and then a
// broken attribute would read as a rendering problem rather than a data
// problem.
//
// The two failures worth catching here are both silent: a variant that does not
// survive the DOM (the panel changes colour on reload) and a hostile variant
// echoed into the document (a selector the consuming app never anticipated).

import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { BulletList, ListItem } from '@tiptap/extension-list';
import { DOMParser as PmDOMParser, DOMSerializer, type Schema } from '@tiptap/pm/model';
import { parseDocument, serializeDocument } from 'distributed-core/applications/document';
import {
  Callout,
  CALLOUT_INPUT_RULE,
  CALLOUT_MACRO_NAME,
  CALLOUT_VARIANTS,
  normalizeCalloutVariant,
} from '../../src/adapters/tiptap/canvas/schema/callout';

const schema: Schema = getSchema([Document, Paragraph, Text, BulletList, ListItem, Callout]);

/** A ProseMirror node serialised the way the editor would write it to the DOM. */
function toHtml(node: ReturnType<Schema['nodeFromJSON']>): string {
  const container = document.createElement('div');
  container.appendChild(DOMSerializer.fromSchema(schema).serializeNode(node));
  return container.innerHTML;
}

/** HTML read back the way a paste or a `setContent` would read it. */
function fromHtml(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PmDOMParser.fromSchema(schema).parse(container);
}

function calloutWithText(variant: string, text: string) {
  return schema.nodes.callout.create({ variant }, schema.nodes.paragraph.create(null, schema.text(text)));
}

describe('callout — schema shape', () => {
  it('is a block that contains blocks, not a textblock', () => {
    const spec = schema.nodes.callout.spec;
    expect(spec.group).toBe('block');
    expect(spec.content).toBe('block+');
    expect(schema.nodes.callout.isTextblock).toBe(false);
  });

  it('defaults its variant to info', () => {
    expect(schema.nodes.callout.create().attrs.variant).toBe('info');
  });

  it('is defining, so replacing the body does not delete the panel', () => {
    expect(schema.nodes.callout.spec.defining).toBe(true);
  });
});

describe('callout — DOM round trip', () => {
  it.each(CALLOUT_VARIANTS)('preserves the %s variant through parse → render', (variant) => {
    const html = toHtml(calloutWithText(variant, `a ${variant} panel`));
    expect(html).toContain('data-type="callout"');
    expect(html).toContain(`data-variant="${variant}"`);

    const parsed = fromHtml(html);
    const node = parsed.firstChild!;
    expect(node.type.name).toBe('callout');
    expect(node.attrs.variant).toBe(variant);
    expect(node.textContent).toBe(`a ${variant} panel`);
  });

  it('falls back to info when the DOM carries an unknown variant', () => {
    const node = fromHtml(
      '<div data-type="callout" data-variant="chartreuse"><p>hi</p></div>',
    ).firstChild!;
    expect(node.attrs.variant).toBe('info');
  });

  it('falls back to info when the attribute is missing entirely', () => {
    const node = fromHtml('<div data-type="callout"><p>hi</p></div>').firstChild!;
    expect(node.attrs.variant).toBe('info');
  });

  it('never writes a hostile variant back into the DOM', () => {
    // A node can be constructed with any attrs — by an import, a CRDT merge, or
    // a caller that skipped the command. Rendering is the last gate, so it has
    // to normalise too rather than trusting what it was handed.
    const html = toHtml(calloutWithText('"><script>alert(1)</script>', 'hi'));
    expect(html).toContain('data-variant="info"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)');
  });

  it('emits no colour of its own, leaving the palette to the consuming app', () => {
    const html = toHtml(calloutWithText('warning', 'hi'));
    expect(html).not.toMatch(/style=|class=/);
  });
});

describe('callout — block content', () => {
  it('can hold a bullet list', () => {
    const list = schema.nodes.bulletList.create(null, [
      schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('one'))),
      schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('two'))),
    ]);
    const node = schema.nodes.callout.create({ variant: 'info' }, list);
    expect(() => node.check()).not.toThrow();

    const parsed = fromHtml(toHtml(node)).firstChild!;
    expect(parsed.firstChild!.type.name).toBe('bulletList');
    expect(parsed.textContent).toBe('onetwo');
  });

  it('can hold several paragraphs', () => {
    const node = schema.nodes.callout.create({ variant: 'note' }, [
      schema.nodes.paragraph.create(null, schema.text('first')),
      schema.nodes.paragraph.create(null, schema.text('second')),
    ]);
    expect(fromHtml(toHtml(node)).firstChild!.childCount).toBe(2);
  });
});

describe('callout — the :::variant input rule', () => {
  it.each(CALLOUT_VARIANTS)('matches ":::%s "', (variant) => {
    const match = CALLOUT_INPUT_RULE.exec(`:::${variant} `);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(variant);
  });

  it('ignores a variant it does not know', () => {
    expect(CALLOUT_INPUT_RULE.exec(':::chartreuse ')).toBeNull();
  });

  it('does not fire before the trailing space', () => {
    expect(CALLOUT_INPUT_RULE.exec(':::info')).toBeNull();
  });
});

describe('normalizeCalloutVariant', () => {
  it.each([undefined, null, '', 'INFO', 'chartreuse', 42, {}])(
    'maps %p to info',
    (value) => {
      expect(normalizeCalloutVariant(value)).toBe('info');
    },
  );
});

describe('callout — the stored markdown form', () => {
  // Not a test of this file's code: it pins the claim in the header comment,
  // that the blockquote-plus-marker shape is already a chassis fixed point. If
  // the chassis ever stops round-tripping it, the callout's storage plan is
  // wrong and this is where that shows up rather than in a user's lost panel.
  const markdown = [
    '> ```macro:callout',
    '> variant: warning',
    '> ```',
    '>',
    '> Heads up',
    '>',
    '> - one',
    '> - two',
    '',
  ].join('\n');

  it('survives the chassis parse → serialise unchanged', () => {
    expect(serializeDocument(parseDocument(markdown))).toBe(markdown);
  });

  it('parses as a blockquote whose first child is the callout marker', () => {
    const [block] = parseDocument(markdown).content;
    expect(block.type).toBe('blockquote');
    const first = block.type === 'blockquote' ? block.content[0] : null;
    expect(first?.type).toBe('macro');
    expect(first?.type === 'macro' && first.name).toBe(CALLOUT_MACRO_NAME);
    expect(first?.type === 'macro' && first.data.variant).toBe('warning');
  });

  it('keeps the body as real blocks, not an opaque string', () => {
    const [block] = parseDocument(markdown).content;
    const kinds = block.type === 'blockquote' ? block.content.map((b) => b.type) : [];
    expect(kinds).toEqual(['macro', 'paragraph', 'list']);
  });
});
