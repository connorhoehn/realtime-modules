// realtime-modules/src/adapters/tiptap/index.ts
//
// Tiptap-coupled subpath. Re-exported from the package as
// `@connorhoehn/realtime-modules/adapters/tiptap` so consumers using
// Monaco, CodeMirror, or contentEditable don't pull in Tiptap or
// ProseMirror just to use the editor-agnostic CRDT client surface.

export { default as TiptapEditor } from './TiptapEditor';
export type { TiptapEditorProps, CollaborationProvider } from './TiptapEditor';
export { default as EditorToolbar } from './EditorToolbar';
