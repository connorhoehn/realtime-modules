import type { Extensions } from '@tiptap/react';
import type { XmlFragment } from 'yjs';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
/** Minimal provider shape needed by awareness. */
export interface CollaborationProvider {
    awareness: Awareness;
}
export interface TiptapEditorProps {
    fragment: XmlFragment;
    ydoc: Y.Doc;
    provider: CollaborationProvider | null;
    user: {
        name: string;
        color: string;
    };
    editable?: boolean;
    placeholder?: string;
    /** Section ID — used to filter cursor overlay to only show cursors in this section */
    sectionId?: string;
    /** Merge-safe awareness updater for cursor display info (name + color).
     *  When provided, replaces the direct setLocalStateField write. */
    onUpdateCursorInfo?: (name: string, color: string) => void;
    /**
     * Extra Tiptap extensions (nodes, marks, plugins) appended to the built-in
     * list. This is the supported way to add a feature such as track-changes /
     * redlining without forking the editor — the collab wiring, cursor overlay
     * and toolbar stay here.
     *
     * ⚠️ **Schema-affecting extensions must be stable for the editor's lifetime.**
     * ProseMirror builds its schema once, at editor construction, so a mark or
     * node added later cannot take effect. This array is therefore read only when
     * the editor is (re)built — i.e. when `ydoc` or `fragment` change — exactly
     * like `placeholder`. Passing a fresh inline array on every render is safe
     * and will NOT tear down the collab session, but it also means later edits to
     * the array are ignored until the document itself changes. Decide the
     * extension set before mounting; if you truly must swap schemas, remount the
     * editor with a new `key`.
     */
    extensions?: Extensions;
}
export default function TiptapEditor({ fragment, ydoc, provider, user, editable, placeholder: placeholderText, sectionId, onUpdateCursorInfo, extensions: extraExtensions, }: TiptapEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TiptapEditor.d.ts.map