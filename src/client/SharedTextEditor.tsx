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

import { useRef, useEffect } from 'react';

export interface SharedTextEditorProps {
  content: string;
  applyLocalEdit: (newText: string) => void;
  disabled?: boolean;
  hasConflict?: boolean;
  onDismissConflict?: () => void;
}

/** The editable surface's text, with line breaks where the browser renders them. */
function surfaceText(el: HTMLElement): string {
  const inner = (el as HTMLElement & { innerText?: string }).innerText;
  return typeof inner === 'string' ? inner : (el.textContent ?? '');
}

export function SharedTextEditor({ content, applyLocalEdit, disabled = false, hasConflict = false, onDismissConflict }: SharedTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const internalChange = useRef(false);

  // Sync remote CRDT changes into the editor without clobbering cursor
  // position. As text: the content is never parsed as HTML.
  useEffect(() => {
    if (!editorRef.current || internalChange.current) return;
    if (surfaceText(editorRef.current) !== content) {
      editorRef.current.textContent = content;
    }
  }, [content]);

  const flush = () => {
    if (!editorRef.current) return;
    internalChange.current = true;
    applyLocalEdit(surfaceText(editorRef.current));
    setTimeout(() => { internalChange.current = false; }, 0);
  };

  return (
    <div>
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
        // Pasted HTML lands as text too, where the browser supports it.
        contentEditable={disabled ? false : 'plaintext-only'}
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
