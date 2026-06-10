/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useChat.test.tsx
//
// Exercises the useChat hook via a mock GatewayContext. Covers the
// gateway-real protocol (hub#1497):
//   - join on mount / leave on unmount / leave+join on channel change
//   - sendMessage sends { service: 'chat', action: 'send' }
//   - loadHistory omits `limit` when not provided (server default) and
//     passes it through when provided
//   - gateway-real inbound envelopes:
//       { type: 'chat', action: 'message', channel, message: ChatMessage }
//       { type: 'chat', action: 'history', channel, messages: [...] }
//     (the history frame also covers the join auto-push)
//   - chat acks (joined / left / sent) are ignored
//   - channel filtering + legacy flat-shape fallback
//     (chat:message / chat:history)

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useChat } from '../../src/client/useChat';

// ---------------------------------------------------------------------------
// Fake GatewayContext
// ---------------------------------------------------------------------------

function makeGatewayContext() {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const sent: Record<string, unknown>[] = [];

  const ctx: GatewayContextValue = {
    connectionState: 'connected',
    lastError: null,
    sessionToken: null,
    clientId: 'client-1',
    currentChannel: 'ch-1',
    switchChannel: jest.fn() as unknown as (c: string) => void,
    sendMessage: jest.fn() as unknown as (msg: Record<string, unknown>) => void,
    disconnect: jest.fn() as unknown as () => void,
    reconnect: jest.fn() as unknown as () => void,
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    subscribe: jest.fn() as unknown as (ch: string) => void,
    unsubscribe: jest.fn() as unknown as (ch: string) => void,
    publish: jest.fn() as unknown as (ch: string, frame: Record<string, unknown>) => void,
    onMessage: (handler: (msg: GatewayMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const emit = (msg: GatewayMessage) => {
    for (const h of handlers) h(msg);
  };

  return { ctx, emit, sent };
}

function makeWrapper(ctx: GatewayContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <GatewayContext.Provider value={ctx}>
        {children}
      </GatewayContext.Provider>
    );
  };
}

function wireMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    clientId: 'client-2',
    channel: 'ch-1',
    message: `msg-${id}`,
    metadata: {},
    timestamp: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — outbound (gateway-real verbs, hub#1497)
// ---------------------------------------------------------------------------

describe('useChat — outbound frames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('joins the channel on mount and leaves on unmount', () => {
    const { ctx, sent } = makeGatewayContext();
    const { unmount } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    expect(sent[0]).toEqual({ service: 'chat', action: 'join', channel: 'ch-1' });

    unmount();
    expect(sent[sent.length - 1]).toEqual({ service: 'chat', action: 'leave', channel: 'ch-1' });
  });

  it('leaves the old channel and joins the new one on channel change', () => {
    const { ctx, sent } = makeGatewayContext();
    let channel = 'ch-1';
    const { rerender } = renderHook(() => useChat(channel), { wrapper: makeWrapper(ctx) });

    channel = 'ch-2';
    rerender();

    expect(sent).toEqual([
      { service: 'chat', action: 'join', channel: 'ch-1' },
      { service: 'chat', action: 'leave', channel: 'ch-1' },
      { service: 'chat', action: 'join', channel: 'ch-2' },
    ]);
  });

  it('sendMessage sends the chat/send frame', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.sendMessage('hello');
    });

    expect(sent[sent.length - 1]).toEqual({
      service: 'chat',
      action: 'send',
      channel: 'ch-1',
      message: 'hello',
    });
  });

  it('loadHistory omits limit when not provided (server default applies)', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.loadHistory();
    });

    const frame = sent[sent.length - 1]!;
    expect(frame).toEqual({ service: 'chat', action: 'history', channel: 'ch-1' });
    expect(frame).not.toHaveProperty('limit');
  });

  it('loadHistory passes limit through when provided', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.loadHistory(25);
    });

    expect(sent[sent.length - 1]).toEqual({
      service: 'chat',
      action: 'history',
      channel: 'ch-1',
      limit: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — inbound (gateway-real envelopes)
// ---------------------------------------------------------------------------

describe('useChat — gateway-real inbound envelopes', () => {
  it('chat/message envelope appends the nested ChatMessage', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'chat',
        action: 'message',
        channel: 'ch-1',
        message: wireMessage('m-1'),
        timestamp: '2026-06-10T10:00:00.000Z',
      } as GatewayMessage);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]!.id).toBe('m-1');
    expect(result.current.messages[0]!.message).toBe('msg-m-1');
  });

  it('chat/history envelope replaces state (covers join auto-push)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'chat',
        action: 'message',
        channel: 'ch-1',
        message: wireMessage('m-live'),
      } as GatewayMessage);
      // Auto-pushed history (sent by the gateway after a successful join).
      emit({
        type: 'chat',
        action: 'history',
        channel: 'ch-1',
        messages: [wireMessage('h-1'), wireMessage('h-2')],
        timestamp: '2026-06-10T10:00:01.000Z',
      } as GatewayMessage);
    });

    expect(result.current.messages.map((m) => m.id)).toEqual(['h-1', 'h-2']);
  });

  it('chat acks (joined / left / sent) are ignored', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({ type: 'chat', action: 'joined', channel: 'ch-1' } as GatewayMessage);
      emit({ type: 'chat', action: 'sent', channel: 'ch-1', messageId: 'm-1' } as GatewayMessage);
      emit({ type: 'chat', action: 'left', channel: 'ch-1' } as GatewayMessage);
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it('ignores chat envelopes for other channels', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'chat',
        action: 'message',
        channel: 'ch-OTHER',
        message: wireMessage('m-x', { channel: 'ch-OTHER' }),
      } as GatewayMessage);
    });

    expect(result.current.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — legacy flat-shape fallback
// ---------------------------------------------------------------------------

describe('useChat — legacy flat-shape fallback', () => {
  it('chat:message flat frame still appends', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({ type: 'chat:message', ...wireMessage('legacy-1') } as GatewayMessage);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]!.id).toBe('legacy-1');
  });

  it('chat:history flat frame still replaces state', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChat('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'chat:history',
        channel: 'ch-1',
        messages: [wireMessage('legacy-h1')],
      } as unknown as GatewayMessage);
    });

    expect(result.current.messages.map((m) => m.id)).toEqual(['legacy-h1']);
  });
});
