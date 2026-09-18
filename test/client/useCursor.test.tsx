/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useCursor.test.tsx
//
// The hook's half of the cursor contract:
//   - subscribes on mount, unsubscribes on unmount, re-subscribes on channel change
//   - the subscribe snapshot replaces; per-client update replaces in place;
//     remove drops one client
//   - frames for another channel are ignored
//   - move() is throttled to the same interval the service enforces, and the
//     position suppressed inside the window still lands on the trailing edge
//   - selfClientId keeps a stale cursor of your own out of the list
//   - socket-explicit: all of it with NO GatewaySocketProvider mounted, and
//     inert (not a crash) with neither socket nor provider

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import type { GatewayMessage } from '../../src/client/types';
import { useCursor } from '../../src/client/useCursor';

function makeSocket() {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const sent: Record<string, any>[] = [];
  const socket = {
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    onMessage: (handler: (msg: GatewayMessage) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
  const emit = (msg: Record<string, unknown>) => {
    act(() => { for (const h of handlers) h(msg as GatewayMessage); });
  };
  return { socket, sent, emit };
}

const CHANNEL = 'doc:deck-42';

function cursorData(clientId: string, x: number, y: number, channel = CHANNEL) {
  return {
    clientId,
    channel,
    position: { x, y },
    metadata: { mode: 'freeform', userInitials: clientId.slice(0, 2).toUpperCase(), userColor: '#4ECDC4' },
    timestamp: '2026-09-17T12:00:00.000Z',
  };
}

const updates = (sent: Record<string, any>[]) => sent.filter((f) => f.action === 'update');

describe('useCursor', () => {
  describe('subscription', () => {
    it('subscribes on mount and unsubscribes on unmount', () => {
      const { socket, sent } = makeSocket();
      const { unmount } = renderHook(() => useCursor(CHANNEL, { socket }));

      expect(sent).toEqual([{ service: 'cursor', action: 'subscribe', channel: CHANNEL }]);

      unmount();
      expect(sent[1]).toEqual({ service: 'cursor', action: 'unsubscribe', channel: CHANNEL });
    });

    it('re-subscribes and drops the old channel state when the channel changes', () => {
      const { socket, sent, emit } = makeSocket();
      const { result, rerender } = renderHook(
        ({ ch }) => useCursor(ch, { socket }),
        { initialProps: { ch: CHANNEL } },
      );

      emit({ type: 'cursor', action: 'subscribed', channel: CHANNEL, cursors: [cursorData('c-1', 10, 20)] });
      expect(result.current.cursors).toHaveLength(1);

      rerender({ ch: 'doc:deck-43' });

      expect(result.current.cursors).toEqual([]);
      expect(sent.map((f) => `${f.action}:${f.channel}`)).toEqual([
        'subscribe:doc:deck-42',
        'unsubscribe:doc:deck-42',
        'subscribe:doc:deck-43',
      ]);
    });
  });

  describe('inbound frames', () => {
    it('takes the subscribe snapshot as the whole list', () => {
      const { socket, emit } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket }));

      emit({
        type: 'cursor',
        action: 'subscribed',
        channel: CHANNEL,
        cursors: [cursorData('c-1', 10, 20), cursorData('c-2', 30, 40)],
      });

      expect(result.current.cursors.map((c) => c.clientId)).toEqual(['c-1', 'c-2']);
      expect(result.current.cursors[0].position).toEqual({ x: 10, y: 20 });
      expect(result.current.cursors[0].metadata.userColor).toBe('#4ECDC4');
    });

    it('replaces a client cursor in place rather than appending a second one', () => {
      const { socket, emit } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket }));

      emit({ type: 'cursor', action: 'update', channel: CHANNEL, cursor: cursorData('c-1', 10, 20) });
      emit({ type: 'cursor', action: 'update', channel: CHANNEL, cursor: cursorData('c-1', 11, 21) });

      expect(result.current.cursors).toHaveLength(1);
      expect(result.current.cursors[0].position).toEqual({ x: 11, y: 21 });
    });

    it('drops a cursor on remove and ignores frames for another channel', () => {
      const { socket, emit } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket }));

      emit({
        type: 'cursor',
        action: 'subscribed',
        channel: CHANNEL,
        cursors: [cursorData('c-1', 10, 20), cursorData('c-2', 30, 40)],
      });

      // Another channel's traffic must not touch this hook's state.
      emit({ type: 'cursor', action: 'remove', channel: 'doc:other', clientId: 'c-1' });
      expect(result.current.cursors).toHaveLength(2);

      emit({ type: 'cursor', action: 'remove', channel: CHANNEL, clientId: 'c-1' });
      expect(result.current.cursors.map((c) => c.clientId)).toEqual(['c-2']);
    });

    it('answers a refresh with the fresh snapshot', () => {
      const { socket, sent, emit } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket }));

      act(() => { result.current.refresh(); });
      expect(sent[1]).toEqual({ service: 'cursor', action: 'get', channel: CHANNEL });

      emit({ type: 'cursor', action: 'cursors', channel: CHANNEL, cursors: [cursorData('c-9', 1, 2)] });
      expect(result.current.cursors.map((c) => c.clientId)).toEqual(['c-9']);
    });

    it('keeps your own stale cursor out of the list when selfClientId is given', () => {
      const { socket, emit } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket, selfClientId: 'c-me' }));

      emit({
        type: 'cursor',
        action: 'subscribed',
        channel: CHANNEL,
        cursors: [cursorData('c-me', 5, 5), cursorData('c-1', 10, 20)],
      });

      expect(result.current.cursors.map((c) => c.clientId)).toEqual(['c-1']);
    });
  });

  describe('move()', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('sends the first position immediately, with mode and merged metadata', () => {
      const { socket, sent } = makeSocket();
      const { result } = renderHook(() =>
        useCursor(CHANNEL, { socket, mode: 'canvas', metadata: { userInitials: 'CH' } }),
      );

      act(() => { result.current.move({ x: 1, y: 2 }, { tool: 'pen' }); });

      expect(updates(sent)).toEqual([{
        service: 'cursor',
        action: 'update',
        channel: CHANNEL,
        position: { x: 1, y: 2 },
        mode: 'canvas',
        metadata: { userInitials: 'CH', tool: 'pen' },
      }]);
    });

    it('throttles to one send per window and lands the resting position on the trailing edge', () => {
      const { socket, sent } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket }));

      // A pointer stream: the first goes out, the rest are suppressed.
      act(() => {
        result.current.move({ x: 1, y: 1 });
        result.current.move({ x: 2, y: 2 });
        result.current.move({ x: 3, y: 3 });
      });
      expect(updates(sent)).toHaveLength(1);
      expect(updates(sent)[0].position).toEqual({ x: 1, y: 1 });

      // Where the pointer actually stopped is what must arrive next — not the
      // intermediate {x:2}, and not nothing at all.
      act(() => { jest.advanceTimersByTime(250); });
      expect(updates(sent)).toHaveLength(2);
      expect(updates(sent)[1].position).toEqual({ x: 3, y: 3 });

      // The trailing send consumed the window it fired in, so a move at that
      // same instant is held like any other. Once a full interval has passed
      // with no traffic, the next move goes out immediately.
      act(() => { jest.advanceTimersByTime(250); });
      act(() => { result.current.move({ x: 4, y: 4 }); });
      expect(updates(sent)).toHaveLength(3);
      expect(updates(sent)[2].position).toEqual({ x: 4, y: 4 });
    });

    it('honours a custom throttle interval', () => {
      const { socket, sent } = makeSocket();
      const { result } = renderHook(() => useCursor(CHANNEL, { socket, throttleMs: 1000 }));

      act(() => {
        result.current.move({ x: 1, y: 1 });
        result.current.move({ x: 2, y: 2 });
      });
      act(() => { jest.advanceTimersByTime(250); });
      expect(updates(sent)).toHaveLength(1);

      act(() => { jest.advanceTimersByTime(750); });
      expect(updates(sent)).toHaveLength(2);
    });

    it('does not fire a held trailing send after unmount', () => {
      const { socket, sent } = makeSocket();
      const { result, unmount } = renderHook(() => useCursor(CHANNEL, { socket }));

      act(() => {
        result.current.move({ x: 1, y: 1 });
        result.current.move({ x: 2, y: 2 });
      });
      unmount();
      act(() => { jest.advanceTimersByTime(500); });

      expect(updates(sent)).toHaveLength(1);
    });

    it('keeps a stable identity so it can be handed straight to onMouseMove', () => {
      const { socket } = makeSocket();
      const { result, rerender } = renderHook(() => useCursor(CHANNEL, { socket }));
      const first = result.current.move;
      rerender();
      expect(result.current.move).toBe(first);
    });
  });

  it('is inert with neither socket nor provider', () => {
    const { result } = renderHook(() => useCursor(CHANNEL));

    expect(result.current.cursors).toEqual([]);
    expect(() => {
      act(() => { result.current.move({ x: 1, y: 1 }); result.current.refresh(); });
    }).not.toThrow();
  });
});
