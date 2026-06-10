/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/usePresence.test.tsx
//
// Exercises the usePresence hook via a mock GatewayContext. Covers the
// gateway-real protocol (hub#1497):
//   - subscribe (channel REQUIRED) on mount / unsubscribe on cleanup
//   - setStatus sends { action: 'set', status, metadata, channels: [ch] }
//     (status REQUIRED by the gateway; pinning via channels[], no
//     deprecated top-level channel field)
//   - updateMetadata carries the last-known status (default 'online') so
//     metadata-only updates don't hit "Status is required"
//   - the gateway REPLACES the entry on set, so metadata is carried across
//     setStatus calls and merged across updateMetadata calls
//   - gateway-real inbound envelopes:
//       { type: 'presence', action: 'subscribed', channel, presence: [...] }
//       { type: 'presence', action: 'set'|'update', presence: entry }
//       { type: 'presence', action: 'offline', clientId }
//   - legacy flat-shape fallback (presence:state / joined / updated / left)

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { usePresence } from '../../src/client/usePresence';

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

function entry(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    status: 'online',
    metadata: {},
    channels: ['ch-1'],
    nodeId: 'node-1',
    timestamp: '2026-06-10T10:00:00.000Z',
    lastSeen: '2026-06-10T10:00:00.000Z',
    lastHeartbeat: 1765360800000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — outbound (gateway-real frames, hub#1497)
// ---------------------------------------------------------------------------

describe('usePresence — outbound frames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes with a concrete channel on mount, unsubscribes on unmount', () => {
    const { ctx, sent } = makeGatewayContext();
    const { unmount } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    expect(sent[0]).toEqual({ service: 'presence', action: 'subscribe', channel: 'ch-1' });

    unmount();
    expect(sent[sent.length - 1]).toEqual({
      service: 'presence',
      action: 'unsubscribe',
      channel: 'ch-1',
    });
  });

  it('setStatus sends status + channels pinning (no deprecated channel field)', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.setStatus('away');
    });

    const frame = sent[sent.length - 1]!;
    expect(frame).toEqual({
      service: 'presence',
      action: 'set',
      status: 'away',
      metadata: {},
      channels: ['ch-1'],
    });
    expect(frame).not.toHaveProperty('channel');
  });

  it('updateMetadata carries the default status when setStatus was never called', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.updateMetadata({ displayName: 'Connor' });
    });

    expect(sent[sent.length - 1]).toEqual({
      service: 'presence',
      action: 'set',
      status: 'online',
      metadata: { displayName: 'Connor' },
      channels: ['ch-1'],
    });
  });

  it('updateMetadata carries the last-known status and merges metadata', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.setStatus('busy');
      result.current.updateMetadata({ displayName: 'Connor' });
      result.current.updateMetadata({ avatarColor: 'teal' });
    });

    expect(sent[sent.length - 1]).toEqual({
      service: 'presence',
      action: 'set',
      status: 'busy',
      metadata: { displayName: 'Connor', avatarColor: 'teal' },
      channels: ['ch-1'],
    });
  });

  it('setStatus after updateMetadata keeps the accumulated metadata', () => {
    const { ctx, sent } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      result.current.updateMetadata({ displayName: 'Connor' });
      result.current.setStatus('away');
    });

    expect(sent[sent.length - 1]).toMatchObject({
      status: 'away',
      metadata: { displayName: 'Connor' },
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — inbound (gateway-real envelopes)
// ---------------------------------------------------------------------------

describe('usePresence — gateway-real inbound envelopes', () => {
  it('presence/subscribed replaces the roster with the channel snapshot', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence',
        action: 'subscribed',
        channel: 'ch-1',
        presence: [entry('c-a'), entry('c-b', { status: 'away' })],
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster.map((e) => e.clientId)).toEqual(['c-a', 'c-b']);
    expect(result.current.roster[1]!.status).toBe('away');
  });

  it('presence/update upserts entries pinned to the hook channel', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence',
        action: 'update',
        presence: entry('c-a', { status: 'busy' }),
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster).toHaveLength(1);
    expect(result.current.roster[0]!.status).toBe('busy');

    act(() => {
      emit({
        type: 'presence',
        action: 'update',
        presence: entry('c-a', { status: 'online' }),
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster).toHaveLength(1);
    expect(result.current.roster[0]!.status).toBe('online');
  });

  it('presence/update for an entry pinned elsewhere is ignored', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence',
        action: 'update',
        presence: entry('c-x', { channels: ['ch-OTHER'] }),
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster).toHaveLength(0);
  });

  it('presence/set (own ack) upserts the local entry', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence',
        action: 'set',
        presence: entry('client-1', { status: 'away' }),
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster).toHaveLength(1);
    expect(result.current.roster[0]!.clientId).toBe('client-1');
  });

  it('presence/offline removes the departed client', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence',
        action: 'subscribed',
        channel: 'ch-1',
        presence: [entry('c-a'), entry('c-b')],
      } as unknown as GatewayMessage);
      emit({ type: 'presence', action: 'offline', clientId: 'c-a' } as GatewayMessage);
    });

    expect(result.current.roster.map((e) => e.clientId)).toEqual(['c-b']);
  });
});

// ---------------------------------------------------------------------------
// Tests — legacy flat-shape fallback
// ---------------------------------------------------------------------------

describe('usePresence — legacy flat-shape fallback', () => {
  it('presence:state / presence:joined / presence:left still work', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => usePresence('ch-1'), { wrapper: makeWrapper(ctx) });

    act(() => {
      emit({
        type: 'presence:state',
        channel: 'ch-1',
        clients: [entry('c-a')],
      } as unknown as GatewayMessage);
      emit({
        type: 'presence:joined',
        channel: 'ch-1',
        client: entry('c-b'),
      } as unknown as GatewayMessage);
    });

    expect(result.current.roster.map((e) => e.clientId)).toEqual(['c-a', 'c-b']);

    act(() => {
      emit({ type: 'presence:left', channel: 'ch-1', clientId: 'c-a' } as GatewayMessage);
    });

    expect(result.current.roster.map((e) => e.clientId)).toEqual(['c-b']);
  });
});
