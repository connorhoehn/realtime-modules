/** The macro leaf's node name. */
export declare const MACRO_NODE_NAME = "macro";
/** The callout node's name. */
export declare const CALLOUT_NODE_NAME = "callout";
/**
 * The macro name the marker leaf uses inside the blockquote.
 *
 * `pmModel.ts` is the intended consumer: `blockToPm` recognises a `blockquote`
 * whose first child is a `macro` with this name and emits a `callout` node
 * from the remaining children; `pmBlocksToModel` does the inverse.
 */
export declare const CALLOUT_MACRO_NAME = "callout";
export declare const CALLOUT_VARIANTS: readonly ["info", "note", "warning", "success", "error"];
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];
/** The variant an unlabelled callout takes. */
export declare const DEFAULT_CALLOUT_VARIANT: CalloutVariant;
/**
 * The variant a value denotes, or `info`.
 *
 * Applied on the way IN from the DOM and again on the way OUT to it. Both
 * matter: an imported document, a hand-edited markdown file or a CRDT merge
 * can all carry a variant this build has never heard of.
 */
export declare function normalizeCalloutVariant(value: unknown): CalloutVariant;
//# sourceMappingURL=nodeNames.d.ts.map