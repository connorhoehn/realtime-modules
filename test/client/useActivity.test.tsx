/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useActivity.test.tsx
//
// Exercises the useActivity hook via a mock GatewayContext (hub#1492).
//
// Inbound — REAL gateway envelopes (verified against the gateway's running
// ActivityService dist + the gateway frontend's useActivityBus):
//   - { type: 'activity:event', payload: {...} } appended (payload-wrapped,
//     no channel field on the envelope — accepted regardless of the hook's
//     subscribed channel, since the gateway scopes delivery to the single
//     global 'activity:broadcast' subscription)
//   - { type: 'activity', action: 'history', events, channelId } replaces
//     the list; mismatched channelId is ignored
//   - other type:'activity' action acks (subscribed/published) are ignored
//
// Inbound — LEGACY fallback envelopes (pre-0.13.1 shapes):
//   - flat { type: 'activity:event', channel, ...ActivityEvent } appended;
//     mismatched channel filtered out
//   - { type: 'activity:history', channel, events } replaces the list;
//     mismatched channel filtered out
//
// Outbound — gateway-real frames:
//   - mount sends { service:'activity', action:'subscribe', channelId }
//   - unmount sends { service:'activity', action:'unsubscribe', channelId }
//   - loadHistory sends { service:'activity', action:'getHistory',
//     channelId, limit }

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useActivity } from '../../src/client/useActivity';

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
// Frame factories
// ---------------------------------------------------------------------------

function eventFields(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'doc.saved',
    detail: { docId: 'readme' },
    timestamp: '2026-06-10T10:00:00.000Z',
    userId: 'u-1',
    displayName: 'Connor',
    ...overrides,
  };
}

/** REAL gateway live frame: payload-wrapped, no channel on the envelope. */
function realEventFrame(overrides: Record<string, unknown> = {}): GatewayMessage {
  return { type: 'activity:event', payload: eventFields(overrides) } as GatewayMessage;
}

/** LEGACY flat live frame: channel + event fields on the envelope. */
function legacyEventFrame(channel: string, overrides: Record<string, unknown> = {}): GatewayMessage {
  return { type: 'activity:event', channel, ...eventFields(overrides) } as GatewayMessage;
}

/** REAL history frame: { type:'activity', action:'history', events, channelId }. */
function realHistoryFrame(channelId: string, events: Record<string, unknown>[]): GatewayMessage {
  return {
    type: 'activity',
    action: 'history',
    events,
    channelId,
    timestamp: '2026-06-10T10:00:00.000Z',
  } as unknown as GatewayMessage;
}

/** LEGACY history frame: { type:'activity:history', channel, events }. */
function legacyHistoryFrame(channel: string, events: Record<string, unknown>[]): GatewayMessage {
  return { type: 'activity:history', channel, events } as unknown as GatewayMessage;
}

// ---------------------------------------------------------------------------
// Tests — real gateway envelopes
// ---------------------------------------------------------------------------

describe('useActivity — real gateway envelopes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('appends payload-wrapped activity:event frames (no channel on envelope)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realEventFrame({ eventType: 'doc.saved' }));
      emit(realEventFrame({ eventType: 'user.joined', timestamp: '2026-06-10T10:00:01.000Z' }));
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]).toEqual({
      eventType: 'doc.saved',
      detail: { docId: 'readme' },
      timestamp: '2026-06-10T10:00:00.000Z',
      userId: 'u-1',
      displayName: 'Connor',
    });
    expect(result.current.events[1]!.eventType).toBe('user.joined');
  });

  it('accepts payload-wrapped events regardless of the subscribed channel (global broadcast)', () => {
    const { ctx, emit } = makeGatewayContext();
    // Hook subscribed to a non-broadcast channel — the gateway scopes
    // delivery via the subscription, so any frame that arrives is for us.
    const { result } = renderHook(() => useActivity('room:42'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realEventFrame());
    });

    expect(result.current.events).toHaveLength(1);
  });

  it('drops payload-wrapped frames whose payload lacks eventType', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({ type: 'activity:event', payload: { detail: {} } } as GatewayMessage);
      emit({ type: 'activity:event' } as GatewayMessage); // no payload, no flat fields
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('replaces the list on { type:activity, action:history, channelId } frames', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realEventFrame({ eventType: 'live.one' }));
    });
    expect(result.current.events).toHaveLength(1);

    act(() => {
      emit(realHistoryFrame('activity:broadcast', [
        eventFields({ eventType: 'hist.one' }),
        eventFields({ eventType: 'hist.two' }),
      ]));
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events.map((e) => e.eventType)).toEqual(['hist.one', 'hist.two']);
  });

  it('ignores history frames with a mismatched channelId', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realHistoryFrame('other:channel', [eventFields()]));
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('ignores other type:activity action acks (subscribed/unsubscribed/published)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({ type: 'activity', action: 'subscribed', channelId: 'activity:broadcast' } as unknown as GatewayMessage);
      emit({ type: 'activity', action: 'published', eventType: 'doc.saved' } as unknown as GatewayMessage);
      emit({ type: 'activity', action: 'unsubscribed', channelId: 'activity:broadcast' } as unknown as GatewayMessage);
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('filters malformed entries out of history events arrays', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realHistoryFrame('activity:broadcast', [
        eventFields({ eventType: 'valid' }),
        { detail: {} }, // missing eventType — dropped
      ]));
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.eventType).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// Tests — legacy fallback envelopes
// ---------------------------------------------------------------------------

describe('useActivity — legacy fallback envelopes', () => {
  it('parses flat activity:event frames (legacy shape)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(legacyEventFrame('ch-1', { eventType: 'legacy.flat' }));
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.eventType).toBe('legacy.flat');
  });

  it('filters flat legacy frames by their channel field', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(legacyEventFrame('ch-OTHER'));
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('parses legacy activity:history frames and filters by channel', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(legacyHistoryFrame('ch-OTHER', [eventFields()])); // ignored
    });
    expect(result.current.events).toHaveLength(0);

    act(() => {
      emit(legacyHistoryFrame('ch-1', [
        eventFields({ eventType: 'legacy.h1' }),
        eventFields({ eventType: 'legacy.h2' }),
      ]));
    });

    expect(result.current.events.map((e) => e.eventType)).toEqual(['legacy.h1', 'legacy.h2']);
  });
});

// ---------------------------------------------------------------------------
// Tests — outbound frames (gateway-real shapes)
// ---------------------------------------------------------------------------

describe('useActivity — outbound frames', () => {
  it('mount sends subscribe with channelId (gateway field) + legacy channel', () => {
    const { ctx, sent } = makeGatewayContext();
    renderHook(() => useActivity('activity:broadcast'), { wrapper: makeWrapper(ctx) });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      service: 'activity',
      action: 'subscribe',
      channelId: 'activity:broadcast',
      channel: 'activity:broadcast',
    });
  });

  it('unmount sends unsubscribe with channelId', () => {
    const { ctx, sent } = makeGatewayContext();
    const { unmount } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    unmount();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      service: 'activity',
      action: 'unsubscribe',
      channelId: 'activity:broadcast',
    });
  });

  it('loadHistory sends action getHistory with channelId + limit (NOT action history)', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      result.current.loadHistory(25);
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      service: 'activity',
      action: 'getHistory',
      channelId: 'activity:broadcast',
      limit: 25,
    });
  });

  it('loadHistory defaults limit to 50', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => useActivity('activity:broadcast'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      result.current.loadHistory();
    });

    expect(sent[1]).toMatchObject({ action: 'getHistory', limit: 50 });
  });

  it('channel change resets events and resubscribes with the new channelId', () => {
    const { ctx, emit, sent } = makeGatewayContext();
    let channel = 'ch-1';
    const { result, rerender } = renderHook(() => useActivity(channel), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit(realEventFrame());
    });
    expect(result.current.events).toHaveLength(1);

    channel = 'ch-2';
    rerender();

    expect(result.current.events).toHaveLength(0);
    // subscribe ch-1, unsubscribe ch-1, subscribe ch-2
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({ action: 'unsubscribe', channelId: 'ch-1' });
    expect(sent[2]).toMatchObject({ action: 'subscribe', channelId: 'ch-2' });
  });
});
