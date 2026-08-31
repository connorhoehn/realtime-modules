// realtime-modules/src/client/useCanvasDocument.ts
//
// The Y.Doc ⇄ canvas binding.
//
// This is the layer the chassis deliberately does not have. `distributed-core`
// owns the format and refuses to know about Y.js, ProseMirror or a browser;
// `pmModel.ts` next door owns `DocModel` ⇄ ProseMirror JSON. What is left —
// which Y.js root holds the page, when a document counts as a canvas, and how a
// legacy document becomes one atomically — lives here.
//
// ## The gate
//
// A document is a canvas when `meta.schemaVersion >= 2`, and that is the ONLY
// branch. Everything downstream reads the canvas body or the legacy section
// array, never both and never a merge of the two. The legacy roots are never
// cleared, so rollback is deleting one key.
//
//   ydoc.getXmlFragment('body')  ← the whole page, one fragment
//   ydoc.getMap('meta')          ← kept, plus meta.schemaVersion = 2
//   ydoc.getArray('sections')    ← kept, frozen, never read at version >= 2

import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import {
  CANVAS_SCHEMA_VERSION,
  isCanvasDocument,
  parseDocument,
  serializeDocument,
  type DocModel,
  type JsonObject,
  type JsonValue,
} from 'distributed-core/applications/document';
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from '@tiptap/y-tiptap';
import { docModelToPm, pmToDocModel, type PmNode, type UnsupportedForm } from '../adapters/tiptap/canvas/pmModel';

/** The Y.js root that holds the canvas body. */
export const CANVAS_BODY_KEY = 'body';

/**
 * A ProseMirror `Schema`, structurally. Typed loosely on purpose: importing
 * `prosemirror-model` here would put a SECOND copy of it in the module graph
 * for any consumer that pre-bundles this package, and two copies of
 * prosemirror-model is the exact failure the app's `optimizeDeps.exclude`
 * entries exist to prevent (`instanceof DecorationSet` across the boundary).
 * Callers pass `editor.schema` — the one the live editor already built.
 */
export type PmSchemaLike = { nodes: unknown; marks: unknown };

/**
 * Keys on `meta` that are NOT document front matter.
 *
 * `title` is the loud one: on a canvas the title is the first block, an
 * ordinary `# Heading`, not a scalar beside the content. That is what deletes
 * the old "an AI proposal cannot edit the header because the title is a Y.Map
 * scalar needing a typed FieldChange with compare-and-set" problem — on a
 * canvas an ordinary suggestion mark covers it.
 */
const NON_FRONT_MATTER = new Set(['title', 'schemaVersion']);

function metaToFrontMatter(meta: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(meta)) {
    if (NON_FRONT_MATTER.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value as JsonValue;
  }
  return out;
}

export interface CanvasDocument {
  /** True when `meta.schemaVersion >= 2`. The one gate. */
  isCanvas: boolean;
  schemaVersion: number;
  /** The page body. Hand this straight to `TiptapEditor`'s `fragment`. */
  body: Y.XmlFragment | null;

  /**
   * The current page as markdown — the exchange format, and the thing the
   * operator actually asked for.
   *
   * Reads the CRDT, not the editor, so it works with no editor mounted (an
   * export endpoint, a dry-run script, a test).
   */
  exportMarkdown: () => string;

  /**
   * Writes a `DocModel` into the empty canvas body and sets `schemaVersion` in
   * the SAME Y.js transaction, so no peer and no snapshot can ever observe a
   * document that claims to be a canvas but has no body.
   *
   * Refuses when the body is already non-empty. Materialising twice is how a
   * document ends up with its content duplicated, and two clients racing to
   * convert the same document is a realistic way to get there.
   */
  materialize: (schema: PmSchemaLike, model: DocModel) => MaterializeResult;

  /** Replaces the body from a markdown source. Same atomicity, same refusal. */
  importMarkdown: (schema: PmSchemaLike, markdown: string) => MaterializeResult;
}

export interface MaterializeResult {
  ok: boolean;
  /** Why it refused, when `ok` is false. */
  reason?: string;
  /** Forms the ProseMirror schema could not express. Never silent. */
  unsupported: UnsupportedForm[];
}

/**
 * Reads the canvas body straight out of the CRDT as a `DocModel`.
 *
 * Exported separately from the hook so a non-React caller — a migration dry
 * run, an export route, a test — can use it without mounting anything.
 */
export function canvasToDocModel(ydoc: Y.Doc): DocModel {
  const fragment = ydoc.getXmlFragment(CANVAS_BODY_KEY);
  const meta = ydoc.getMap('meta').toJSON() as Record<string, unknown>;
  const pm = yXmlFragmentToProsemirrorJSON(fragment) as PmNode;
  return pmToDocModel(pm, metaToFrontMatter(meta));
}

/** The canvas body as markdown. */
export function canvasToMarkdown(ydoc: Y.Doc): string {
  return serializeDocument(canvasToDocModel(ydoc));
}

function writeModel(
  ydoc: Y.Doc,
  schema: PmSchemaLike,
  model: DocModel,
): MaterializeResult {
  const fragment = ydoc.getXmlFragment(CANVAS_BODY_KEY);
  if (fragment.length > 0) {
    return {
      ok: false,
      reason: 'canvas body is not empty; refusing to materialise over existing content',
      unsupported: [],
    };
  }

  const { doc, unsupported } = docModelToPm(model);

  ydoc.transact(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prosemirrorJSONToYXmlFragment(schema as any, doc as any, fragment as any);
    // Same transaction as the body write. A peer applying this update sees a
    // canvas with content or a legacy document — never the half state.
    ydoc.getMap('meta').set('schemaVersion', CANVAS_SCHEMA_VERSION);
  }, 'canvas-materialise');

  return { ok: true, unsupported };
}

export interface UseCanvasDocumentOptions {
  ydoc: Y.Doc | null | undefined;
}

export function useCanvasDocument({ ydoc }: UseCanvasDocumentOptions): CanvasDocument {
  const [schemaVersion, setSchemaVersion] = useState(0);

  // `meta` is a live CRDT map: a peer converting the document flips the gate
  // under us, and the editor has to swap paths when it does. Polling the value
  // at render time would read a stale snapshot forever.
  useEffect(() => {
    if (!ydoc) {
      setSchemaVersion(0);
      return;
    }
    const meta = ydoc.getMap('meta');
    const read = () => {
      const raw = meta.get('schemaVersion');
      setSchemaVersion(typeof raw === 'number' ? raw : 0);
    };
    read();
    meta.observe(read);
    return () => meta.unobserve(read);
  }, [ydoc]);

  const isCanvas = useMemo(
    () => isCanvasDocument({ schemaVersion } as JsonObject),
    [schemaVersion],
  );

  const body = useMemo(
    () => (ydoc && isCanvas ? ydoc.getXmlFragment(CANVAS_BODY_KEY) : null),
    [ydoc, isCanvas],
  );

  const exportMarkdown = useCallback(() => (ydoc ? canvasToMarkdown(ydoc) : ''), [ydoc]);

  const materialize = useCallback(
    (schema: PmSchemaLike, model: DocModel): MaterializeResult =>
      ydoc
        ? writeModel(ydoc, schema, model)
        : { ok: false, reason: 'no document', unsupported: [] },
    [ydoc],
  );

  const importMarkdown = useCallback(
    (schema: PmSchemaLike, markdown: string): MaterializeResult =>
      ydoc
        ? writeModel(ydoc, schema, parseDocument(markdown))
        : { ok: false, reason: 'no document', unsupported: [] },
    [ydoc],
  );

  return { isCanvas, schemaVersion, body, exportMarkdown, materialize, importMarkdown };
}
