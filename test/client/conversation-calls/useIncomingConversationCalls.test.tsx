/**
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useIncomingConversationCalls, parseConversationInvite } from '../../../src/client/video/useIncomingConversationCalls';
import { makeFakeGateway } from './fakes';

const invite = (extra: Record<string, unknown> = {}) => ({
  callId: 'c1', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-bob', callerName: 'Bob Stone', targetUserIds: ['u-alice'], ...extra,
});

afterEach(() => { jest.useRealTimers(); });

describe('useIncomingConversationCalls', () => {
  it('queues rings FIFO, de-dups, and skips mine, document calls and admissions', () => {
    const g = makeFakeGateway();
    const onAdmitted = jest.fn();
    const { result } = renderHook(() => useIncomingConversationCalls({ gateway: g.gw, self: { userId: 'u-alice' }, onAdmitted }));
    act(() => {
      g.push('invite', invite());
      g.push('invite', invite());
      g.push('invite', invite({ callId: 'c2', callerId: 'u-carol', callerName: 'Carol', audioOnly: true }));
      g.push('invite', invite({ callId: 'mine', callerId: 'u-alice' }));
      g.push('invite', invite({ callId: 'doc', kind: 'document-review' }));
      g.push('invite', invite({ callId: 'adm', admit: true }));
    });
    expect(result.current.rings.map((r) => [r.callId, r.targeted, r.audioOnly])).toEqual([['c1', true, false], ['c2', true, true]]);
    expect(onAdmitted).toHaveBeenCalledWith({ callId: 'adm', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-bob', callerName: 'Bob Stone' });
  });

  it('drops a ring on cancelled / accepted elsewhere; cancelled reports onCancelled', () => {
    const g = makeFakeGateway();
    const onCancelled = jest.fn();
    const { result } = renderHook(() => useIncomingConversationCalls({ gateway: g.gw, self: { userId: 'u-alice' }, onCancelled }));
    act(() => { g.push('invite', invite()); g.push('invite', invite({ callId: 'c2' })); });
    act(() => { g.push('cancelled', { callId: 'c1', callerId: 'u-bob' }); });
    act(() => { g.push('accepted', { callId: 'c2', callerId: 'u-alice' }); });
    expect(result.current.rings).toHaveLength(0);
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it('decline sends declined to the caller only for a targeted ring', () => {
    const g = makeFakeGateway();
    const { result } = renderHook(() => useIncomingConversationCalls({ gateway: g.gw, self: { userId: 'u-alice' } }));
    act(() => { g.push('invite', invite()); g.push('invite', invite({ callId: 'amb', targetUserIds: [] })); });
    act(() => { result.current.decline(result.current.rings[0]!, 'not-now'); });
    act(() => { result.current.decline(result.current.rings[0]!); });
    expect(g.callFrames('declined')).toEqual([
      { service: 'call', action: 'declined', callId: 'c1', targetUserIds: ['u-bob'], callerId: 'u-alice', lobbyName: 'acme:dm:u-alice:u-bob', reason: 'not-now' },
    ]);
  });

  it('ages the head out after the TTL as a missed call, never a decline', async () => {
    jest.useFakeTimers();
    const g = makeFakeGateway();
    const onMissed = jest.fn();
    const { result } = renderHook(() => useIncomingConversationCalls({ gateway: g.gw, self: { userId: 'u-alice' }, ttlMs: 500, onMissed }));
    act(() => { g.push('invite', invite()); });
    await act(async () => { jest.advanceTimersByTime(501); });
    expect(result.current.rings).toHaveLength(0);
    expect(onMissed).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1' }));
    expect(g.callFrames('declined')).toHaveLength(0);
  });

  it('a replayed invite keeps its original time', () => {
    const at = '2026-09-28T10:00:00.000Z';
    const r = parseConversationInvite(invite({ replayed: true, originalTimestamp: at }), 'u-alice')!;
    expect(r.receivedAt).toBe(Date.parse(at));
    expect(r.channel).toBeNull(); // a tenant-prefixed lobby has no derivable channel
    expect(parseConversationInvite(invite({ lobbyName: 'dm:u-alice:u-bob' }), 'u-alice')!.channel).toBe('chat:dm:u-alice:u-bob');
  });
});
