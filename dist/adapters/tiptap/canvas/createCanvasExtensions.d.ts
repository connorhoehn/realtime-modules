import type { AnyExtension } from '@tiptap/core';
/** Schema inputs come from the consumer's installed packages; this creates no second module graph. */
export interface CanvasExtensionParts {
    MacroNode: AnyExtension;
    HeadingAnchor: AnyExtension;
    MarkdownClipboard: AnyExtension;
    Callout: AnyExtension;
    CanvasTextAlign: AnyExtension;
    TextStyleKit: AnyExtension;
    /** The base image node, or its authenticated node-view extension. */
    Image: AnyExtension;
    TableKit: AnyExtension;
    /** Per-document comment/suggestion bindings; never replace shared node definitions. */
    additional?: readonly AnyExtension[];
}
/** Same schema assembly used by the reference editor and assessment host. */
export declare function createCanvasExtensions(parts: CanvasExtensionParts): AnyExtension[];
//# sourceMappingURL=createCanvasExtensions.d.ts.map