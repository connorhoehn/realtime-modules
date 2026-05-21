// realtime-modules/src/client/SharedTextEditor.tsx
//
// Lifted verbatim from frontend/src/components/SharedTextEditor.tsx.
// WYSIWYG rich text editor bound to useCRDT content and applyLocalEdit
// (contentEditable surface — no Tiptap dependency).

import { useRef, useEffect } from 'react';

export interface SharedTextEditorProps {
  content: string;
  applyLocalEdit: (newText: string) => void;
  disabled?: boolean;
  hasConflict?: boolean;
  onDismissConflict?: () => void;
}

const TOOLBAR: { cmd: string; label: string; title: string }[] = [
  { cmd: 'bold',                label: 'B',   title: 'Bold' },
  { cmd: 'italic',              label: 'I',   title: 'Italic' },
  { cmd: 'underline',           label: 'U',   title: 'Underline' },
  { cmd: 'strikeThrough',       label: 'S',   title: 'Strikethrough' },
  { cmd: 'insertOrderedList',   label: '1.',  title: 'Ordered list' },
  { cmd: 'insertUnorderedList', label: '•',   title: 'Bullet list' },
  { cmd: 'justifyLeft',         label: '≡L',  title: 'Align left' },
  { cmd: 'justifyCenter',       label: '≡C',  title: 'Align center' },
  { cmd: 'justifyRight',        label: '≡R',  title: 'Align right' },
];

const btnStyle: React.CSSProperties = {
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

export function SharedTextEditor({ content, applyLocalEdit, disabled = false, hasConflict = false, onDismissConflict }: SharedTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const internalChange = useRef(false);

  // Sync remote CRDT changes into the editor without clobbering cursor position
  useEffect(() => {
    if (!editorRef.current || internalChange.current) return;
    if (editorRef.current.innerHTML !== content) {
      editorRef.current.innerHTML = content;
    }
  }, [content]);

  const exec = (cmd: string) => {
    document.execCommand(cmd, false);
    editorRef.current?.focus();
    flush();
  };

  const flush = () => {
    if (!editorRef.current) return;
    internalChange.current = true;
    applyLocalEdit(editorRef.current.innerHTML);
    setTimeout(() => { internalChange.current = false; }, 0);
  };

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
        {TOOLBAR.map(({ cmd, label, title }) => (
          <button
            key={cmd}
            onMouseDown={(e) => { e.preventDefault(); exec(cmd); }}
            disabled={disabled}
            title={title}
            style={btnStyle}
          >
            {label}
          </button>
        ))}
        <div style={{ width: 1, alignSelf: 'stretch', background: '#e2e8f0', margin: '0 4px' }} />
        <select
          onChange={(e) => { document.execCommand('formatBlock', false, e.target.value); flush(); }}
          disabled={disabled}
          style={{ fontSize: '0.75rem', border: '1px solid #d1d5db', borderRadius: 4, padding: '3px 6px', background: '#f9fafb', color: '#374151' }}
        >
          <option value="p">Paragraph</option>
          <option value="h1">H1</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
          <option value="pre">Code</option>
        </select>
      </div>

      {/* CRDT-03: Merge conflict indicator */}
      {hasConflict && (
        <div style={{
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
        }}>
          <span>Edits merged — your changes are preserved</span>
          <button
            onClick={onDismissConflict}
            aria-label="Dismiss conflict indicator"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1rem',
              color: '#92400e',
              padding: '0 0 0 12px',
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Editor surface */}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={flush}
        style={{
          minHeight: 180,
          border: '1px solid #d1d5db',
          borderRadius: 4,
          padding: '0.5rem 0.75rem',
          fontSize: '0.9rem',
          fontFamily: 'inherit',
          lineHeight: 1.6,
          outline: 'none',
          overflowY: 'auto',
          background: disabled ? '#f8fafc' : '#ffffff',
          color: '#1e293b',
        }}
      />
      {disabled && (
        <p style={{ color: '#9ca3af', margin: '0.25rem 0 0', fontSize: '0.8rem' }}>
          Disconnected — reconnect to edit
        </p>
      )}
    </div>
  );
}
