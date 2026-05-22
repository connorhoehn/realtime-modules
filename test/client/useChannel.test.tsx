/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useChannel.test.tsx
//
// Exercises the useChannel composite hook via a mock GatewayContext. Covers:
//
// Default (all features enabled):
//   - chat, presence, reactions, activity are all non-null
//   - channel prop reflected in result
//
// Feature opt-out:
//   - features.chat=false → chat is null, others non-null
//   - features.presence=false → presence is null, others non-null
//   - features.reactions=false → reactions is null, others non-null
//   - features.activity=false → activity is null, others non-null
//   - features={chat:true, presence:false, reactions:false, activity:false} → only chat non-null
//
// reactionsTargetId:
//   - When supplied, reactions hook receives filtered targetId
//   - react() outbound frame includes targetId

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useChannel } from '../../src/client/useChannel';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChannel — default (all features enabled)', () => {
  it('returns non-null results for all four sub-hooks', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.chat).not.toBeNull();
    expect(result.current.presence).not.toBeNull();
    expect(result.current.reactions).not.toBeNull();
    expect(result.current.activity).not.toBeNull();
  });

  it('reflects the channel prop in the result', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('room:abc'), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.channel).toBe('room:abc');
  });

  it('chat result has expected shape', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const chat = result.current.chat!;
    expect(Array.isArray(chat.messages)).toBe(true);
    expect(typeof chat.sendMessage).toBe('function');
    expect(typeof chat.loadHistory).toBe('function');
  });

  it('presence result has expected shape', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const presence = result.current.presence!;
    expect(Array.isArray(presence.roster)).toBe(true);
    expect(typeof presence.setStatus).toBe('function');
    expect(typeof presence.updateMetadata).toBe('function');
  });

  it('reactions result has expected shape', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const reactions = result.current.reactions!;
    expect(Array.isArray(reactions.reactions)).toBe(true);
    expect(typeof reactions.react).toBe('function');
    expect(typeof reactions.reactionsFor).toBe('function');
  });

  it('activity result has expected shape', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    const activity = result.current.activity!;
    expect(Array.isArray(activity.events)).toBe(true);
    expect(typeof activity.loadHistory).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Feature opt-out
// ---------------------------------------------------------------------------

describe('useChannel — feature opt-out', () => {
  it('features.chat=false → chat is null, others non-null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { features: { chat: false } }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).toBeNull();
    expect(result.current.presence).not.toBeNull();
    expect(result.current.reactions).not.toBeNull();
    expect(result.current.activity).not.toBeNull();
  });

  it('features.presence=false → presence is null, others non-null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { features: { presence: false } }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).not.toBeNull();
    expect(result.current.presence).toBeNull();
    expect(result.current.reactions).not.toBeNull();
    expect(result.current.activity).not.toBeNull();
  });

  it('features.reactions=false → reactions is null, others non-null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { features: { reactions: false } }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).not.toBeNull();
    expect(result.current.presence).not.toBeNull();
    expect(result.current.reactions).toBeNull();
    expect(result.current.activity).not.toBeNull();
  });

  it('features.activity=false → activity is null, others non-null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { features: { activity: false } }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).not.toBeNull();
    expect(result.current.presence).not.toBeNull();
    expect(result.current.reactions).not.toBeNull();
    expect(result.current.activity).toBeNull();
  });

  it('features={chat:true, presence:false, reactions:false, activity:false} → only chat non-null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', {
        features: { chat: true, presence: false, reactions: false, activity: false },
      }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).not.toBeNull();
    expect(result.current.presence).toBeNull();
    expect(result.current.reactions).toBeNull();
    expect(result.current.activity).toBeNull();
  });

  it('all features disabled → all four are null', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', {
        features: { chat: false, presence: false, reactions: false, activity: false },
      }),
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current.chat).toBeNull();
    expect(result.current.presence).toBeNull();
    expect(result.current.reactions).toBeNull();
    expect(result.current.activity).toBeNull();
    // channel is always reflected regardless
    expect(result.current.channel).toBe('ch-1');
  });
});

// ---------------------------------------------------------------------------
// reactionsTargetId
// ---------------------------------------------------------------------------

describe('useChannel — reactionsTargetId', () => {
  it('when reactionsTargetId supplied, inbound reactions are filtered to that targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { reactionsTargetId: 'msg-42' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r1', emoji: '👍', clientId: 'u1', effect: '', targetId: 'msg-42', timestamp: '2026-05-22T10:00:00.000Z' } as GatewayMessage);
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r2', emoji: '❤️', clientId: 'u2', effect: '', targetId: 'msg-99', timestamp: '2026-05-22T10:00:00.000Z' } as GatewayMessage);
    });

    const reactions = result.current.reactions!;
    expect(reactions.reactions).toHaveLength(1);
    expect(reactions.reactions[0].emoji).toBe('👍');
  });

  it('react() outbound frame includes reactionsTargetId as targetId', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1', { reactionsTargetId: 'msg-42' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      result.current.reactions!.react('🎉');
    });

    const frame = sent.find((f) => f.service === 'reaction');
    expect(frame).toBeDefined();
    expect(frame!.targetId).toBe('msg-42');
    expect(frame!.emoji).toBe('🎉');
  });

  it('no reactionsTargetId → all reactions returned unfiltered', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useChannel('ch-1'),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r1', emoji: '👍', clientId: 'u1', effect: '', targetId: 'msg-1', timestamp: '2026-05-22T10:00:00.000Z' } as GatewayMessage);
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r2', emoji: '❤️', clientId: 'u2', effect: '', targetId: 'msg-2', timestamp: '2026-05-22T10:00:00.000Z' } as GatewayMessage);
    });

    // No targetId filter → both reactions visible
    expect(result.current.reactions!.reactions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sub-hook integration — messages flow through
// ---------------------------------------------------------------------------

describe('useChannel — sub-hook integration', () => {
  it('chat messages arrive via inbound frames', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'chat:message',
        channel: 'ch-1',
        id: 'msg-1',
        clientId: 'u1',
        message: 'hello',
        timestamp: new Date().toISOString(),
      } as GatewayMessage);
    });

    expect(result.current.chat!.messages).toHaveLength(1);
    expect(result.current.chat!.messages[0].message).toBe('hello');
  });

  it('activity events arrive via inbound frames', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'activity:event',
        channel: 'ch-1',
        eventType: 'joined',
        detail: {},
        userId: 'u1',
        displayName: 'User One',
        timestamp: new Date().toISOString(),
      } as GatewayMessage);
    });

    expect(result.current.activity!.events).toHaveLength(1);
    expect(result.current.activity!.events[0].eventType).toBe('joined');
  });

  it('sendMessage sends correct outbound frame', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useChannel('ch-2'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      result.current.chat!.sendMessage('world');
    });

    const frame = sent.find((f) => f.service === 'chat' && f.action === 'send');
    expect(frame).toBeDefined();
    expect(frame!.channel).toBe('ch-2');
    expect(frame!.message).toBe('world');
  });
});
