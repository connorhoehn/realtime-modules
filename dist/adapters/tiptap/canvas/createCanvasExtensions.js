"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCanvasExtensions = createCanvasExtensions;
/** Same schema assembly used by the reference editor and assessment host. */
function createCanvasExtensions(parts) {
    const extensions = [
        parts.MacroNode, parts.HeadingAnchor, parts.MarkdownClipboard, parts.Callout,
        parts.CanvasTextAlign, parts.TextStyleKit,
        parts.Image.configure({ inline: false, allowBase64: false }),
        parts.TableKit.configure({ table: { resizable: true } }),
        ...(parts.additional ?? []),
    ];
    const names = new Set();
    for (const extension of extensions) {
        if (names.has(extension.name))
            throw new Error(`Duplicate canvas extension: ${extension.name}`);
        names.add(extension.name);
    }
    return extensions;
}
//# sourceMappingURL=createCanvasExtensions.js.map