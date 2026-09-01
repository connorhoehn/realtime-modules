// realtime-modules/src/adapters/tiptap/TiptapEditor.tsx
//
// Lifted verbatim from frontend/src/components/doc-editor/TiptapEditor.tsx.
// Reusable Tiptap editor with Y.js collaboration and custom cursor overlay.
// Uses awareness protocol for cursor positions, rendered as a React overlay
// instead of the broken yCursorPlugin/CollaborationCursor extension.

import { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import type { XmlFragment } from 'yjs';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
// Must import from @tiptap/y-tiptap (not y-prosemirror) because Tiptap's
// Collaboration extension uses its own PluginKey instance from this package.
// Using y-prosemirror's key would never match the actual sync plugin state.
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap';
import EditorToolbar from './EditorToolbar';

// NOTE: this module used to reassign the GLOBAL `console.warn` at import time,
// permanently and without restoring it, to swallow the Tiptap
// "@tiptap/extension-collaboration comes with its own history support" warning.
// Importing this file patched the console of the entire host app.
//
// The warning was real, but the cause was a stale config key: Tiptap v2 named
// StarterKit's history sub-extension `history`, v3 renamed it to `undoRedo`, so
// `StarterKit.configure({ history: false })` silently stopped disabling it on
// the v3 peer this package declares — leaving ProseMirror's local undo stack
// live alongside the Y.js one. Configuring `undoRedo: false` (below) fixes the
// conflict for real and the warning goes away on its own. Both keys are passed
// so a v2 consumer keeps working. Do not patch the host's console.

/** Minimal provider shape needed by awareness. */
export interface CollaborationProvider {
  awareness: Awareness;
}

export interface TiptapEditorProps {
  fragment: XmlFragment;
  ydoc: Y.Doc;
  provider: CollaborationProvider | null;
  user: { name: string; color: string };
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

// ---------------------------------------------------------------------------
// Remote cursor data from awareness
// ---------------------------------------------------------------------------

interface RemoteCursorInfo {
  clientId: number;
  name: string;
  color: string;
  // Absolute positions in the ProseMirror doc
  anchor: number | null;
  head: number | null;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyleEditable: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
  position: 'relative',
};

const wrapperStyleReadOnly: React.CSSProperties = {
  position: 'relative',
};

const editorAreaStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 14,
  lineHeight: 1.6,
  color: '#1e293b',
  position: 'relative',
};

// Inject global ProseMirror styles once
const PROSEMIRROR_STYLE_ID = 'tiptap-prosemirror-style';
if (typeof document !== 'undefined' && !document.getElementById(PROSEMIRROR_STYLE_ID)) {
  const style = document.createElement('style');
  style.id = PROSEMIRROR_STYLE_ID;
  style.textContent = `
    .ProseMirror {
      min-height: 80px;
      outline: none;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ProseMirror p { margin: 0 0 0.5em; }
    .ProseMirror:focus { outline: none; }
    .ProseMirror .is-empty::before {
      content: attr(data-placeholder);
      color: #94a3b8;
      pointer-events: none;
      float: left;
      height: 0;
    }
    .ProseMirror .mention {
      color: #3b82f6;
      font-weight: 600;
      background: #eff6ff;
      padding: 0 2px;
      border-radius: 2px;
    }
    @keyframes cursorBlink {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Helper: get pixel coordinates for a ProseMirror position
// ---------------------------------------------------------------------------

function getCoords(view: any, pos: number, containerEl?: HTMLDivElement | null): { top: number; left: number; height: number } | null {
  try {
    if (pos < 0 || pos > view.state.doc.content.size) return null;
    const coords = view.coordsAtPos(pos);
    // Use the container element (editorAreaRef) as reference, not view.dom,
    // because the overlay is positioned relative to the container which has padding.
    const refEl = containerEl || view.dom;
    const refRect = refEl.getBoundingClientRect();
    return {
      top: coords.top - refRect.top,
      left: coords.left - refRect.left,
      height: coords.bottom - coords.top,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// @mention suggestion popup helper (vanilla DOM — required by Tiptap API)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cursor Overlay Component
// ---------------------------------------------------------------------------

function CursorOverlay({ cursors, editorView, containerEl }: {
  cursors: RemoteCursorInfo[];
  editorView: any;
  containerEl: HTMLDivElement | null;
}) {
  if (!editorView) return null;

  return (
    <>
      {cursors.map((c) => {
        if (c.head == null) return null;
        const coords = getCoords(editorView, c.head, containerEl);
        if (!coords) return null;

        const initials = c.name
          .split(' ').map(w => w[0] ?? '').join('').toUpperCase().slice(0, 2)
          || c.name.slice(0, 2).toUpperCase();

        // Multi-line selection highlight — render per-line rectangles
        const selectionEls: React.ReactNode[] = [];
        if (c.anchor != null && c.anchor !== c.head) {
          const startPos = Math.min(c.anchor, c.head);
          const endPos = Math.max(c.anchor, c.head);
          // Walk through positions to find line breaks and render per-line rects
          try {
            const editorDom = editorView.dom as HTMLElement;
            const editorWidth = editorDom.offsetWidth;
            let pos = startPos;
            while (pos <= endPos) {
              const lineStart = getCoords(editorView, pos, containerEl);
              if (!lineStart) break;
              // Find end of this line — scan forward until y coordinate changes
              let lineEndPos = pos;
              const lineY = lineStart.top;
              for (let p = pos + 1; p <= endPos; p++) {
                const pc = getCoords(editorView, p, containerEl);
                if (!pc || Math.abs(pc.top - lineY) > 2) break;
                lineEndPos = p;
              }
              const lineEnd = getCoords(editorView, lineEndPos, containerEl);
              if (lineEnd) {
                const left = pos === startPos ? lineStart.left : 0;
                const right = lineEndPos === endPos ? lineEnd.left + 4 : editorWidth;
                selectionEls.push(
                  <div
                    key={`sel-${c.clientId}-${pos}`}
                    style={{
                      position: 'absolute',
                      top: lineY,
                      left,
                      width: Math.max(right - left, 4),
                      height: lineStart.height || 18,
                      background: c.color,
                      opacity: 0.12,
                      borderRadius: 2,
                      pointerEvents: 'none',
                      zIndex: 5,
                    }}
                  />
                );
              }
              // Move to next line
              pos = lineEndPos + 1;
            }
          } catch {
            // fallback: skip selection rendering
          }
        }

        return (
          <div key={c.clientId} style={{ pointerEvents: 'none' }}>
            {selectionEls}
            {/* Cursor caret — semi-transparent ghost */}
            <div
              style={{
                position: 'absolute',
                top: coords.top,
                left: coords.left - 1,
                width: 2,
                height: coords.height || 18,
                background: c.color,
                opacity: 0.4,
                borderRadius: 1,
                pointerEvents: 'none',
                zIndex: 10,
                animation: 'cursorBlink 1.2s ease-in-out infinite',
              }}
            />
            {/* Ghost glow — very subtle */}
            <div
              style={{
                position: 'absolute',
                top: coords.top,
                left: coords.left - 4,
                width: 8,
                height: coords.height || 18,
                background: c.color,
                opacity: 0.06,
                borderRadius: 4,
                pointerEvents: 'none',
                zIndex: 9,
              }}
            />
            {/* Name badge — semi-transparent */}
            <div
              style={{
                position: 'absolute',
                top: coords.top - 18,
                left: coords.left - 2,
                background: c.color,
                color: '#fff',
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: '4px 4px 4px 0',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 11,
                opacity: 0.55,
                boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
              }}
              title={c.name}
            >
              {initials}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function TiptapEditor({
  fragment,
  ydoc,
  provider,
  user,
  editable = true,
  placeholder: placeholderText = 'Start typing...',
  sectionId,
  onUpdateCursorInfo,
  extensions: extraExtensions,
}: TiptapEditorProps) {
  // Deliberately memoized on [ydoc, fragment] ONLY. `placeholderText` and
  // `extraExtensions` are read from the closure of whichever render last ran
  // this factory, so a caller passing an inline array gets a stable editor
  // instead of a collab session that is destroyed and rebuilt on every parent
  // render. See the `extensions` prop docs for the stability contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allExtensions = useMemo(() => [
    // `history` is the v2 key, `undoRedo` the v3 key for the same StarterKit
    // sub-extension; passing both disables ProseMirror's local undo stack on
    // either major, which is required when Collaboration supplies its own.
    StarterKit.configure({ history: false, undoRedo: false } as any),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: placeholderText }),
    Collaboration.configure({ document: ydoc, fragment }),
    ...(extraExtensions ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [ydoc, fragment]);

  const editor = useEditor({
    extensions: allExtensions,
    editable,
  }, [allExtensions]);

  // `editable` above only applies at CONSTRUCTION. Pushing it onto a live
  // editor is this effect's whole job, and without it finalizing a document
  // was cosmetic for anyone who already had the page open: the banner said
  // read-only while the caret kept working, and the lock only took hold on a
  // reload.
  //
  // Three things stack up to make the prop alone insufficient:
  //   - useEditor is called with a NON-EMPTY deps array, and @tiptap/react
  //     only pushes changed options onto a live editor when deps is empty;
  //     otherwise it early-returns when the deps have not changed.
  //   - even on the empty-deps path Tiptap deliberately pins
  //     `editable: this.editor.isEditable`, so it never syncs this option
  //     from props by design.
  //   - callers key their lists on the section id, so nothing remounts.
  //
  // NOTE ON SCOPE: this stops LOCAL input. It does not make the document
  // read-only — ySync applies remote updates by dispatching transactions
  // programmatically, and ProseMirror's `editable` gates user input, not
  // dispatch. A collaborator on an older client, or the still-live mutation
  // API, can change a finalized document regardless. Real enforcement has to
  // be server-side.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // ---- Custom cursor overlay using awareness directly ----
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursorInfo[]>([]);
  const editorAreaRef = useRef<HTMLDivElement>(null);

  // Merge local awareness user info via the centralized updater (if provided)
  // or fall back to a merge-safe direct write.
  useEffect(() => {
    if (onUpdateCursorInfo) {
      onUpdateCursorInfo(user.name, user.color);
    } else if (provider?.awareness) {
      // Fallback for standalone usage (e.g. ReaderMode) — merge, don't overwrite.
      const currentState = provider.awareness.getLocalState();
      const existingUser = (currentState?.user as Record<string, unknown>) || {};
      provider.awareness.setLocalStateField('user', {
        ...existingUser,
        name: user.name,
        color: user.color,
      });
    }
  }, [provider, user, onUpdateCursorInfo]);

  // Listen for awareness changes and extract cursor positions
  const updateCursors = useCallback(() => {
    if (!provider?.awareness || !editor?.view) return;

    const states = provider.awareness.getStates();
    const localClientId = provider.awareness.clientID;
    const cursors: RemoteCursorInfo[] = [];

    states.forEach((state: any, clientId: number) => {
      if (clientId === localClientId) return;
      const u = state.user;
      if (!u || !state.cursor) return;
      // Only show cursors in this section's editor
      if (sectionId && state.cursor.sectionId !== sectionId) return;

      try {
        const ystate = ySyncPluginKey.getState(editor.view.state);
        if (!ystate?.type || !ystate?.binding?.mapping) return;

        const anchor = relativePositionToAbsolutePosition(
          ystate.doc, ystate.type,
          Y.createRelativePositionFromJSON(state.cursor.anchor),
          ystate.binding.mapping
        );
        const head = relativePositionToAbsolutePosition(
          ystate.doc, ystate.type,
          Y.createRelativePositionFromJSON(state.cursor.head),
          ystate.binding.mapping
        );

        cursors.push({
          clientId,
          name: u.name || `User ${clientId}`,
          color: u.color || '#3b82f6',
          anchor,
          head,
        });
      } catch {
        // ySyncPlugin not ready yet
      }
    });

    setRemoteCursors(cursors);
    // `sectionId` is read above to filter peers down to this section's editor.
    // Without it here the callback keeps the id it was created with, so after a
    // section change the overlay draws the OLD section's carets and hides the
    // new one's — exactly inverted.
  }, [provider, editor, sectionId]);

  // Update local cursor position in awareness when selection changes
  useEffect(() => {
    if (!editor?.view || !provider?.awareness) return;

    const handleTransaction = () => {
      try {
        const ystate = ySyncPluginKey.getState(editor.view.state);
        if (!ystate?.type || !ystate?.binding?.mapping) return;

        const { anchor, head } = editor.view.state.selection;
        const yAnchor = absolutePositionToRelativePosition(anchor, ystate.type, ystate.binding.mapping);
        const yHead = absolutePositionToRelativePosition(head, ystate.type, ystate.binding.mapping);

        provider.awareness.setLocalStateField('cursor', { anchor: yAnchor, head: yHead, sectionId });
      } catch {
        // ySyncPlugin not ready
      }
    };

    // Only listen to selectionUpdate — NOT 'update' which fires for remote
    // changes too and creates a feedback loop (remote update → cursor send →
    // server broadcast → all editors react → repeat).
    editor.on('selectionUpdate', handleTransaction);
    // Send initial position
    handleTransaction();

    return () => {
      editor.off('selectionUpdate', handleTransaction);
      // Clear the caret we published. Without this it survives in awareness
      // pointing into a section that no longer exists, so peers keep drawing a
      // ghost until awareness times this client out — or indefinitely, if the
      // client stays connected and simply stops moving. setLocalStateField
      // touches only `cursor`; identity/presence written by the host page and
      // by `onUpdateCursorInfo` are left alone.
      provider.awareness.setLocalStateField('cursor', null);
    };
  }, [editor, provider, sectionId]);

  // Listen for remote awareness changes — only on awareness 'change', NOT editor 'update'
  useEffect(() => {
    if (!provider?.awareness) return;
    const handler = () => updateCursors();
    provider.awareness.on('change', handler);
    return () => {
      provider.awareness.off('change', handler);
    };
  }, [provider, updateCursors]);

  return (
    <div style={editable ? wrapperStyleEditable : wrapperStyleReadOnly}>
      {editable && <EditorToolbar editor={editor} />}
      <div ref={editorAreaRef} style={editorAreaStyle}>
        <EditorContent editor={editor} />
        {/* Custom cursor overlay — rendered as React elements, not ProseMirror decorations */}
        <CursorOverlay cursors={remoteCursors} editorView={editor?.view} containerEl={editorAreaRef.current} />
      </div>
    </div>
  );
}
