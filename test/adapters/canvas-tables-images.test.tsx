/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { getSchema } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { parseDocument, serializeDocument } from 'distributed-core/applications/document';
import { docModelToPm, pmToDocModel, type PmNode } from '../../src/adapters/tiptap/canvas/pmModel';
import { CanvasTextAlign } from '../../src/adapters/tiptap/canvas/schema/textAlign';
import { useCanvasDocument } from '../../src/client/useCanvasDocument';

const schema = getSchema([StarterKit.configure({ undoRedo: false }), Image, TableKit, CanvasTextAlign]);
const minimalSchema = getSchema([StarterKit.configure({ undoRedo: false })]);
const table = '| Dimension | Evidence |\n| :--- | ---: |\n| **CI** | [Build](https://example.com/build) |\n| CD | `release` |\n';

function throughLiveSchema(markdown: string, targetSchema = schema): string {
  const model = parseDocument(markdown);
  const converted = docModelToPm(model, targetSchema);
  expect(converted.unsupported).toEqual([]);
  const node = targetSchema.nodeFromJSON(converted.doc);
  node.check(); // JSON equality alone misses invalid block images inside paragraphs.
  const source = new Y.Doc();
  const restored = new Y.Doc();
  try {
    prosemirrorJSONToYXmlFragment(targetSchema, node.toJSON(), source.getXmlFragment('body'));
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
    const read = yXmlFragmentToProsemirrorJSON(restored.getXmlFragment('body')) as PmNode;
    targetSchema.nodeFromJSON(read).check();
    return serializeDocument(pmToDocModel(read));
  } finally { source.destroy(); restored.destroy(); }
}

it('keeps a GFM table native through the real TableKit schema and binary restore', () => {
  const model = parseDocument(table);
  const converted = docModelToPm(model, schema);
  expect(converted.doc.content?.[0]?.type).toBe('table');
  expect(throughLiveSchema(table)).toBe(serializeDocument(model));
});

it.each([
  '![Architecture](https://example.com/architecture.png "Diagram")\n',
  // The assessment accelerator uses attachment references, resolved only for display.
  '![diagram.png](attachment:diagram.png)\n',
  '![](/api/uploads/image-123)\n',
])('preserves image URL, alt and title through the real block-image schema: %s', markdown => {
  expect(throughLiveSchema(markdown)).toBe(serializeDocument(parseDocument(markdown)));
});

it('splits prose around a block image without dropping either side or the URL', () => {
  const result = throughLiveSchema('Before ![diagram](attachment:diagram.png) after.\n');
  expect(result).toContain('Before');
  expect(result).toContain('![diagram](attachment:diagram.png)');
  expect(result).toContain('after.');
});

it('supports an inline Image schema', () => {
  const inlineSchema = getSchema([StarterKit.configure({ undoRedo: false }), Image.configure({ inline: true })]);
  const markdown = 'Before ![diagram](https://example.com/a.png) after.\n';
  expect(throughLiveSchema(markdown, inlineSchema)).toBe(serializeDocument(parseDocument(markdown)));
});

it('keeps images inside table cells and nested lists schema-valid', () => {
  const output = throughLiveSchema('| Item | Picture |\n| --- | --- |\n| A | ![diagram](attachment:diagram.png) |\n');
  expect(output).toContain('![diagram](attachment:diagram.png)');
  expect(output).toContain('| Item');
  expect(throughLiveSchema('- ![diagram](attachment:diagram.png)\n')).toContain('![diagram](attachment:diagram.png)');
});

it('exports an editor-created table with no header without consuming the first data row', () => {
  const model = pmToDocModel({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first data row' }] }] }] }] }] });
  expect(model.content[0]).toMatchObject({ type: 'table', header: [[]], rows: [[[{ type: 'text', value: 'first data row' }]]] });
});

it('preserves original image Markdown visibly when the target has no Image node', () => {
  const markdown = 'Before ![diagram](attachment:diagram.png "Original") after.\n';
  const converted = docModelToPm(parseDocument(markdown), minimalSchema);
  expect(converted.unsupported).toEqual([expect.objectContaining({ kind: 'image' })]);
  minimalSchema.nodeFromJSON(converted.doc).check();
  const preserved = converted.doc.content?.[0]?.content?.[0]?.text ?? '';
  expect(parseDocument(preserved)).toEqual(parseDocument(markdown));
});

it('keeps tables readable as Markdown when the target has no Table nodes', () => {
  const converted = docModelToPm(parseDocument(table), minimalSchema);
  expect(converted.unsupported).toEqual([expect.objectContaining({ kind: 'table' })]);
  minimalSchema.nodeFromJSON(converted.doc).check();
  const preserved = converted.doc.content?.[0]?.content?.[0]?.text ?? '';
  expect(parseDocument(preserved)).toEqual(parseDocument(table));
});

it('passes the live schema through the actual canvas import hook', () => {
  const ydoc = new Y.Doc();
  const { result, unmount } = renderHook(() => useCanvasDocument({ ydoc }));
  try {
    act(() => {
      expect(result.current.importMarkdown(schema, `${table}\n![diagram](attachment:diagram.png)\n`))
        .toEqual({ ok: true, unsupported: [] });
    });
    expect(result.current.isCanvas).toBe(true);
    expect(result.current.exportMarkdown()).toContain('![diagram](attachment:diagram.png)');
    expect(result.current.exportMarkdown()).toContain('| Dimension');
    const before = result.current.exportMarkdown();
    act(() => { expect(result.current.importMarkdown(schema, 'replacement')).toMatchObject({ ok: false }); });
    expect(result.current.exportMarkdown()).toBe(before);
  } finally { unmount(); ydoc.destroy(); }
});

it('preserves both URLs of a linked image when the Yjs bridge cannot retain image marks', () => {
  const markdown = '[![diagram](https://example.com/a.png)](https://example.com/details)\n';
  const converted = docModelToPm(parseDocument(markdown), schema);
  expect(converted.unsupported).toEqual([expect.objectContaining({ kind: 'image-link' })]);
  schema.nodeFromJSON(converted.doc).check();
  expect(parseDocument(converted.doc.content?.[0]?.content?.[0]?.text ?? '')).toEqual(parseDocument(markdown));
});
