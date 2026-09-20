import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { createCanvasSeed } from '../../src/server/canvasSeed';
it('headless seed retains native table/image nodes and marks canvas schema', () => {
  const schema = getSchema([StarterKit, Image.configure({ inline: false }), TableKit]);
  const seed = createCanvasSeed('---\nteam: acme\nschemaVersion: 99\n---\n| A | B |\n| --- | --- |\n| one | two |\n\n![evidence](/api/uploads/asset)', { schema });
  expect(seed.unsupported).toEqual([]);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(seed.snapshot, 'base64'));
    expect(doc.getMap('meta').get('schemaVersion')).toBe(2);
    const content = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body')) as any;
    expect(content.content.map((node: any) => node.type)).toEqual(['table', 'image']);
    expect(content.content[1].attrs.src).toBe('/api/uploads/asset');
    expect(doc.getMap('meta').get('team')).toBe('acme');
    expect(() => schema.nodeFromJSON(content).check()).not.toThrow();
  } finally { doc.destroy(); }
});
