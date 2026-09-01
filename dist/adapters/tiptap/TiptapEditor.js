"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = TiptapEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
// realtime-modules/src/adapters/tiptap/TiptapEditor.tsx
//
// Lifted verbatim from frontend/src/components/doc-editor/TiptapEditor.tsx.
// Reusable Tiptap editor with Y.js collaboration and custom cursor overlay.
// Uses awareness protocol for cursor positions, rendered as a React overlay
// instead of the broken yCursorPlugin/CollaborationCursor extension.
const react_1 = require("react");
const react_2 = require("@tiptap/react");
const starter_kit_1 = __importDefault(require("@tiptap/starter-kit"));
const extension_task_list_1 = __importDefault(require("@tiptap/extension-task-list"));
const extension_task_item_1 = __importDefault(require("@tiptap/extension-task-item"));
const extension_placeholder_1 = __importDefault(require("@tiptap/extension-placeholder"));
const extension_collaboration_1 = __importDefault(require("@tiptap/extension-collaboration"));
const Y = __importStar(require("yjs"));
// Must import from @tiptap/y-tiptap (not y-prosemirror) because Tiptap's
// Collaboration extension uses its own PluginKey instance from this package.
// Using y-prosemirror's key would never match the actual sync plugin state.
const y_tiptap_1 = require("@tiptap/y-tiptap");
const EditorToolbar_1 = __importDefault(require("./EditorToolbar"));
// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const wrapperStyleEditable = {
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
};
const wrapperStyleReadOnly = {
    position: 'relative',
};
const editorAreaStyle = {
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
function getCoords(view, pos, containerEl) {
    try {
        if (pos < 0 || pos > view.state.doc.content.size)
            return null;
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
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// @mention suggestion popup helper (vanilla DOM — required by Tiptap API)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Cursor Overlay Component
// ---------------------------------------------------------------------------
function CursorOverlay({ cursors, editorView, containerEl }) {
    if (!editorView)
        return null;
    return ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: cursors.map((c) => {
            if (c.head == null)
                return null;
            const coords = getCoords(editorView, c.head, containerEl);
            if (!coords)
                return null;
            const initials = c.name
                .split(' ').map(w => w[0] ?? '').join('').toUpperCase().slice(0, 2)
                || c.name.slice(0, 2).toUpperCase();
            // Multi-line selection highlight — render per-line rectangles
            const selectionEls = [];
            if (c.anchor != null && c.anchor !== c.head) {
                const startPos = Math.min(c.anchor, c.head);
                const endPos = Math.max(c.anchor, c.head);
                // Walk through positions to find line breaks and render per-line rects
                try {
                    const editorDom = editorView.dom;
                    const editorWidth = editorDom.offsetWidth;
                    let pos = startPos;
                    while (pos <= endPos) {
                        const lineStart = getCoords(editorView, pos, containerEl);
                        if (!lineStart)
                            break;
                        // Find end of this line — scan forward until y coordinate changes
                        let lineEndPos = pos;
                        const lineY = lineStart.top;
                        for (let p = pos + 1; p <= endPos; p++) {
                            const pc = getCoords(editorView, p, containerEl);
                            if (!pc || Math.abs(pc.top - lineY) > 2)
                                break;
                            lineEndPos = p;
                        }
                        const lineEnd = getCoords(editorView, lineEndPos, containerEl);
                        if (lineEnd) {
                            const left = pos === startPos ? lineStart.left : 0;
                            const right = lineEndPos === endPos ? lineEnd.left + 4 : editorWidth;
                            selectionEls.push((0, jsx_runtime_1.jsx)("div", { style: {
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
                                } }, `sel-${c.clientId}-${pos}`));
                        }
                        // Move to next line
                        pos = lineEndPos + 1;
                    }
                }
                catch {
                    // fallback: skip selection rendering
                }
            }
            return ((0, jsx_runtime_1.jsxs)("div", { style: { pointerEvents: 'none' }, children: [selectionEls, (0, jsx_runtime_1.jsx)("div", { style: {
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
                        } }), (0, jsx_runtime_1.jsx)("div", { style: {
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
                        } }), (0, jsx_runtime_1.jsx)("div", { style: {
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
                        }, title: c.name, children: initials })] }, c.clientId));
        }) }));
}
// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
function TiptapEditor({ fragment, ydoc, provider, user, editable = true, placeholder: placeholderText = 'Start typing...', sectionId, onUpdateCursorInfo, extensions: extraExtensions, }) {
    // Deliberately memoized on [ydoc, fragment] ONLY. `placeholderText` and
    // `extraExtensions` are read from the closure of whichever render last ran
    // this factory, so a caller passing an inline array gets a stable editor
    // instead of a collab session that is destroyed and rebuilt on every parent
    // render. See the `extensions` prop docs for the stability contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allExtensions = (0, react_1.useMemo)(() => [
        // `history` is the v2 key, `undoRedo` the v3 key for the same StarterKit
        // sub-extension; passing both disables ProseMirror's local undo stack on
        // either major, which is required when Collaboration supplies its own.
        starter_kit_1.default.configure({ history: false, undoRedo: false }),
        extension_task_list_1.default,
        extension_task_item_1.default.configure({ nested: true }),
        extension_placeholder_1.default.configure({ placeholder: placeholderText }),
        extension_collaboration_1.default.configure({ document: ydoc, fragment }),
        ...(extraExtensions ?? []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ], [ydoc, fragment]);
    const editor = (0, react_2.useEditor)({
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
    (0, react_1.useEffect)(() => {
        if (!editor || editor.isDestroyed)
            return;
        if (editor.isEditable !== editable)
            editor.setEditable(editable);
    }, [editor, editable]);
    // ---- Custom cursor overlay using awareness directly ----
    const [remoteCursors, setRemoteCursors] = (0, react_1.useState)([]);
    const editorAreaRef = (0, react_1.useRef)(null);
    // Merge local awareness user info via the centralized updater (if provided)
    // or fall back to a merge-safe direct write.
    (0, react_1.useEffect)(() => {
        if (onUpdateCursorInfo) {
            onUpdateCursorInfo(user.name, user.color);
        }
        else if (provider?.awareness) {
            // Fallback for standalone usage (e.g. ReaderMode) — merge, don't overwrite.
            const currentState = provider.awareness.getLocalState();
            const existingUser = currentState?.user || {};
            provider.awareness.setLocalStateField('user', {
                ...existingUser,
                name: user.name,
                color: user.color,
            });
        }
    }, [provider, user, onUpdateCursorInfo]);
    // Listen for awareness changes and extract cursor positions
    const updateCursors = (0, react_1.useCallback)(() => {
        if (!provider?.awareness || !editor?.view)
            return;
        const states = provider.awareness.getStates();
        const localClientId = provider.awareness.clientID;
        const cursors = [];
        states.forEach((state, clientId) => {
            if (clientId === localClientId)
                return;
            const u = state.user;
            if (!u || !state.cursor)
                return;
            // Only show cursors in this section's editor
            if (sectionId && state.cursor.sectionId !== sectionId)
                return;
            try {
                const ystate = y_tiptap_1.ySyncPluginKey.getState(editor.view.state);
                if (!ystate?.type || !ystate?.binding?.mapping)
                    return;
                const anchor = (0, y_tiptap_1.relativePositionToAbsolutePosition)(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(state.cursor.anchor), ystate.binding.mapping);
                const head = (0, y_tiptap_1.relativePositionToAbsolutePosition)(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(state.cursor.head), ystate.binding.mapping);
                cursors.push({
                    clientId,
                    name: u.name || `User ${clientId}`,
                    color: u.color || '#3b82f6',
                    anchor,
                    head,
                });
            }
            catch {
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
    (0, react_1.useEffect)(() => {
        if (!editor?.view || !provider?.awareness)
            return;
        const handleTransaction = () => {
            try {
                const ystate = y_tiptap_1.ySyncPluginKey.getState(editor.view.state);
                if (!ystate?.type || !ystate?.binding?.mapping)
                    return;
                const { anchor, head } = editor.view.state.selection;
                const yAnchor = (0, y_tiptap_1.absolutePositionToRelativePosition)(anchor, ystate.type, ystate.binding.mapping);
                const yHead = (0, y_tiptap_1.absolutePositionToRelativePosition)(head, ystate.type, ystate.binding.mapping);
                provider.awareness.setLocalStateField('cursor', { anchor: yAnchor, head: yHead, sectionId });
            }
            catch {
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
    (0, react_1.useEffect)(() => {
        if (!provider?.awareness)
            return;
        const handler = () => updateCursors();
        provider.awareness.on('change', handler);
        return () => {
            provider.awareness.off('change', handler);
        };
    }, [provider, updateCursors]);
    return ((0, jsx_runtime_1.jsxs)("div", { style: editable ? wrapperStyleEditable : wrapperStyleReadOnly, children: [editable && (0, jsx_runtime_1.jsx)(EditorToolbar_1.default, { editor: editor }), (0, jsx_runtime_1.jsxs)("div", { ref: editorAreaRef, style: editorAreaStyle, children: [(0, jsx_runtime_1.jsx)(react_2.EditorContent, { editor: editor }), (0, jsx_runtime_1.jsx)(CursorOverlay, { cursors: remoteCursors, editorView: editor?.view, containerEl: editorAreaRef.current })] })] }));
}
//# sourceMappingURL=TiptapEditor.js.map