import { type CanvasConversionSchema, type UnsupportedForm } from '../adapters/tiptap/canvas/pmModel';
/** Build an initial binary canvas using the consumer's canonical editor schema. Never reconstruct an existing Y.Doc this way. */
export declare function createCanvasSeed(markdown: string, options: {
    schema: CanvasConversionSchema;
}): {
    snapshot: string;
    unsupported: UnsupportedForm[];
};
/** Derived source/search projection of an acknowledged binary snapshot; never a replacement persistence format. */
export declare function exportCanvasProjection(snapshot: string): {
    markdown: string;
};
//# sourceMappingURL=canvasSeed.d.ts.map