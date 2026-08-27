"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANVAS_BODY_KEY = void 0;
exports.canvasToDocModel = canvasToDocModel;
exports.canvasToMarkdown = canvasToMarkdown;
exports.useCanvasDocument = useCanvasDocument;
const react_1 = require("react");
const document_1 = require("distributed-core/applications/document");
const y_tiptap_1 = require("@tiptap/y-tiptap");
const pmModel_1 = require("../adapters/tiptap/canvas/pmModel");
/** The Y.js root that holds the canvas body. */
exports.CANVAS_BODY_KEY = 'body';
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
function metaToFrontMatter(meta) {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (NON_FRONT_MATTER.has(key))
            continue;
        if (value === undefined)
            continue;
        out[key] = value;
    }
    return out;
}
/**
 * Reads the canvas body straight out of the CRDT as a `DocModel`.
 *
 * Exported separately from the hook so a non-React caller — a migration dry
 * run, an export route, a test — can use it without mounting anything.
 */
function canvasToDocModel(ydoc) {
    const fragment = ydoc.getXmlFragment(exports.CANVAS_BODY_KEY);
    const meta = ydoc.getMap('meta').toJSON();
    const pm = (0, y_tiptap_1.yXmlFragmentToProsemirrorJSON)(fragment);
    return (0, pmModel_1.pmToDocModel)(pm, metaToFrontMatter(meta));
}
/** The canvas body as markdown. */
function canvasToMarkdown(ydoc) {
    return (0, document_1.serializeDocument)(canvasToDocModel(ydoc));
}
function writeModel(ydoc, schema, model) {
    const fragment = ydoc.getXmlFragment(exports.CANVAS_BODY_KEY);
    if (fragment.length > 0) {
        return {
            ok: false,
            reason: 'canvas body is not empty; refusing to materialise over existing content',
            unsupported: [],
        };
    }
    const { doc, unsupported } = (0, pmModel_1.docModelToPm)(model);
    ydoc.transact(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (0, y_tiptap_1.prosemirrorJSONToYXmlFragment)(schema, doc, fragment);
        // Same transaction as the body write. A peer applying this update sees a
        // canvas with content or a legacy document — never the half state.
        ydoc.getMap('meta').set('schemaVersion', document_1.CANVAS_SCHEMA_VERSION);
    }, 'canvas-materialise');
    return { ok: true, unsupported };
}
function useCanvasDocument({ ydoc }) {
    const [schemaVersion, setSchemaVersion] = (0, react_1.useState)(0);
    // `meta` is a live CRDT map: a peer converting the document flips the gate
    // under us, and the editor has to swap paths when it does. Polling the value
    // at render time would read a stale snapshot forever.
    (0, react_1.useEffect)(() => {
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
    const isCanvas = (0, react_1.useMemo)(() => (0, document_1.isCanvasDocument)({ schemaVersion }), [schemaVersion]);
    const body = (0, react_1.useMemo)(() => (ydoc && isCanvas ? ydoc.getXmlFragment(exports.CANVAS_BODY_KEY) : null), [ydoc, isCanvas]);
    const exportMarkdown = (0, react_1.useCallback)(() => (ydoc ? canvasToMarkdown(ydoc) : ''), [ydoc]);
    const materialize = (0, react_1.useCallback)((schema, model) => ydoc
        ? writeModel(ydoc, schema, model)
        : { ok: false, reason: 'no document', unsupported: [] }, [ydoc]);
    const importMarkdown = (0, react_1.useCallback)((schema, markdown) => ydoc
        ? writeModel(ydoc, schema, (0, document_1.parseDocument)(markdown))
        : { ok: false, reason: 'no document', unsupported: [] }, [ydoc]);
    return { isCanvas, schemaVersion, body, exportMarkdown, materialize, importMarkdown };
}
//# sourceMappingURL=useCanvasDocument.js.map