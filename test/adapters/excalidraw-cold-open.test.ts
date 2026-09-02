// realtime-modules/test/adapters/excalidraw-cold-open.test.ts
//
// The regression this file exists for lost a whole diagram on every reload.
//
// A provider hands its Y.Doc to the app IMMEDIATELY — empty — and fills it in
// when the server's snapshot arrives some milliseconds later. So the binding is
// routinely constructed against a document that does not yet contain the scene.
// It used to respond by creating its own `elements` container and CAPTURING it
// for the rest of its life. When the snapshot then arrived carrying the real
// container under the same key, Yjs kept one of the two maps and detached the
// other, and the binding spent the session reading and writing an orphan.
//
// Verified in the browser before the fix: the `crdt:snapshot` frame for a real
// document held three rectangles under `excalidraw:<id> -> elements` while the
// canvas on screen was blank, and stayed blank through every reload.
//
// The two properties below are what make that impossible, and neither is
// visible in a test that constructs the binding after the document is already
// populated — which is why the existing convergence suite passed throughout.

import * as Y from 'yjs';
import {
    ExcalidrawYjsBinding,
    diagramRootName,
} from '../../src/adapters/excalidraw/ExcalidrawYjsBinding';
import type { DiagramElement } from '../../src/adapters/excalidraw/types';

const BLOCK = '6f9a8e2c-4b1d-4f0a-9c3e-7b2d5a1f8e04';

function el(id: string, props: Partial<DiagramElement> = {}): DiagramElement {
    return {
        id,
        type: 'rectangle',
        version: 1,
        versionNonce: 1,
        index: 'a1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        isDeleted: false,
        ...props,
    };
}

/** A document that already holds a drawn scene — i.e. what the server has. */
function drawnDoc(): Y.Doc {
    const doc = new Y.Doc();
    const binding = new ExcalidrawYjsBinding({ ydoc: doc, rootName: diagramRootName(BLOCK) });
    binding.commitLocal([el('rect-1', { x: 5 }), el('rect-2', { x: 40, index: 'a2' })]);
    binding.destroy();
    return doc;
}

describe('a diagram opened before its snapshot arrives', () => {
    it('sees the scene once the snapshot lands', () => {
        const server = drawnDoc();

        // The cold client: empty doc, binding built immediately.
        const client = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({
            ydoc: client,
            rootName: diagramRootName(BLOCK),
        });
        expect(binding.readAll()).toEqual([]);

        const seen: DiagramElement[][] = [];
        binding.observe((elements) => seen.push(elements));

        Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

        // Both halves matter. `readAll` is what the hydration effect calls once
        // the Excalidraw API exists; the observer is what paints when the
        // snapshot is the LATER of the two events.
        expect(binding.readAll().map((e) => e.id)).toEqual(['rect-1', 'rect-2']);
        expect(seen.at(-1)?.map((e) => e.id)).toEqual(['rect-1', 'rect-2']);
    });

    it('writes into the container the document actually points at', () => {
        // The subtler half. Reading correctly is not enough: a binding holding a
        // detached container still ACCEPTS writes, still emits Yjs updates, and
        // still looks like it is working — the shapes simply never appear for
        // anyone, including the author after a reload.
        const server = drawnDoc();

        const client = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({
            ydoc: client,
            rootName: diagramRootName(BLOCK),
        });
        Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

        binding.commitLocal([
            ...binding.readAll(),
            el('rect-3', { x: 90, index: 'a3' }),
        ]);

        // Round-trip through the wire, exactly as the gateway does, and read the
        // result with a FRESH binding — the only way to prove reachability from
        // the document root rather than from a reference we happen to hold.
        const reloaded = new Y.Doc();
        Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(client));
        const after = new ExcalidrawYjsBinding({
            ydoc: reloaded,
            rootName: diagramRootName(BLOCK),
        });
        expect(after.readAll().map((e) => e.id)).toEqual(['rect-1', 'rect-2', 'rect-3']);
    });

    it('creates no container at all for a diagram nobody has drawn in', () => {
        // This is the property that removes the race rather than narrowing it.
        // A binding that writes nothing on open cannot lose a tie-break it never
        // entered, so the snapshot's container arrives uncontested.
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc, rootName: diagramRootName(BLOCK) });
        expect(binding.size).toBe(0);
        expect([...doc.getMap(diagramRootName(BLOCK)).keys()]).toEqual([]);

        binding.commitLocal([el('rect-1')]);
        expect([...doc.getMap(diagramRootName(BLOCK)).keys()]).toEqual(['elements']);
    });

    it('still converges when two cold clients draw at the same instant', () => {
        // The genuinely concurrent case the container key can only answer one
        // way. One map wins; the requirement is that BOTH clients then agree on
        // which, and that neither is left writing into the loser.
        const a = new Y.Doc();
        const b = new Y.Doc();
        const ba = new ExcalidrawYjsBinding({ ydoc: a, rootName: diagramRootName(BLOCK) });
        const bb = new ExcalidrawYjsBinding({ ydoc: b, rootName: diagramRootName(BLOCK) });

        ba.commitLocal([el('from-a')]);
        bb.commitLocal([el('from-b', { index: 'a2' })]);

        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        expect(ba.readAll().map((e) => e.id)).toEqual(bb.readAll().map((e) => e.id));

        // And a later write from the client whose container LOST still lands
        // somewhere both can see.
        ba.commitLocal([...ba.readAll(), el('later', { index: 'a3' })]);
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        expect(bb.readAll().map((e) => e.id)).toContain('later');
    });
});
