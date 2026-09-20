import { type CanvasConversionSchema, type UnsupportedForm } from '../adapters/tiptap/canvas/pmModel';
/** Build an initial binary canvas using the consumer's canonical editor schema. Never reconstruct an existing Y.Doc this way. */
export declare function createCanvasSeed(markdown: string, options: {
    schema: CanvasConversionSchema;
}): {
    snapshot: string;
    unsupported: UnsupportedForm[];
};
//# sourceMappingURL=canvasSeed.d.ts.map