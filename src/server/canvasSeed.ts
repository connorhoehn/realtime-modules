import * as Y from 'yjs';
import { parseDocument, CANVAS_SCHEMA_VERSION } from 'distributed-core/applications/document';
import { docModelToPm, type CanvasConversionSchema, type UnsupportedForm } from '../adapters/tiptap/canvas/pmModel';

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
      const reserved = new Set(['schemaVersion', 'title', 'importSourceRevision', 'tenantId', 'documentId', 'createdBy']);
      for (const [key, value] of Object.entries(model.frontMatter ?? {})) {
        if (!reserved.has(key)) doc.getMap('meta').set(key, value);
      }
      doc.getMap('meta').set('schemaVersion', CANVAS_SCHEMA_VERSION);
    });
    return { snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), unsupported: result.unsupported };
  } finally { doc.destroy(); }
}
