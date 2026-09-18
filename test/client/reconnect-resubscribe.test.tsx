/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/reconnect-resubscribe.test.tsx
//
// A reconnect is a NEW server-side connection. It has joined nothing, and the
// channels the old one was on are gone with it.
//
// Every channel hook opened its subscription from an effect keyed on
// `[channel, send]`, and `send` is `useCallback(…, [])` — stable for the life
// of the hook. So the effect fired once, on mount, and never again. After any
// network blip the socket came back, `connectionState` read 'connected', and
// the channel delivered nothing for the rest of the session. Nothing threw and
// nothing logged.
//
// useWebSocket's own comment assigned the responsibility — "the gateway's pull
// model leaves subscribe lifecycle to feature hooks" — and no hook had the
// signal it needed to honour it. `sessionEpoch` is that signal.
//
// These tests drive the real socket path (useWebSocket under
// GatewaySocketProvider) rather than a fake send/onMessage pair, because the
// bug lived in the seam between them.

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewaySocketProvider } from '../../src/client/GatewaySocketProvider';
import { useChat } from '../../src/client/useChat';
import { usePresence } from '../../src/client/usePresence';
import { useActivity } from '../../src/client/useActivity';
import { useReactions } from '../../src/client/useReactions';
import { useCursor } from '../../src/client/useCursor';
import { useChatMembers } from '../../src/client/useChatMembers';
import { useChatReadReceipts } from '../../src/client/useChatReadReceipts';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /** Open AND deliver the gateway session frame — the happy path. */
  openAndEstablish(): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({ type: 'session', status: 'connected', clientId: 'c-1' }),
    });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'lost' });
  }

  frames(match: (f: Record<string, unknown>) => boolean): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter(match);
  }
}

const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <GatewaySocketProvider url="ws://gateway.test/ws" rest={null}>
      {children}
    </GatewaySocketProvider>
  );
}

/** Drop the live socket and let the backoff timer bring up the next one. */
function reconnect(): FakeWebSocket {
  const before = FakeWebSocket.instances.length;
  act(() => FakeWebSocket.instances[before - 1]!.serverClose());
  act(() => {
    jest.advanceTimersByTime(5000);
  });
  const next = FakeWebSocket.instances[before];
  expect(next).toBeDefined();
  act(() => next!.openAndEstablish());
  return next!;
}

describe('channel hooks re-establish after a reconnect', () => {
  it.each([
    ['useChat', () => useChat('room:1'), (f: Record<string, unknown>) => f.service === 'chat' && f.action === 'join'],
    ['usePresence', () => usePresence('room:1'), (f: Record<string, unknown>) => f.service === 'presence' && f.action === 'subscribe'],
    ['useActivity', () => useActivity('room:1'), (f: Record<string, unknown>) => f.service === 'activity' && f.action === 'subscribe'],
    ['useReactions', () => useReactions('room:1'), (f: Record<string, unknown>) => f.service === 'reaction' && f.action === 'subscribe'],
    ['useCursor', () => useCursor('room:1'), (f: Record<string, unknown>) => f.service === 'cursor' && f.action === 'subscribe'],
  ])('%s re-sends its subscribe on the new socket', (_name, hook, isSubscribe) => {
    renderHook(hook as () => unknown, { wrapper });

    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    expect(first.frames(isSubscribe as (f: Record<string, unknown>) => boolean)).toHaveLength(1);

    const second = reconnect();

    // The whole bug: this used to be 0.
    expect(second.frames(isSubscribe as (f: Record<string, unknown>) => boolean)).toHaveLength(1);
  });

  // These two ask once and are answered once — nothing is pushed on join. A
  // reconnect that does not re-ask leaves the panel showing whatever it held
  // before the drop, so a membership change or a read that happened while
  // offline is never seen. Staleness rather than silence, and just as quiet.
  it.each([
    ['useChatMembers', () => useChatMembers('room:1'), 'members'],
    ['useChatReadReceipts', () => useChatReadReceipts('room:1'), 'receipts'],
  ])('%s re-asks for its state on the new socket', (_name, hook, action) => {
    renderHook(hook as () => unknown, { wrapper });

    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    expect(first.frames((f) => f.service === 'chat' && f.action === action)).toHaveLength(1);

    const second = reconnect();
    expect(second.frames((f) => f.service === 'chat' && f.action === action)).toHaveLength(1);
  });

  // Join auto-pushes the server's joinHistoryLimit (20 by default) and a
  // history frame REPLACES the list. Once 0.65.0 made every reconnect re-join,
  // a reader who had loaded more than that was silently cut back to 20 with
  // nothing to tell them — so the hook asks again for the depth it last used.
  describe('history depth across a reconnect', () => {
    it('re-requests the limit the caller last asked for', () => {
      const { result } = renderHook(() => useChat('room:1'), { wrapper });
      act(() => FakeWebSocket.instances[0]!.openAndEstablish());

      act(() => result.current.loadHistory(200));

      const second = reconnect();
      const history = second.frames((f) => f.service === 'chat' && f.action === 'history');
      expect(history).toHaveLength(1);
      expect(history[0]!.limit).toBe(200);
      // And it still re-joins — the history request is in addition, not instead.
      expect(second.frames((f) => f.action === 'join')).toHaveLength(1);
    });

    it('asks for nothing extra when the caller never loaded history', () => {
      renderHook(() => useChat('room:1'), { wrapper });
      act(() => FakeWebSocket.instances[0]!.openAndEstablish());

      const second = reconnect();
      expect(second.frames((f) => f.action === 'history')).toHaveLength(0);
    });

    // loadHistory() with no argument means "the server's default" — that has
    // to travel as an absent limit, not as an invented number.
    it('carries an omitted limit across as omitted', () => {
      const { result } = renderHook(() => useChat('room:1'), { wrapper });
      act(() => FakeWebSocket.instances[0]!.openAndEstablish());

      act(() => result.current.loadHistory());

      const second = reconnect();
      const history = second.frames((f) => f.action === 'history');
      expect(history).toHaveLength(1);
      expect('limit' in history[0]!).toBe(false);
    });

    // A different channel is a fresh read, not a restored one.
    it('does not carry one channel\'s depth onto another', () => {
      const { result, rerender } = renderHook(({ ch }) => useChat(ch), {
        wrapper,
        initialProps: { ch: 'room:1' },
      });
      act(() => FakeWebSocket.instances[0]!.openAndEstablish());
      act(() => result.current.loadHistory(200));

      rerender({ ch: 'room:2' });
      const second = reconnect();

      expect(second.frames((f) => f.action === 'history')).toHaveLength(0);
      expect(second.frames((f) => f.action === 'join')[0]!.channel).toBe('room:2');
    });
  });

  it('survives more than one reconnect', () => {
    renderHook(() => useChat('room:1'), { wrapper });
    act(() => FakeWebSocket.instances[0]!.openAndEstablish());

    for (let i = 0; i < 3; i++) {
      const sock = reconnect();
      expect(
        sock.frames((f) => f.service === 'chat' && f.action === 'join'),
      ).toHaveLength(1);
    }
  });

  it('re-joins the channel the hook is on now, not the one it mounted with', () => {
    const { rerender } = renderHook(({ ch }) => useChat(ch), {
      wrapper,
      initialProps: { ch: 'room:1' },
    });
    act(() => FakeWebSocket.instances[0]!.openAndEstablish());

    rerender({ ch: 'room:2' });
    const sock = reconnect();

    const joins = sock.frames((f) => f.service === 'chat' && f.action === 'join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.channel).toBe('room:2');
  });

  // A socket-explicit caller owns its own socket, so there is no provider
  // epoch to follow and the hook must not invent one.
  it('does not churn for a caller that supplied its own socket', () => {
    const sent: Record<string, unknown>[] = [];
    const socket = {
      send: (m: Record<string, unknown>) => {
        sent.push(m);
      },
      onMessage: () => () => {},
    };

    const { rerender } = renderHook(() => useReactions('room:1', { socket }));
    rerender();
    rerender();

    expect(sent.filter((f) => f.action === 'subscribe')).toHaveLength(1);
  });
});
