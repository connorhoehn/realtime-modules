// realtime-modules/src/adapters/tiptap/index.ts
//
// Tiptap-coupled subpath. Re-exported from the package as
// `@connorhoehn/realtime-modules/adapters/tiptap` so consumers using
// Monaco, CodeMirror, or contentEditable don't pull in Tiptap or
// ProseMirror just to use the editor-agnostic CRDT client surface.

export { default as TiptapEditor } from './TiptapEditor';
export type { TiptapEditorProps, CollaborationProvider } from './TiptapEditor';
export { default as EditorToolbar } from './EditorToolbar';

// v0.32.0 — the canvas authoring surface. The white-page document: one
// continuous body of blocks, macros as embedded tools, markdown as the
// exchange format. See ./canvas/index.ts for the cross-repo placement rule.
export * from './canvas';
