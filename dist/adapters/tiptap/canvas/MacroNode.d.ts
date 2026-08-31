import { Node } from '@tiptap/core';
import type { JsonObject } from 'distributed-core/applications/document';
export interface MacroNodeOptions {
    HTMLAttributes: Record<string, unknown>;
}
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        macro: {
            /** Insert a macro block at the current selection. */
            insertMacro: (name: string, data: JsonObject) => ReturnType;
            /**
             * Rewrite the payload of the macro at `pos` (the position of the macro
             * node itself, as returned by a node view's `getPos()`).
             */
            setMacroData: (pos: number, data: JsonObject) => ReturnType;
        };
    }
}
export declare const MACRO_NODE_NAME = "macro";
export declare const MacroNode: Node<MacroNodeOptions, any>;
/**
 * The payload of a macro node, or `null` if its text is not valid YAML.
 *
 * A thin re-export shaped for node views, which hold a `node` rather than a
 * string. Kept here so a consumer never has to reach for `node.textContent`
 * and re-derive the name attribute itself.
 */
export declare function readMacroNode(node: {
    attrs: Record<string, unknown>;
    textContent: string;
}): {
    name: string;
    data: JsonObject | null;
    source: string;
};
//# sourceMappingURL=MacroNode.d.ts.map