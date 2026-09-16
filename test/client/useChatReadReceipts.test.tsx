/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useChatReadReceipts.test.tsx
//
// The hook's half of the read-receipt contract:
//   - asks for the roster on mount (nothing is pushed on join)
//   - full `receipts` frame replaces; `readReceipt` merges
//   - readersOf answers from the cursor: readAt >= the message's timestamp
//   - the viewer's own cursor is not part of "seen by"
//   - the automatic send fires only when the panel is active AND a newest
//     message is on screen, never twice for the same position, and never at
//     all when the server says receipts are off here
//   - socket-explicit: it all works with NO GatewaySocketProvider mounted,
//     and the hook is inert (not a crash) with neither socket nor provider

import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GatewayMessage } from '../../src/client/types';
import { useChatReadReceipts } from '../../src/client/useChatReadReceipts';

function makeSocket() {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const sent: Record<string, unknown>[] = [];
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

const CHANNEL = 'chat:dm:u-carol:u-eve';

function receiptsFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'chat',
    action: 'receipts',
    channel: CHANNEL,
    enabled: true,
    limit: 20,
    receipts: [],
    timestamp: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

const reads = (sent: Record<string, unknown>[]) => sent.filter((f) => f.action === 'read');

describe('useChatReadReceipts', () => {
  it('asks for the roster on mount and takes the full frame as state', async () => {
    const { socket, sent, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket }));

    expect(sent[0]).toEqual({ service: 'chat', action: 'receipts', channel: CHANNEL });
    expect(result.current.loading).toBe(true);

    emit(receiptsFrame({
      receipts: [{ userId: 'u-carol', displayName: 'Carol', readAt: '2026-09-16T09:00:00.000Z', updatedAt: '2026-09-16T09:00:01.000Z' }],
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.limit).toBe(20);
    expect(result.current.receipts).toEqual([
      { userId: 'u-carol', displayName: 'Carol', readAt: '2026-09-16T09:00:00.000Z', updatedAt: '2026-09-16T09:00:01.000Z' },
    ]);
  });

  it('merges a single readReceipt and answers readersOf from the cursor', async () => {
    const { socket, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket, currentUserId: 'u-eve' }));
    emit(receiptsFrame());
    emit({ type: 'chat', action: 'readReceipt', channel: CHANNEL, userId: 'u-carol', displayName: 'Carol', readAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z' });

    await waitFor(() => expect(result.current.receipts).toHaveLength(1));
    // Read up to 10:00 means every message at or before 10:00 is read.
    expect(result.current.readCountOf({ timestamp: '2026-09-16T09:30:00.000Z' })).toBe(1);
    expect(result.current.readCountOf({ timestamp: '2026-09-16T10:00:00.000Z' })).toBe(1);
    expect(result.current.readCountOf({ timestamp: '2026-09-16T10:00:01.000Z' })).toBe(0);
    expect(result.current.readersOf({ timestamp: '2026-09-16T09:30:00.000Z' })[0].displayName).toBe('Carol');

    // A later cursor from the same person replaces, never duplicates.
    emit({ type: 'chat', action: 'readReceipt', channel: CHANNEL, userId: 'u-carol', readAt: '2026-09-16T11:00:00.000Z', updatedAt: '2026-09-16T11:00:00.000Z' });
    await waitFor(() => expect(result.current.receipts[0].readAt).toBe('2026-09-16T11:00:00.000Z'));
    expect(result.current.receipts).toHaveLength(1);
  });

  it('leaves the viewer out of "seen by"', async () => {
    const { socket, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket, currentUserId: 'u-eve' }));
    emit(receiptsFrame({
      receipts: [
        { userId: 'u-eve', readAt: '2026-09-16T12:00:00.000Z', updatedAt: '2026-09-16T12:00:00.000Z' },
        { userId: 'u-carol', readAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z' },
      ],
    }));
    await waitFor(() => expect(result.current.receipts).toHaveLength(1));
    expect(result.current.receipts[0].userId).toBe('u-carol');
  });

  it('ignores frames for another channel', async () => {
    const { socket, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket }));
    emit(receiptsFrame({ channel: 'chat:dm:u-bob:u-dave', receipts: [{ userId: 'u-bob', readAt: 'x', updatedAt: 'x' }] }));
    expect(result.current.receipts).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('sends a read when the panel is active and the newest message is on screen — once per position', async () => {
    const { socket, sent, emit } = makeSocket();
    const newest = { id: 'm-1', timestamp: '2026-09-16T10:00:00.000Z' };
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useChatReadReceipts(CHANNEL, { socket, active, newestMessage: newest }),
      { initialProps: { active: false } },
    );
    emit(receiptsFrame());

    // Not active yet: nothing claimed.
    expect(reads(sent)).toHaveLength(0);

    rerender({ active: true });
    await waitFor(() => expect(reads(sent)).toHaveLength(1));
    expect(reads(sent)[0]).toEqual({
      service: 'chat', action: 'read', channel: CHANNEL, messageId: 'm-1', at: '2026-09-16T10:00:00.000Z',
    });

    // Same position again (a re-render, a focus bounce) sends nothing more.
    rerender({ active: true });
    await act(async () => { await Promise.resolve(); });
    expect(reads(sent)).toHaveLength(1);
  });

  it('sends nothing at all when the server says receipts are off here', async () => {
    const { socket, sent, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, {
      socket, active: true, newestMessage: { id: 'm-1', timestamp: '2026-09-16T10:00:00.000Z' },
    }));
    emit(receiptsFrame({ enabled: false, reason: 'too-many-members', limit: 20 }));

    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.reason).toBe('too-many-members');
    await act(async () => { await Promise.resolve(); });
    expect(reads(sent)).toHaveLength(0);

    // markRead() by hand is refused too — the channel keeps no receipts.
    act(() => { result.current.markRead({ timestamp: '2026-09-16T11:00:00.000Z' }); });
    expect(reads(sent)).toHaveLength(0);
  });

  it('never claims to have read backwards', async () => {
    const { socket, sent, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket, throttleMs: 0 }));
    emit(receiptsFrame());
    act(() => { result.current.markRead({ timestamp: '2026-09-16T10:00:00.000Z' }); });
    act(() => { result.current.markRead({ timestamp: '2026-09-16T09:00:00.000Z' }); });
    await waitFor(() => expect(reads(sent)).toHaveLength(1));
    act(() => { result.current.markRead({ timestamp: '2026-09-16T11:00:00.000Z' }); });
    await waitFor(() => expect(reads(sent)).toHaveLength(2));
  });

  it('drops everything when this connection is removed from the channel', async () => {
    const { socket, emit } = makeSocket();
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL, { socket }));
    emit(receiptsFrame({ receipts: [{ userId: 'u-carol', readAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z' }] }));
    await waitFor(() => expect(result.current.receipts).toHaveLength(1));
    emit({ type: 'chat', action: 'removed', channel: CHANNEL, byUserId: 'u-carol', timestamp: '2026-09-16T10:05:00.000Z' });
    await waitFor(() => expect(result.current.receipts).toEqual([]));
    expect(result.current.enabled).toBe(false);
  });

  it('re-asks and resets on a channel change', async () => {
    const { socket, sent, emit } = makeSocket();
    const { result, rerender } = renderHook(
      ({ channel }: { channel: string }) => useChatReadReceipts(channel, { socket }),
      { initialProps: { channel: CHANNEL } },
    );
    emit(receiptsFrame({ receipts: [{ userId: 'u-carol', readAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z' }] }));
    await waitFor(() => expect(result.current.receipts).toHaveLength(1));

    rerender({ channel: 'chat:dm:u-bob:u-eve' });
    await waitFor(() => expect(result.current.receipts).toEqual([]));
    expect(result.current.loading).toBe(true);
    expect(sent.filter((f) => f.action === 'receipts').pop()).toEqual({
      service: 'chat', action: 'receipts', channel: 'chat:dm:u-bob:u-eve',
    });
  });

  it('is inert with neither a socket nor a provider, rather than throwing', () => {
    const { result } = renderHook(() => useChatReadReceipts(CHANNEL));
    expect(result.current.receipts).toEqual([]);
    expect(result.current.enabled).toBe(false);
    expect(() => result.current.markRead()).not.toThrow();
    expect(() => result.current.refresh()).not.toThrow();
  });
});
