"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = EditorToolbar;
const jsx_runtime_1 = require("react/jsx-runtime");
const buttons = [
    {
        label: 'B',
        action: (e) => { e.chain().focus().toggleBold().run(); },
        isActive: (e) => e.isActive('bold'),
    },
    {
        label: 'I',
        action: (e) => { e.chain().focus().toggleItalic().run(); },
        isActive: (e) => e.isActive('italic'),
    },
    {
        label: 'S',
        action: (e) => { e.chain().focus().toggleStrike().run(); },
        isActive: (e) => e.isActive('strike'),
    },
    {
        label: '</>',
        action: (e) => { e.chain().focus().toggleCode().run(); },
        isActive: (e) => e.isActive('code'),
    },
    {
        label: 'H1',
        action: (e) => { e.chain().focus().toggleHeading({ level: 1 }).run(); },
        isActive: (e) => e.isActive('heading', { level: 1 }),
    },
    {
        label: 'H2',
        action: (e) => { e.chain().focus().toggleHeading({ level: 2 }).run(); },
        isActive: (e) => e.isActive('heading', { level: 2 }),
    },
    {
        label: 'H3',
        action: (e) => { e.chain().focus().toggleHeading({ level: 3 }).run(); },
        isActive: (e) => e.isActive('heading', { level: 3 }),
    },
    {
        label: 'Bullet',
        action: (e) => { e.chain().focus().toggleBulletList().run(); },
        isActive: (e) => e.isActive('bulletList'),
    },
    {
        label: 'Ordered',
        action: (e) => { e.chain().focus().toggleOrderedList().run(); },
        isActive: (e) => e.isActive('orderedList'),
    },
    {
        label: 'Task',
        action: (e) => { e.chain().focus().toggleTaskList().run(); },
        isActive: (e) => e.isActive('taskList'),
    },
    {
        label: 'Quote',
        action: (e) => { e.chain().focus().toggleBlockquote().run(); },
        isActive: (e) => e.isActive('blockquote'),
    },
    {
        label: 'Code Block',
        action: (e) => { e.chain().focus().toggleCodeBlock().run(); },
        isActive: (e) => e.isActive('codeBlock'),
    },
    {
        label: 'HR',
        action: (e) => { e.chain().focus().setHorizontalRule().run(); },
        isActive: () => false,
    },
];
const toolbarStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: '6px 8px',
    borderBottom: '1px solid #e2e8f0',
    background: '#f8fafc',
    borderRadius: '8px 8px 0 0',
};
const btnBase = {
    padding: '4px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    border: '1px solid #cbd5e1',
    borderRadius: 4,
    cursor: 'pointer',
    lineHeight: 1.4,
};
function EditorToolbar({ editor }) {
    if (!editor)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { style: toolbarStyle, children: buttons.map((btn) => {
            const active = btn.isActive(editor);
            return ((0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => btn.action(editor), style: {
                    ...btnBase,
                    background: active ? '#3b82f6' : '#fff',
                    color: active ? '#fff' : '#334155',
                }, title: btn.label, children: btn.label }, btn.label));
        }) }));
}
//# sourceMappingURL=EditorToolbar.js.map