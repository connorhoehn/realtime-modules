import * as Y from 'yjs';
import { parseDocument, serializeDocument, CANVAS_SCHEMA_VERSION } from 'distributed-core/applications/document';
import { docModelToPm, pmToDocModel, type CanvasConversionSchema, type UnsupportedForm, type PmNode } from '../adapters/tiptap/canvas/pmModel';

import { canvasFrontMatter } from '../adapters/tiptap/canvas/meta';

/** Build an initial binary canvas using the consumer's canonical editor schema. Never reconstruct an existing Y.Doc this way. */
export function createCanvasSeed(markdown: string, options: { schema: CanvasConversionSchema }): { snapshot: string; unsupported: UnsupportedForm[] } {
  const model = parseDocument(markdown);
  const result = docModelToPm(model, options.schema);
  // Optional peer remains lazy so a plain server import does not require TipTap.
  const bridge = require('@tiptap/y-tiptap') as typeof import('@tiptap/y-tiptap');
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      bridge.prosemirrorJSONToYXmlFragment(options.schema as any, result.doc as any, doc.getXmlFragment('body'));
      for (const [key, value] of Object.entries(canvasFrontMatter(model.frontMatter ?? {}))) doc.getMap('meta').set(key, value);
      doc.getMap('meta').set('schemaVersion', CANVAS_SCHEMA_VERSION);
    });
    return { snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), unsupported: result.unsupported };
  } finally { doc.destroy(); }
}

/** Derived source/search projection of an acknowledged binary snapshot; never a replacement persistence format. */
export function exportCanvasProjection(snapshot: string): { markdown: string } {
  const bridge = require('@tiptap/y-tiptap') as typeof import('@tiptap/y-tiptap');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(snapshot, 'base64'));
    if (doc.getMap('meta').get('schemaVersion') !== CANVAS_SCHEMA_VERSION) throw new Error('Snapshot is not a supported canvas document');
    const json = bridge.yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body'));
    const model = pmToDocModel(json as PmNode, canvasFrontMatter(doc.getMap('meta').toJSON()));
    return { markdown: serializeDocument(model) };
  } finally { doc.destroy(); }
}
