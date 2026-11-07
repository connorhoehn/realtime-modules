"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedTextEditor = SharedTextEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
// realtime-modules/src/client/SharedTextEditor.tsx
//
// Lifted from frontend/src/components/SharedTextEditor.tsx. A plain-text
// editing surface bound to useCRDT content and applyLocalEdit
// (contentEditable — no Tiptap dependency).
//
// TEXT, NOT HTML (0.146.0)
// ------------------------
// The content is written by every collaborator on the document. This editor
// used to assign it to `innerHTML`, so anyone who could write to a document
// could run script in the page of everyone who opened it (an
// `<img onerror>` was enough). Sanitising HTML safely needs a real sanitiser
// (DOMPurify), which this package does not depend on, so the surface is plain
// text instead: remote content is set as `textContent`, local edits are sent
// as the surface's text, and the HTML formatting toolbar is gone. A document
// that holds HTML from an older version shows its markup as literal text.
// For rich text use the Tiptap adapter (`adapters/tiptap`).
const react_1 = require("react");
/** The editable surface's text, with line breaks where the browser renders them. */
function surfaceText(el) {
    const inner = el.innerText;
    return typeof inner === 'string' ? inner : (el.textContent ?? '');
}
function SharedTextEditor({ content, applyLocalEdit, disabled = false, hasConflict = false, onDismissConflict }) {
    const editorRef = (0, react_1.useRef)(null);
    const internalChange = (0, react_1.useRef)(false);
    // Sync remote CRDT changes into the editor without clobbering cursor
    // position. As text: the content is never parsed as HTML.
    (0, react_1.useEffect)(() => {
        if (!editorRef.current || internalChange.current)
            return;
        if (surfaceText(editorRef.current) !== content) {
            editorRef.current.textContent = content;
        }
    }, [content]);
    const flush = () => {
        if (!editorRef.current)
            return;
        internalChange.current = true;
        applyLocalEdit(surfaceText(editorRef.current));
        setTimeout(() => { internalChange.current = false; }, 0);
    };
    return ((0, jsx_runtime_1.jsxs)("div", { children: [hasConflict && ((0, jsx_runtime_1.jsxs)("div", { style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    marginBottom: '0.5rem',
                    background: '#fefce8',
                    border: '1px solid #fde68a',
                    borderRadius: 4,
                    fontSize: '0.8rem',
                    color: '#92400e',
                }, children: [(0, jsx_runtime_1.jsx)("span", { children: "Edits merged \u2014 your changes are preserved" }), (0, jsx_runtime_1.jsx)("button", { onClick: onDismissConflict, "aria-label": "Dismiss conflict indicator", style: {
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '1rem',
                            color: '#92400e',
                            padding: '0 0 0 12px',
                            lineHeight: 1,
                        }, children: "x" })] })), (0, jsx_runtime_1.jsx)("div", { ref: editorRef, 
                // Pasted HTML lands as text too, where the browser supports it.
                contentEditable: disabled ? false : 'plaintext-only', suppressContentEditableWarning: true, onInput: flush, style: {
                    minHeight: 180,
                    border: '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.9rem',
                    fontFamily: 'inherit',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    outline: 'none',
                    overflowY: 'auto',
                    // Tokens, not literals: this contenteditable was the last light
                    // surface on /previews in dark mode. Fallbacks are the previous
                    // literals, so light mode is byte-identical.
                    background: disabled
                        ? 'var(--color-surface-inset, #f8fafc)'
                        : 'var(--color-surface, #ffffff)',
                    color: 'var(--color-text-primary, #1e293b)',
                } }), disabled && ((0, jsx_runtime_1.jsx)("p", { style: { color: '#9ca3af', margin: '0.25rem 0 0', fontSize: '0.8rem' }, children: "Disconnected \u2014 reconnect to edit" }))] }));
}
//# sourceMappingURL=SharedTextEditor.js.map