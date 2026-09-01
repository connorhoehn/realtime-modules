import { Node } from '@tiptap/core';
export declare const CALLOUT_NODE_NAME = "callout";
/**
 * The macro name the marker leaf uses inside the blockquote.
 *
 * `pmModel.ts` is the intended consumer: `blockToPm` should recognise a
 * `blockquote` whose first child is a `macro` with this name and emit a
 * `callout` node from the remaining children, and `pmBlocksToModel` should do
 * the inverse. Both directions are pure data — no chassis change is required,
 * because the chassis already round-trips this shape.
 */
export declare const CALLOUT_MACRO_NAME = "callout";
export declare const CALLOUT_VARIANTS: readonly ["info", "note", "warning", "success", "error"];
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];
/**
 * The variant a value denotes, or `info`.
 *
 * Applied on the way IN from the DOM and again on the way OUT to it. Both
 * matter: an imported document, a hand-edited markdown file or a CRDT merge can
 * all put an arbitrary string here, and echoing it into `data-variant` would
 * hand an attacker a selector the consuming app's CSS never anticipated. A
 * closed set is also what lets the app theme the panel exhaustively rather than
 * defensively.
 */
export declare function normalizeCalloutVariant(value: unknown): CalloutVariant;
/**
 * `:::info ` at the start of a block, for all five variants.
 *
 * Docusaurus, Obsidian and MkDocs all ship some spelling of this, so it is the
 * gesture people already have in their fingers — which is why it earns its
 * place as the *input* even though it was rejected as the *storage* form.
 */
export declare const CALLOUT_INPUT_RULE: RegExp;
export interface CalloutOptions {
    HTMLAttributes: Record<string, unknown>;
}
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        callout: {
            /** Wrap the selection in a callout of `variant`. */
            setCallout: (variant?: CalloutVariant) => ReturnType;
            /** Wrap the selection, or unwrap it when it is already this variant. */
            toggleCallout: (variant?: CalloutVariant) => ReturnType;
            /** Lift the selection out of its callout, keeping the blocks. */
            unsetCallout: () => ReturnType;
        };
    }
}
export declare const Callout: Node<CalloutOptions, any>;
//# sourceMappingURL=callout.d.ts.map