import type { DocModel } from 'distributed-core/applications/document';
export interface PmMark {
    type: string;
    attrs?: Record<string, unknown>;
}
export interface PmNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: PmNode[];
    text?: string;
    marks?: PmMark[];
}
/**
 * A block or inline form the ProseMirror schema cannot express.
 *
 * Reported rather than thrown. A conversion that throws inside a React render
 * blanks the page, and a blank page makes every downstream probe vacuously
 * pass — the exact failure this codebase keeps re-learning. The block is
 * degraded to a visible markdown code block instead, so the content is on
 * screen, obviously different, and never silently gone.
 */
export interface UnsupportedForm {
    kind: string;
    reason: string;
}
export interface ToPmResult {
    doc: PmNode;
    unsupported: UnsupportedForm[];
}
/** Materialises a chassis document as a ProseMirror `doc` node. */
export declare function docModelToPm(model: DocModel): ToPmResult;
/** Reads a ProseMirror `doc` node back into the chassis document model. */
export declare function pmToDocModel(doc: PmNode, frontMatter?: DocModel['frontMatter']): DocModel;
//# sourceMappingURL=pmModel.d.ts.map