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
export function createCanvasExtensions(parts: CanvasExtensionParts): AnyExtension[] {
  const extensions = [
    parts.MacroNode, parts.HeadingAnchor, parts.MarkdownClipboard, parts.Callout,
    parts.CanvasTextAlign, parts.TextStyleKit,
    parts.Image.configure({ inline: false, allowBase64: false }),
    parts.TableKit.configure({ table: { resizable: true } }),
    ...(parts.additional ?? []),
  ];
  const names = new Set<string>();
  for (const extension of extensions) {
    if (names.has(extension.name)) throw new Error(`Duplicate canvas extension: ${extension.name}`);
    names.add(extension.name);
  }
  return extensions;
}
