"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCanvasSeed = createCanvasSeed;
const Y = __importStar(require("yjs"));
const document_1 = require("distributed-core/applications/document");
const pmModel_1 = require("../adapters/tiptap/canvas/pmModel");
/** Build an initial binary canvas using the consumer's canonical editor schema. Never reconstruct an existing Y.Doc this way. */
function createCanvasSeed(markdown, options) {
    const model = (0, document_1.parseDocument)(markdown);
    const result = (0, pmModel_1.docModelToPm)(model, options.schema);
    // Optional peer remains lazy so a plain server import does not require TipTap.
    const bridge = require('@tiptap/y-tiptap');
    const doc = new Y.Doc();
    try {
        doc.transact(() => {
            bridge.prosemirrorJSONToYXmlFragment(options.schema, result.doc, doc.getXmlFragment('body'));
            const reserved = new Set(['schemaVersion', 'title', 'importSourceRevision', 'tenantId', 'documentId', 'createdBy']);
            for (const [key, value] of Object.entries(model.frontMatter ?? {})) {
                if (!reserved.has(key))
                    doc.getMap('meta').set(key, value);
            }
            doc.getMap('meta').set('schemaVersion', document_1.CANVAS_SCHEMA_VERSION);
        });
        return { snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), unsupported: result.unsupported };
    }
    finally {
        doc.destroy();
    }
}
//# sourceMappingURL=canvasSeed.js.map