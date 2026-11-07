/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/SharedTextEditor.test.tsx
//
// 0.146.0 (package 11): the shared document's content is written by every
// collaborator, so the editor renders it as text. Before, it assigned the
// content to innerHTML and anyone with write access to the document could run
// script in every reader's page. DOMPurify is not a dependency of this
// package, so the editor is a plain-text surface (the HTML formatting
// toolbar went with it).

import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react';
import { SharedTextEditor } from '../../src/client/SharedTextEditor';

const PAYLOAD = '<img src="x" onerror="window.__pwned = 1"><b onclick="x()">bold</b>';

function editorOf(container: HTMLElement): HTMLElement {
    const el = container.querySelector('[contenteditable]');
    if (!el) throw new Error('no editor surface');
    return el as HTMLElement;
}

function handlerAttributes(root: HTMLElement): string[] {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) if (/^on/i.test(attr.name)) out.push(`${el.tagName}.${attr.name}`);
    }
    return out;
}

describe('SharedTextEditor renders shared content as text', () => {
    it('an <img onerror> payload leaves no element and no handler attribute in the DOM', () => {
        const { container } = render(<SharedTextEditor content={PAYLOAD} applyLocalEdit={() => undefined} />);
        const editor = editorOf(container);
        expect(editor.querySelector('img')).toBeNull();
        expect(editor.querySelector('b')).toBeNull();
        expect(handlerAttributes(container)).toEqual([]);
        expect(editor.textContent).toBe(PAYLOAD);
        expect((window as any).__pwned).toBeUndefined();
    });

    it('stays text when the content changes remotely', () => {
        const { container, rerender } = render(<SharedTextEditor content="hello" applyLocalEdit={() => undefined} />);
        rerender(<SharedTextEditor content={PAYLOAD} applyLocalEdit={() => undefined} />);
        expect(editorOf(container).children).toHaveLength(0);
        expect(handlerAttributes(container)).toEqual([]);
    });

    it('sends local edits as text', () => {
        const edits: string[] = [];
        const { container } = render(<SharedTextEditor content="" applyLocalEdit={(t) => edits.push(t)} />);
        const editor = editorOf(container);
        editor.textContent = 'a <script>x</script> b';
        fireEvent.input(editor);
        expect(edits[edits.length - 1]).toBe('a <script>x</script> b');
    });
});
