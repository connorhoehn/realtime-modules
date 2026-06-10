/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useReactions.test.tsx
//
// Exercises the useReactions hook via a mock GatewayContext. Covers:
//
// Gateway-real protocol (hub#1497):
//   - subscribe on mount / unsubscribe+resubscribe on channel change
//   - react() sends action 'send' (gateway verb; 'react' was never accepted)
//   - { type: 'reaction', action: 'reaction_received', data } adds an entry
//   - reaction_received is channel-filtered via data.channel
//   - reaction acks (reaction_sent / reaction_subscribed) are ignored
//
// Legacy-fallback + filtering (no targetId):
//   - Initial state: empty reactions list
//   - reaction:new arrives: state updates (legacy flat shape)
//   - reaction:history arrives: replaces list (legacy flat shape)
//   - react() sends correct outbound frame (no targetId field when not set)
//   - MAX_REACTIONS trim (51st reaction drops oldest)
//   - Channel change resets list
//   - Invalid frames are silently dropped
//
// targetId on hook (v0.7.6):
//   - useReactions(ch, { targetId }) — only matching reactions returned
//   - Reactions without targetId are excluded from filtered list
//   - Different targetIds on same channel are partitioned correctly
//
// targetId in react() (v0.7.6):
//   - react(emoji) uses hook-level targetId in outbound frame
//   - react(emoji, { targetId: '...' }) overrides hook-level targetId
//   - react(emoji, { metadata: {...} }) includes metadata in frame
//   - Hook-level targetId + per-call override works together
//
// reactionsFor() utility (v0.7.6):
//   - Returns filtered subset of full list
//   - Returns [] for unknown targetId
//   - Updates reactively as new reactions arrive

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useReactions } from '../../src/client/useReactions';

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
// Helpers
// ---------------------------------------------------------------------------

interface ReactionPayload {
  id?: string;
  clientId?: string;
  channel?: string;
  emoji?: string;
  effect?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

function makeReactionFrame(
  channel: string,
  overrides: ReactionPayload = {},
): GatewayMessage {
  return {
    type: 'reaction:new',
    id: overrides.id ?? 'r-1',
    clientId: overrides.clientId ?? 'client-1',
    channel: overrides.channel ?? channel,
    emoji: overrides.emoji ?? '\u{1F525}',
    effect: overrides.effect ?? '',
    timestamp: overrides.timestamp ?? '2026-05-22T10:00:00.000Z',
    ...(overrides.targetId !== undefined ? { targetId: overrides.targetId } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  } as GatewayMessage;
}

/** Outbound reaction 'send' frames only (the hook also sends lifecycle
 * subscribe/unsubscribe frames on mount/unmount/channel change). */
function sentReactions(sent: Record<string, unknown>[]): Record<string, unknown>[] {
  return sent.filter((f) => f.service === 'reaction' && f.action === 'send');
}

function makeHistoryFrame(channel: string, reactions: ReactionPayload[]): GatewayMessage {
  return {
    type: 'reaction:history',
    channel,
    reactions: reactions.map((r) => ({
      id: r.id ?? 'r-1',
      clientId: r.clientId ?? 'client-1',
      channel,
      emoji: r.emoji ?? '\u{1F525}',
      effect: r.effect ?? '',
      timestamp: r.timestamp ?? '2026-05-22T10:00:00.000Z',
      ...(r.targetId !== undefined ? { targetId: r.targetId } : {}),
    })),
  } as unknown as GatewayMessage;
}

// ---------------------------------------------------------------------------
// Tests — backward compat (no targetId)
// ---------------------------------------------------------------------------

describe('useReactions — backward compat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts with an empty reactions list', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    expect(result.current.reactions).toEqual([]);
  });

  it('reaction:new adds an entry to the list', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', emoji: '\u{1F525}' }));
    });

    expect(result.current.reactions).toHaveLength(1);
    expect(result.current.reactions[0]!.id).toBe('r-1');
    expect(result.current.reactions[0]!.emoji).toBe('\u{1F525}');
  });

  it('reaction:history replaces the list', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    // First emit a reaction:new.
    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-old' }));
    });
    expect(result.current.reactions).toHaveLength(1);

    act(() => {
      emit(makeHistoryFrame('ch-1', [
        { id: 'h-1', emoji: '\u{1F44D}' },
        { id: 'h-2', emoji: '❤️' },
      ]));
    });

    expect(result.current.reactions).toHaveLength(2);
    expect(result.current.reactions[0]!.id).toBe('h-1');
    expect(result.current.reactions[1]!.id).toBe('h-2');
  });

  it('ignores frames from a different channel', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-OTHER', { id: 'r-x' }));
    });

    expect(result.current.reactions).toHaveLength(0);
  });

  it('trims to MAX_REACTIONS (50) — 51st drops the oldest', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      for (let i = 1; i <= 51; i++) {
        emit(makeReactionFrame('ch-1', { id: `r-${i}` }));
      }
    });

    expect(result.current.reactions).toHaveLength(50);
    expect(result.current.reactions[0]!.id).toBe('r-2');
    expect(result.current.reactions[49]!.id).toBe('r-51');
  });

  it('channel change resets the reaction list', () => {
    const { ctx, emit } = makeGatewayContext();
    let channel = 'ch-1';
    const { result, rerender } = renderHook(() => useReactions(channel), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1' }));
    });
    expect(result.current.reactions).toHaveLength(1);

    channel = 'ch-2';
    rerender();
    expect(result.current.reactions).toHaveLength(0);
  });

  it('silently drops frames missing required fields (id, clientId, channel, emoji)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      // Missing id.
      emit({ type: 'reaction:new', channel: 'ch-1', clientId: 'c', emoji: '\u{1F525}' } as GatewayMessage);
      // Missing emoji.
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r-x', clientId: 'c' } as GatewayMessage);
      // Missing clientId.
      emit({ type: 'reaction:new', channel: 'ch-1', id: 'r-x', emoji: '\u{1F525}' } as GatewayMessage);
    });

    expect(result.current.reactions).toHaveLength(0);
  });

  it('react() sends a bare outbound frame (no targetId)', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.react('\u{1F525}');
    });

    const frames = sentReactions(sent);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      service: 'reaction',
      action: 'send',
      channel: 'ch-1',
      emoji: '\u{1F525}',
    });
    expect(frames[0]).not.toHaveProperty('targetId');
    expect(frames[0]).not.toHaveProperty('metadata');
  });
});

// ---------------------------------------------------------------------------
// Tests — gateway-real protocol (hub#1497)
// ---------------------------------------------------------------------------

describe('useReactions — gateway-real protocol', () => {
  it('subscribes to the channel on mount and unsubscribes on unmount', () => {
    const { ctx, sent } = makeGatewayContext();
    const { unmount } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    expect(sent[0]).toMatchObject({ service: 'reaction', action: 'subscribe', channel: 'ch-1' });

    unmount();
    expect(sent[sent.length - 1]).toMatchObject({
      service: 'reaction',
      action: 'unsubscribe',
      channel: 'ch-1',
    });
  });

  it('resubscribes when the channel changes', () => {
    const { ctx, sent } = makeGatewayContext();
    let channel = 'ch-1';
    const { rerender } = renderHook(() => useReactions(channel), { wrapper: makeWrapper(ctx) });

    channel = 'ch-2';
    rerender();

    const lifecycle = sent.filter((f) => f.action === 'subscribe' || f.action === 'unsubscribe');
    expect(lifecycle).toEqual([
      expect.objectContaining({ action: 'subscribe', channel: 'ch-1' }),
      expect.objectContaining({ action: 'unsubscribe', channel: 'ch-1' }),
      expect.objectContaining({ action: 'subscribe', channel: 'ch-2' }),
    ]);
  });

  it('reaction_received envelope adds an entry (Reaction nested under data)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'reaction',
        action: 'reaction_received',
        data: {
          id: 'r-real',
          clientId: 'client-2',
          channel: 'ch-1',
          emoji: '\u{1F525}',
          effect: 'float',
          timestamp: '2026-06-10T10:00:00.000Z',
        },
      } as GatewayMessage);
    });

    expect(result.current.reactions).toHaveLength(1);
    expect(result.current.reactions[0]!.id).toBe('r-real');
    expect(result.current.reactions[0]!.effect).toBe('float');
  });

  it('reaction_received is channel-filtered via data.channel', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'reaction',
        action: 'reaction_received',
        data: {
          id: 'r-other',
          clientId: 'client-2',
          channel: 'ch-OTHER',
          emoji: '\u{1F525}',
          timestamp: '2026-06-10T10:00:00.000Z',
        },
      } as GatewayMessage);
    });

    expect(result.current.reactions).toHaveLength(0);
  });

  it('reaction acks (reaction_sent / reaction_subscribed) are ignored', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'reaction',
        action: 'reaction_sent',
        success: true,
        data: { reactionId: 'r-1', emoji: '\u{1F525}', channel: 'ch-1' },
      } as GatewayMessage);
      emit({
        type: 'reaction',
        action: 'reaction_subscribed',
        success: true,
        data: { channel: 'ch-1' },
      } as GatewayMessage);
    });

    expect(result.current.reactions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — hook-level targetId filter (v0.7.6)
// ---------------------------------------------------------------------------

describe('useReactions — hook-level targetId filter', () => {
  it('only returns reactions matching the hook targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-123' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-123' }));
      emit(makeReactionFrame('ch-1', { id: 'r-2', targetId: 'article-456' }));
      emit(makeReactionFrame('ch-1', { id: 'r-3' })); // no targetId
    });

    expect(result.current.reactions).toHaveLength(1);
    expect(result.current.reactions[0]!.id).toBe('r-1');
  });

  it('returns empty list when no reactions match the hook targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'msg-999' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-123' }));
    });

    expect(result.current.reactions).toHaveLength(0);
  });

  it('without opts (backward compat) returns all reactions including those with targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-123' }));
      emit(makeReactionFrame('ch-1', { id: 'r-2' })); // no targetId
    });

    expect(result.current.reactions).toHaveLength(2);
  });

  it('correctly partitions two different targetIds on the same channel', () => {
    const { ctx, emit } = makeGatewayContext();

    const { result: result1 } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-A' }),
      { wrapper: makeWrapper(ctx) },
    );
    const { result: result2 } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-B' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-A' }));
      emit(makeReactionFrame('ch-1', { id: 'r-2', targetId: 'article-B' }));
      emit(makeReactionFrame('ch-1', { id: 'r-3', targetId: 'article-A' }));
    });

    expect(result1.current.reactions).toHaveLength(2);
    expect(result1.current.reactions.map((r) => r.id)).toEqual(['r-1', 'r-3']);

    expect(result2.current.reactions).toHaveLength(1);
    expect(result2.current.reactions[0]!.id).toBe('r-2');
  });

  it('history frames are also filtered by hook targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-123' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit(makeHistoryFrame('ch-1', [
        { id: 'h-1', targetId: 'article-123' },
        { id: 'h-2', targetId: 'article-456' },
        { id: 'h-3', targetId: 'article-123' },
      ]));
    });

    expect(result.current.reactions).toHaveLength(2);
    expect(result.current.reactions.map((r) => r.id)).toEqual(['h-1', 'h-3']);
  });
});

// ---------------------------------------------------------------------------
// Tests — react() with targetId / metadata (v0.7.6)
// ---------------------------------------------------------------------------

describe('useReactions — react() with targetId', () => {
  it('react() uses hook-level targetId in outbound frame', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-123' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      result.current.react('\u{1F44D}');
    });

    const frames = sentReactions(sent);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      service: 'reaction',
      action: 'send',
      channel: 'ch-1',
      emoji: '\u{1F44D}',
      targetId: 'article-123',
    });
  });

  it('react(emoji, { targetId }) overrides the hook-level targetId', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-123' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      result.current.react('\u{1F525}', { targetId: 'comment-456' });
    });

    expect(sentReactions(sent)[0]).toMatchObject({ targetId: 'comment-456' });
  });

  it('react(emoji, { targetId }) with no hook-level targetId includes targetId', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.react('\u{1F525}', { targetId: 'msg-789' });
    });

    expect(sentReactions(sent)[0]).toMatchObject({ targetId: 'msg-789' });
  });

  it('react(emoji, { metadata }) includes metadata in outbound frame', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.react('❤️', { metadata: { source: 'article-detail-page' } });
    });

    expect(sentReactions(sent)[0]).toMatchObject({
      emoji: '❤️',
      metadata: { source: 'article-detail-page' },
    });
    expect(sentReactions(sent)[0]).not.toHaveProperty('targetId');
  });

  it('react() with both hook targetId and per-call metadata includes both', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-123' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      result.current.react('\u{1F44D}', { metadata: { position: 'header' } });
    });

    expect(sentReactions(sent)[0]).toMatchObject({
      targetId: 'article-123',
      metadata: { position: 'header' },
    });
  });

  it('react() without hook targetId and no per-call targetId omits the field', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.react('\u{1F525}');
    });

    expect(sentReactions(sent)[0]).not.toHaveProperty('targetId');
  });
});

// ---------------------------------------------------------------------------
// Tests — reactionsFor() utility (v0.7.6)
// ---------------------------------------------------------------------------

describe('useReactions — reactionsFor()', () => {
  it('filters full channel list by targetId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-A' }));
      emit(makeReactionFrame('ch-1', { id: 'r-2', targetId: 'article-B' }));
      emit(makeReactionFrame('ch-1', { id: 'r-3', targetId: 'article-A' }));
    });

    const forA = result.current.reactionsFor('article-A');
    expect(forA).toHaveLength(2);
    expect(forA.map((r) => r.id)).toEqual(['r-1', 'r-3']);

    const forB = result.current.reactionsFor('article-B');
    expect(forB).toHaveLength(1);
    expect(forB[0]!.id).toBe('r-2');
  });

  it('returns [] for a targetId with no reactions', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-A' }));
    });

    expect(result.current.reactionsFor('unknown-entity')).toEqual([]);
  });

  it('reactionsFor updates reactively as new reactions arrive', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useReactions('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-A' }));
    });

    expect(result.current.reactionsFor('article-A')).toHaveLength(1);

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-2', targetId: 'article-A' }));
    });

    expect(result.current.reactionsFor('article-A')).toHaveLength(2);
  });

  it('reactionsFor works alongside hook-level targetId filter', () => {
    const { ctx, emit } = makeGatewayContext();
    // Hook is scoped to article-A, but reactionsFor can still query article-B
    // from the full list (hooks store all reactions internally).
    const { result } = renderHook(
      () => useReactions('ch-1', { targetId: 'article-A' }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      emit(makeReactionFrame('ch-1', { id: 'r-1', targetId: 'article-A' }));
      emit(makeReactionFrame('ch-1', { id: 'r-2', targetId: 'article-B' }));
    });

    // reactions is filtered to A.
    expect(result.current.reactions).toHaveLength(1);
    expect(result.current.reactions[0]!.id).toBe('r-1');

    // reactionsFor can still reach B.
    expect(result.current.reactionsFor('article-B')).toHaveLength(1);
    expect(result.current.reactionsFor('article-B')[0]!.id).toBe('r-2');
  });
});
