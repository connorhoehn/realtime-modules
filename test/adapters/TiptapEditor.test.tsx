/** @jest-environment jsdom */
//
// Regression tests for the Tiptap adapter every consuming app renders.
// Covers the downstream extension seam plus two awareness/cursor defects.

import React from 'react';
import { render, act } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Extension, Mark } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import TiptapEditor from '../../src/adapters/tiptap/TiptapEditor';

jest.setTimeout(20_000);

// A relative position pointing at the head of the shared fragment. Shaped the
// way the adapter itself writes cursors into awareness.
const REL_POS = { type: null, tname: 'default', item: null, assoc: -1 };

function makeDoc() {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  const awareness = new Awareness(ydoc);
  return { ydoc, fragment, awareness, provider: { awareness } as any };
}

const PEER_ID = 999;

function setPeerCursor(awareness: Awareness, sectionId?: string) {
  (awareness as any).states.set(PEER_ID, {
    user: { name: 'Peer One', color: '#ff0000' },
    cursor: { anchor: REL_POS, head: REL_POS, sectionId },
  });
  awareness.emit('change', [{ added: [], updated: [PEER_ID], removed: [] }, 'local']);
}

function removePeer(awareness: Awareness) {
  (awareness as any).states.delete(PEER_ID);
  awareness.emit('change', [{ added: [], updated: [], removed: [PEER_ID] }, 'local']);
}

/** Remote-caret name badges currently painted by the overlay. */
const peerCarets = (c: HTMLElement) => c.querySelectorAll('[title="Peer One"]').length;

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

// ---------------------------------------------------------------------------
// Task 1 — downstream extension seam
// ---------------------------------------------------------------------------

describe('extensions prop (downstream seam)', () => {
  it('appends caller extensions to the built-in list and puts their marks in the schema', async () => {
    const { ydoc, fragment, provider } = makeDoc();
    let editor: Editor | null = null;
    const Redline = Mark.create({
      name: 'redline',
      onCreate() { editor = this.editor as Editor; },
    });

    render(
      <TiptapEditor
        fragment={fragment} ydoc={ydoc} provider={provider}
        user={{ name: 'A', color: '#fff' }}
        extensions={[Redline]}
      />,
    );
    await settle();

    expect(editor).not.toBeNull();
    // Schema-affecting extension actually reached ProseMirror's schema, which
    // is the whole point: marks cannot be added after construction.
    expect(Object.keys(editor!.schema.marks)).toContain('redline');
    // ...and the built-ins are untouched.
    expect(Object.keys(editor!.schema.nodes)).toEqual(expect.arrayContaining(['taskList', 'taskItem']));
  });

  it('does NOT tear down the editor when a re-render passes a fresh-but-equivalent array', async () => {
    const { ydoc, fragment, provider } = makeDoc();
    let creations = 0;
    let destructions = 0;
    // A fresh extension INSTANCE each render, in a fresh array — i.e. the worst
    // case a consumer writing `extensions={[Foo.configure(...)]}` inline hands us.
    const makeExtensions = () => [
      Extension.create({
        name: 'creationCounter',
        onCreate() { creations += 1; },
        onDestroy() { destructions += 1; },
      }),
    ];

    const props = {
      fragment, ydoc, provider,
      user: { name: 'A', color: '#fff' },
    };
    const { rerender } = render(<TiptapEditor {...props} extensions={makeExtensions()} />);
    await settle();
    expect(creations).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        rerender(<TiptapEditor {...props} extensions={makeExtensions()} />);
      });
      await settle();
    }

    // One editor, start to finish: the collab session survived the re-renders.
    expect(creations).toBe(1);
    expect(destructions).toBe(0);
  });

  it('is purely additive — omitting the prop leaves the built-in editor intact', async () => {
    const { ydoc, fragment, provider } = makeDoc();
    const { container } = render(
      <TiptapEditor fragment={fragment} ydoc={ydoc} provider={provider} user={{ name: 'A', color: '#fff' }} />,
    );
    await settle();
    expect(container.querySelector('.ProseMirror')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2(a) — ghost caret left in awareness on unmount
// ---------------------------------------------------------------------------

describe('cursor cleanup on unmount', () => {
  it('clears the awareness cursor field so peers stop drawing a ghost caret', async () => {
    const { ydoc, fragment, provider, awareness } = makeDoc();
    const { unmount } = render(
      <TiptapEditor
        fragment={fragment} ydoc={ydoc} provider={provider}
        user={{ name: 'A', color: '#fff' }} sectionId="s1"
      />,
    );
    await settle();
    // Precondition: the editor published a caret while mounted.
    expect(awareness.getLocalState()?.cursor).toBeTruthy();

    await act(async () => { unmount(); });

    expect(awareness.getLocalState()?.cursor).toBeNull();
    // Identity written by the host page must survive the cleanup.
    expect(awareness.getLocalState()?.user).toEqual({ name: 'A', color: '#fff' });
  });
});

// ---------------------------------------------------------------------------
// Task 2(b) — stale sectionId in the updateCursors closure
// ---------------------------------------------------------------------------

describe('sectionId filtering after a section change', () => {
  it('re-filters peers against the current sectionId, not the mount-time one', async () => {
    const { ydoc, fragment, provider, awareness } = makeDoc();
    const props = (sectionId: string) => ({
      fragment, ydoc, provider,
      user: { name: 'A', color: '#fff' },
      sectionId,
    });

    const { rerender, container } = render(<TiptapEditor {...props('s1')} />);
    await settle();

    await act(async () => { setPeerCursor(awareness, 's1'); });
    expect(peerCarets(container)).toBe(1); // baseline: same section, caret shows

    await act(async () => { removePeer(awareness); });
    await act(async () => { rerender(<TiptapEditor {...props('s2')} />); });
    await settle();

    // Peer is still in s1; this editor moved to s2 — it must NOT be drawn.
    await act(async () => { setPeerCursor(awareness, 's1'); });
    expect(peerCarets(container)).toBe(0);

    await act(async () => { removePeer(awareness); });
    // Peer joins s2 — it MUST be drawn.
    await act(async () => { setPeerCursor(awareness, 's2'); });
    expect(peerCarets(container)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — no global console patch, and no warning to suppress
// ---------------------------------------------------------------------------

describe('host console hygiene', () => {
  it('leaves console.warn untouched and emits no collaboration compat warning', async () => {
    const { ydoc, fragment, provider } = makeDoc();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        <TiptapEditor fragment={fragment} ydoc={ydoc} provider={provider} user={{ name: 'A', color: '#fff' }} />,
      );
      await settle();
      // If the module had monkey-patched console.warn at import time, the
      // adapter's wrapper — not the spy — would receive this call and the
      // matching warn would be swallowed before the spy ever saw it.
      const warnings = spy.mock.calls.map((c) => String(c[0]));
      expect(warnings.filter((w) => w.includes('extension-collaboration'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    // The spy restores to the pristine console.warn, not to a wrapper.
    expect(String(console.warn)).not.toContain('extension-collaboration');
  });
});
