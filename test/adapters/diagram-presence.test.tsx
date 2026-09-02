/**
 * @jest-environment jsdom
 */
// realtime-modules/test/adapters/diagram-presence.test.tsx
//
// The four things that make a board feel multiplayer, and the two bugs that
// stopped each of them working.
//
// These run two REAL `y-protocols` Awareness instances wired to each other, so
// what is exercised is the actual encode/decode path a browser uses — not a
// mock that agrees with whatever the hook happens to write.

import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import {
    Awareness,
    applyAwarenessUpdate,
    encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import {
    useCollaborativeDiagram,
    DIAGRAM_AWARENESS_KEY,
} from '../../src/adapters/excalidraw/useCollaborativeDiagram';
import type { AwarenessLike } from '../../src/adapters/excalidraw/useCollaborativeDiagram';
import type { DiagramPresence } from '../../src/adapters/excalidraw/types';

const BLOCK = 'board-1';

/**
 * Two awareness instances that relay to each other, as the gateway does.
 *
 * The relay is deliberately synchronous and lossless. The gateway's real path
 * (50ms debounce → base64 → JSON envelope → server coalescer → fan-out) only
 * adds latency, and none of the properties under test are about latency.
 */
function pair(): { a: Awareness; b: Awareness; unlink: () => void } {
    const a = new Awareness(new Y.Doc());
    const b = new Awareness(new Y.Doc());
    let linked = true;

    const relay = (from: Awareness, to: Awareness) => (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
    ) => {
        if (!linked || origin === 'remote') return;
        const changed = added.concat(updated, removed);
        if (!changed.includes(from.clientID)) return;
        applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [from.clientID]), 'remote');
    };

    const ra = relay(a, b);
    const rb = relay(b, a);
    a.on('update', ra);
    b.on('update', rb);

    return {
        a,
        b,
        unlink: () => {
            linked = false;
        },
    };
}

/** Read what a hook actually published, decoded from the peer's own view. */
function presenceSeenBy(observer: Awareness, authorId: number): DiagramPresence | null {
    const state = observer.getStates().get(authorId);
    return (state?.[DIAGRAM_AWARENESS_KEY] as DiagramPresence | undefined) ?? null;
}

/**
 * The Y.Doc is hoisted OUT of the render callback deliberately.
 *
 * `useCollaborativeDiagram` keys its binding effect on the doc identity, so a
 * `new Y.Doc()` written inline in the callback is a fresh dependency on every
 * render and the effect tears down and rebuilds forever — React reports it as
 * "Maximum update depth exceeded" and the suite hangs rather than fails. Real
 * callers hold the doc in a ref or get it from a provider; a test must too.
 */
function mount(
    awareness: Awareness,
    displayName: string,
    color: string,
    blockId: string = BLOCK,
) {
    const ydoc = new Y.Doc();
    return renderHook(() =>
        useCollaborativeDiagram({
            ydoc,
            awareness: awareness as unknown as AwarenessLike,
            blockId,
            user: { userId: displayName.toLowerCase(), displayName, color },
        }),
    );
}

describe('diagram presence over one awareness channel', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        // Drained inside act(): these timers are the heartbeat and the sweep,
        // and both call setState.
        act(() => {
            jest.runOnlyPendingTimers();
        });
        jest.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // 1. You exist before you move
    // -----------------------------------------------------------------------
    it('announces the local user on mount, without any pointer activity', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');

        const seen = presenceSeenBy(b, a.clientID);
        expect(seen).not.toBeNull();
        expect(seen!.blockId).toBe(BLOCK);
        expect(seen!.user).toEqual({
            displayName: 'Alice',
            color: '#FF6B6B',
            userId: 'alice',
        });

        // The roster question — "who is here" — includes the reader.
        expect(A.result.current.participants).toHaveLength(1);
        expect(A.result.current.participants[0].isSelf).toBe(true);
        expect(A.result.current.collaborators).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // 2. Pointer and selection do not destroy each other
    // -----------------------------------------------------------------------
    // The regression: `handleChange` published `{ selectedElementIds }` and
    // `handlePointerUpdate` published `{ pointer, button }`, each as a WHOLE
    // record via setLocalStateField — which replaces rather than merges. At
    // pointer rate they alternated, so a peer's cursor vanished the instant
    // they selected anything and the selection vanished the instant they moved.
    it('merges partial patches instead of clobbering the record', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');

        act(() => {
            A.result.current.publishPresence({
                pointer: { x: 10, y: 20, tool: 'pointer' },
                button: 'up',
            });
            jest.advanceTimersByTime(60);
        });
        act(() => {
            A.result.current.publishPresence({ selectedElementIds: { rect1: true } });
            jest.advanceTimersByTime(60);
        });

        const seen = presenceSeenBy(b, a.clientID)!;
        // BOTH survive. This is the whole fix.
        expect(seen.pointer).toEqual({ x: 10, y: 20, tool: 'pointer' });
        expect(seen.selectedElementIds).toEqual({ rect1: true });

        // ...and in the other order.
        act(() => {
            A.result.current.publishPresence({
                pointer: { x: 99, y: 99, tool: 'pointer' },
            });
            jest.advanceTimersByTime(60);
        });
        const after = presenceSeenBy(b, a.clientID)!;
        expect(after.pointer).toEqual({ x: 99, y: 99, tool: 'pointer' });
        expect(after.selectedElementIds).toEqual({ rect1: true });
    });

    // -----------------------------------------------------------------------
    // 3. A peer is resolved with the right name, colour and selection
    // -----------------------------------------------------------------------
    it('resolves a peer into a render-ready collaborator', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');
        mount(b, 'Bob', '#4ECDC4');

        act(() => {
            jest.advanceTimersByTime(100);
        });

        const peers = A.result.current.collaborators;
        expect(peers).toHaveLength(1);
        expect(peers[0].displayName).toBe('Bob');
        // Identity travels ON the diagram record, so a STANDALONE board — which
        // has no useAwarenessState writing `user` — still labels its peers.
        expect(peers[0].color).toBe('#4ECDC4');
        expect(peers[0].userId).toBe('bob');
        expect(peers[0].isSelf).toBeUndefined();

        // And the roster is self + peers.
        expect(A.result.current.participants.map((p) => p.displayName)).toEqual([
            'Alice',
            'Bob',
        ]);
    });

    it('carries a selection to the peer that has to see it', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');
        const B = mount(b, 'Bob', '#4ECDC4');

        act(() => {
            B.result.current.publishPresence({
                selectedElementIds: { 'rect-42': true },
                pointer: { x: 5, y: 5, tool: 'pointer' },
            });
            jest.advanceTimersByTime(100);
        });

        expect(A.result.current.collaborators[0].selectedElementIds).toEqual({
            'rect-42': true,
        });
    });

    // -----------------------------------------------------------------------
    // 4. Leaving is visible
    // -----------------------------------------------------------------------
    it('drops a peer immediately on a clean unmount', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');
        const B = mount(b, 'Bob', '#4ECDC4');

        act(() => {
            jest.advanceTimersByTime(100);
        });
        expect(A.result.current.collaborators).toHaveLength(1);

        // SPA navigation / closing the block: the socket is still up, so the
        // null publish gets out and the cursor goes at once.
        act(() => {
            B.unmount();
            jest.advanceTimersByTime(100);
        });
        expect(A.result.current.collaborators).toHaveLength(0);
    });

    it('sweeps a peer whose socket died without a goodbye', () => {
        const { a, b, unlink } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');
        mount(b, 'Bob', '#4ECDC4');

        act(() => {
            jest.advanceTimersByTime(100);
        });
        expect(A.result.current.collaborators).toHaveLength(1);

        // A hard tab close. Nothing announces it: the gateway does NOT emit an
        // awareness removal on disconnect (CRDTService.onClientDisconnect only
        // clears its own bookkeeping), so Bob's state just sits in Alice's
        // getStates() forever as far as anything else is concerned.
        unlink();

        // Not yet — two missed heartbeats is jitter, not absence.
        act(() => {
            jest.advanceTimersByTime(8_000);
        });
        expect(A.result.current.collaborators).toHaveLength(1);

        // Gone. The deadline is PRESENCE_STALE_MS (12s) but it is only OBSERVED
        // on a sweep tick, which runs every HEARTBEAT_MS — so the worst case a
        // user actually sees is one heartbeat past the deadline, i.e. ~16s.
        // Asserting at 16s rather than 12.001s pins the real guarantee instead
        // of a boundary the implementation is free to round either way.
        //
        // Without any of this the wait is y-protocols' hard-coded 30s
        // `outdatedTimeout`, because nothing else ever mentions the departure.
        act(() => {
            jest.advanceTimersByTime(8_000);
        });
        expect(A.result.current.collaborators).toHaveLength(0);
    });

    it('keeps a peer alive purely on the heartbeat, with no pointer traffic', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');
        mount(b, 'Bob', '#4ECDC4');

        // Bob is present and completely idle for well past the deadline. The
        // staleness sweep must not mistake "not drawing" for "gone".
        act(() => {
            jest.advanceTimersByTime(40_000);
        });
        expect(A.result.current.collaborators).toHaveLength(1);
        expect(A.result.current.collaborators[0].displayName).toBe('Bob');
    });

    // -----------------------------------------------------------------------
    // Scoping — two boards on one awareness channel
    // -----------------------------------------------------------------------
    it('ignores a peer pointing at a different diagram on the same channel', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');

        mount(b, 'Bob', '#4ECDC4', 'some-other-block');

        act(() => {
            jest.advanceTimersByTime(100);
        });
        expect(A.result.current.collaborators).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Wire shape — the gateway coerces every frame to a UTF-8 string
    // -----------------------------------------------------------------------
    it('publishes a JSON-serialisable record, as the wire requires', () => {
        const { a, b } = pair();
        const A = mount(a, 'Alice', '#FF6B6B');

        act(() => {
            A.result.current.publishPresence({
                pointer: { x: 1.5, y: -2.5, tool: 'laser' },
                button: 'down',
                selectedElementIds: { x: true },
            });
            jest.advanceTimersByTime(60);
        });

        // Awareness states are JSON.stringify'd by encodeAwarenessUpdate before
        // GatewayProvider base64s them into a string field. A value that does
        // not survive that round trip fails SILENTLY on this gateway.
        const seen = presenceSeenBy(b, a.clientID)!;
        expect(JSON.parse(JSON.stringify(seen))).toEqual(seen);
        expect(typeof seen.t).toBe('number');
    });
});
