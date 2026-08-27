"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedTextEditor = SharedTextEditor;
const jsx_runtime_1 = require("react/jsx-runtime");
// realtime-modules/src/client/SharedTextEditor.tsx
//
// Lifted verbatim from frontend/src/components/SharedTextEditor.tsx.
// WYSIWYG rich text editor bound to useCRDT content and applyLocalEdit
// (contentEditable surface — no Tiptap dependency).
const react_1 = require("react");
const TOOLBAR = [
    { cmd: 'bold', label: 'B', title: 'Bold' },
    { cmd: 'italic', label: 'I', title: 'Italic' },
    { cmd: 'underline', label: 'U', title: 'Underline' },
    { cmd: 'strikeThrough', label: 'S', title: 'Strikethrough' },
    { cmd: 'insertOrderedList', label: '1.', title: 'Ordered list' },
    { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
    { cmd: 'justifyLeft', label: '≡L', title: 'Align left' },
    { cmd: 'justifyCenter', label: '≡C', title: 'Align center' },
    { cmd: 'justifyRight', label: '≡R', title: 'Align right' },
];
const btnStyle = {
    padding: '3px 8px',
    fontSize: '0.75rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    border: '1px solid #d1d5db',
    borderRadius: 4,
    background: '#f9fafb',
    color: '#374151',
    cursor: 'pointer',
    lineHeight: '1.5',
};
function SharedTextEditor({ content, applyLocalEdit, disabled = false, hasConflict = false, onDismissConflict }) {
    const editorRef = (0, react_1.useRef)(null);
    const internalChange = (0, react_1.useRef)(false);
    // Sync remote CRDT changes into the editor without clobbering cursor position
    (0, react_1.useEffect)(() => {
        if (!editorRef.current || internalChange.current)
            return;
        if (editorRef.current.innerHTML !== content) {
            editorRef.current.innerHTML = content;
        }
    }, [content]);
    const exec = (cmd) => {
        document.execCommand(cmd, false);
        editorRef.current?.focus();
        flush();
    };
    const flush = () => {
        if (!editorRef.current)
            return;
        internalChange.current = true;
        applyLocalEdit(editorRef.current.innerHTML);
        setTimeout(() => { internalChange.current = false; }, 0);
    };
    return ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("div", { style: { display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }, children: [TOOLBAR.map(({ cmd, label, title }) => ((0, jsx_runtime_1.jsx)("button", { onMouseDown: (e) => { e.preventDefault(); exec(cmd); }, disabled: disabled, title: title, style: btnStyle, children: label }, cmd))), (0, jsx_runtime_1.jsx)("div", { style: { width: 1, alignSelf: 'stretch', background: '#e2e8f0', margin: '0 4px' } }), (0, jsx_runtime_1.jsxs)("select", { onChange: (e) => { document.execCommand('formatBlock', false, e.target.value); flush(); }, disabled: disabled, style: { fontSize: '0.75rem', border: '1px solid #d1d5db', borderRadius: 4, padding: '3px 6px', background: '#f9fafb', color: '#374151' }, children: [(0, jsx_runtime_1.jsx)("option", { value: "p", children: "Paragraph" }), (0, jsx_runtime_1.jsx)("option", { value: "h1", children: "H1" }), (0, jsx_runtime_1.jsx)("option", { value: "h2", children: "H2" }), (0, jsx_runtime_1.jsx)("option", { value: "h3", children: "H3" }), (0, jsx_runtime_1.jsx)("option", { value: "pre", children: "Code" })] })] }), hasConflict && ((0, jsx_runtime_1.jsxs)("div", { style: {
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
                        }, children: "x" })] })), (0, jsx_runtime_1.jsx)("div", { ref: editorRef, contentEditable: !disabled, suppressContentEditableWarning: true, onInput: flush, style: {
                    minHeight: 180,
                    border: '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.9rem',
                    fontFamily: 'inherit',
                    lineHeight: 1.6,
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