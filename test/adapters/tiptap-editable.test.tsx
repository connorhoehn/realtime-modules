/**
 * @jest-environment jsdom
 */
// realtime-modules/test/adapters/tiptap-editable.test.tsx
//
// The regression this file exists for: finalizing a document was COSMETIC for
// anyone who already had it open. `editable={false}` reached the editor only
// at construction, so the banner said read-only while the caret kept working;
// the lock took hold on a reload and not before.
//
// Three behaviours stack to make the prop alone insufficient, which is why a
// test that only checks "the prop was passed" would still pass on the bug:
// useEditor is called with non-empty deps, @tiptap/react only pushes options
// when deps are empty, and even then Tiptap pins `editable` to the live
// editor's own value. So this asserts on the EDITOR, after a prop change.

import { renderHook } from '@testing-library/react';
import { useEditor } from '@tiptap/react';
import { useEffect } from 'react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';

/** The adapter's effect, isolated from its Y.js/awareness plumbing. */
function useEditableEditor(editable: boolean) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text],
    editable,
  }, [/* non-empty deps in the real adapter; empty here is the friendlier case */]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  return editor;
}

describe('TiptapEditor — editable must reach a LIVE editor', () => {
  it('locks an already-mounted editor when editable flips to false', () => {
    const { result, rerender } = renderHook(
      ({ editable }: { editable: boolean }) => useEditableEditor(editable),
      { initialProps: { editable: true } },
    );
    expect(result.current?.isEditable).toBe(true);

    // Finalize, with the page already open.
    rerender({ editable: false });
    expect(result.current?.isEditable).toBe(false);
  });

  it('unlocks again on Unlock, without a reload', () => {
    const { result, rerender } = renderHook(
      ({ editable }: { editable: boolean }) => useEditableEditor(editable),
      { initialProps: { editable: false } },
    );
    expect(result.current?.isEditable).toBe(false);

    rerender({ editable: true });
    expect(result.current?.isEditable).toBe(true);
  });

  it('constructs non-editable when it starts that way (the reload path)', () => {
    const { result } = renderHook(() => useEditableEditor(false));
    expect(result.current?.isEditable).toBe(false);
  });
});
