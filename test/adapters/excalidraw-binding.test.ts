// Convergence tests for the Excalidraw ↔ Yjs binding.
//
// These run two Y.Docs and relay updates between them by hand, which is the
// honest simulation of the real transport: the gateway is an opaque relay of
// base64 Yjs updates, so anything that converges here converges in the app.

import * as Y from 'yjs';
import {
    ExcalidrawYjsBinding,
    diagramRootName,
} from '../../src/adapters/excalidraw/ExcalidrawYjsBinding';
import type { DiagramElement } from '../../src/adapters/excalidraw/types';

function el(
    id: string,
    props: Partial<DiagramElement> = {},
): DiagramElement {
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

/** Bump an element the way Excalidraw does when the user edits it. */
function bump(e: DiagramElement, props: Partial<DiagramElement>): DiagramElement {
    return { ...e, ...props, version: e.version + 1, versionNonce: e.versionNonce + 1 };
}

/** Wire two docs together, both directions, like the gateway relay. */
function link(a: Y.Doc, b: Y.Doc): () => void {
    const aToB = (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') return;
        Y.applyUpdate(b, update, 'remote');
    };
    const bToA = (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') return;
        Y.applyUpdate(a, update, 'remote');
    };
    a.on('update', aToB);
    b.on('update', bToA);
    return () => {
        a.off('update', aToB);
        b.off('update', bToA);
    };
}

describe('ExcalidrawYjsBinding', () => {
    it('round-trips a scene through the doc', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });

        binding.commitLocal([el('a'), el('b', { index: 'a2' })]);

        const read = binding.readAll();
        expect(read.map((e) => e.id)).toEqual(['a', 'b']);
        expect(read[0].width).toBe(10);
        binding.destroy();
    });

    it('sorts by the fractional index, not insertion order', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });

        binding.commitLocal([
            el('z', { index: 'a3' }),
            el('x', { index: 'a1' }),
            el('y', { index: 'a2' }),
        ]);

        expect(binding.readAll().map((e) => e.id)).toEqual(['x', 'y', 'z']);
        binding.destroy();
    });

    it('does not re-write elements whose version is unchanged', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });
        const scene = [el('a'), el('b')];

        expect(binding.commitLocal(scene)).toBe(true);
        expect(binding.commitLocal(scene)).toBe(false);
        binding.destroy();
    });

    it('never fires its own observer for local commits', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });
        const seen: number[] = [];
        binding.observe((els) => seen.push(els.length));

        binding.commitLocal([el('a')]);
        expect(seen).toEqual([]);
        binding.destroy();
    });

    it('delivers remote changes to the observer', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();
        const unlink = link(docA, docB);

        const a = new ExcalidrawYjsBinding({ ydoc: docA });
        const b = new ExcalidrawYjsBinding({ ydoc: docB });

        const received: DiagramElement[][] = [];
        b.observe((els) => received.push(els));

        a.commitLocal([el('a', { x: 5 })]);

        expect(received.length).toBeGreaterThan(0);
        const last = received[received.length - 1];
        expect(last.map((e) => e.id)).toEqual(['a']);
        expect(last[0].x).toBe(5);

        a.destroy();
        b.destroy();
        unlink();
    });

    it('converges when two peers move DIFFERENT shapes concurrently', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();

        // Seed both with the same two shapes, then split the network.
        const seed = new ExcalidrawYjsBinding({ ydoc: docA });
        seed.commitLocal([el('one'), el('two', { index: 'a2' })]);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote');
        seed.destroy();

        const a = new ExcalidrawYjsBinding({ ydoc: docA });
        const b = new ExcalidrawYjsBinding({ ydoc: docB });

        // Offline, concurrent edits to different elements.
        a.commitLocal([bump(el('one'), { x: 100 }), el('two', { index: 'a2' })]);
        b.commitLocal([el('one'), bump(el('two', { index: 'a2' }), { y: 200 })]);

        // Reconnect.
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote');
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), 'remote');

        const fromA = a.readAll();
        const fromB = b.readAll();
        expect(fromA).toEqual(fromB);
        // BOTH edits survived — neither clobbered the other.
        expect(fromA.find((e) => e.id === 'one')!.x).toBe(100);
        expect(fromA.find((e) => e.id === 'two')!.y).toBe(200);

        a.destroy();
        b.destroy();
    });

    it('converges on a per-property basis when peers edit the SAME shape', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();

        const seed = new ExcalidrawYjsBinding({ ydoc: docA });
        seed.commitLocal([el('one')]);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote');
        seed.destroy();

        const a = new ExcalidrawYjsBinding({ ydoc: docA });
        const b = new ExcalidrawYjsBinding({ ydoc: docB });

        // A moves it, B recolours it — disjoint properties of one element.
        a.commitLocal([bump(el('one'), { x: 42 })]);
        b.commitLocal([bump(el('one'), { strokeColor: '#ff0000' })]);

        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote');
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), 'remote');

        expect(a.readAll()).toEqual(b.readAll());
        const merged = a.readAll()[0];
        expect(merged.x).toBe(42);
        expect(merged.strokeColor).toBe('#ff0000');

        a.destroy();
        b.destroy();
    });

    it('tombstones a removed element rather than dropping the key', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });

        binding.commitLocal([el('a'), el('b', { index: 'a2' })]);
        binding.commitLocal([el('a')]); // 'b' vanished from the local scene

        const read = binding.readAll();
        expect(read.map((e) => e.id).sort()).toEqual(['a', 'b']);
        expect(read.find((e) => e.id === 'b')!.isDeleted).toBe(true);
        binding.destroy();
    });

    it('removes a property the local element dropped', () => {
        const doc = new Y.Doc();
        const binding = new ExcalidrawYjsBinding({ ydoc: doc });

        binding.commitLocal([el('a', { boundElements: [{ id: 'x', type: 'arrow' }] })]);
        const withBound = el('a', { boundElements: [{ id: 'x', type: 'arrow' }] });
        const cleared = bump(withBound, {});
        delete (cleared as Record<string, unknown>).boundElements;
        binding.commitLocal([cleared]);

        expect(binding.readAll()[0].boundElements).toBeUndefined();
        binding.destroy();
    });

    it('namespaces blocks so two diagrams on one page do not collide', () => {
        const doc = new Y.Doc();
        const one = new ExcalidrawYjsBinding({ ydoc: doc, rootName: diagramRootName('sec-1') });
        const two = new ExcalidrawYjsBinding({ ydoc: doc, rootName: diagramRootName('sec-2') });

        one.commitLocal([el('a')]);
        two.commitLocal([el('b')]);

        expect(one.readAll().map((e) => e.id)).toEqual(['a']);
        expect(two.readAll().map((e) => e.id)).toEqual(['b']);

        one.destroy();
        two.destroy();
    });

    it('survives a peer that reloads mid-session', () => {
        const docA = new Y.Doc();
        const a = new ExcalidrawYjsBinding({ ydoc: docA });
        a.commitLocal([el('a', { x: 7 })]);

        // Peer B "reloads": a brand-new doc hydrated from a state snapshot,
        // which is exactly what the gateway sends as crdt:snapshot.
        const snapshot = Y.encodeStateAsUpdate(docA);
        const docB = new Y.Doc();
        Y.applyUpdate(docB, snapshot, 'remote');
        const b = new ExcalidrawYjsBinding({ ydoc: docB });

        expect(b.readAll()).toEqual(a.readAll());

        // And B can still edit into the same shared history afterwards.
        b.commitLocal([bump(el('a', { x: 7 }), { y: 9 })]);
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), 'remote');
        expect(a.readAll()[0].y).toBe(9);

        a.destroy();
        b.destroy();
    });

    it('survives the base64 hop the gateway forces on every frame', () => {
        // The gateway coerces every WS frame to a UTF-8 string, so updates
        // travel base64-encoded inside JSON. Prove the exact round-trip.
        const docA = new Y.Doc();
        const docB = new Y.Doc();

        // Listen BEFORE the binding constructs its root types, so the frames
        // array carries every update the real provider would have sent.
        const frames: string[] = [];
        docA.on('update', (u: Uint8Array) => {
            frames.push(Buffer.from(u).toString('base64'));
        });

        const a = new ExcalidrawYjsBinding({ ydoc: docA });
        a.commitLocal([el('a', { x: 3, text: 'héllo ☺' })]);

        for (const frame of frames) {
            const json = JSON.stringify({ service: 'crdt', action: 'update', update: frame });
            const parsed = JSON.parse(json) as { update: string };
            Y.applyUpdate(docB, new Uint8Array(Buffer.from(parsed.update, 'base64')), 'remote');
        }

        const b = new ExcalidrawYjsBinding({ ydoc: docB });
        expect(b.readAll()).toEqual(a.readAll());
        expect(b.readAll()[0].text).toBe('héllo ☺');

        a.destroy();
        b.destroy();
    });
});
