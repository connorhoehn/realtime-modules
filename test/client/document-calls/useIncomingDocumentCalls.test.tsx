/**
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useIncomingDocumentCalls } from '../../../src/client/video/useIncomingDocumentCalls';
import { makeFakeGateway } from './fakeGateway';

const inviteData = (callId: string, extra: Record<string, unknown> = {}) => ({
  callId, lobbyName: 'doc-auth', callerId: 'u-host', callerName: 'Connor Hoehn', targetUserIds: ['u-bob'],
  kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review',
  documentIds: ['doc-auth', 'doc-migration'], documentTitles: { 'doc-auth': 'Auth architecture', 'doc-migration': 'Migration brief' },
  media: 'video', participantCount: 3,
  participants: [{ userId: 'u-host', displayName: 'Connor Hoehn' }, { userId: 'u-alice', displayName: 'Alice Chen' }],
  ...extra,
});

afterEach(() => { jest.useRealTimers(); });

describe('useIncomingDocumentCalls', () => {
  it('queues document invites FIFO and ignores others and my own', () => {
    const g = makeFakeGateway();
    const { result } = renderHook(() => useIncomingDocumentCalls({ gateway: g.gw, localUserId: 'u-bob' }));
    act(() => {
      g.push('invite', { callId: 'dm-1', lobbyName: 'dm:x', callerId: 'u-host', targetUserIds: ['u-bob'] });
      g.push('invite', inviteData('c1'));
      g.push('invite', inviteData('c1'));
      g.push('invite', inviteData('c2', { title: 'Second' }));
      g.push('invite', inviteData('c3', { callerId: 'u-bob' }));
    });
    expect(result.current.queueLength).toBe(2);
    expect(result.current.current).toMatchObject({
      callId: 'c1', callerName: 'Connor Hoehn', targeted: true, title: 'Auth architecture review',
      documentIds: ['doc-auth', 'doc-migration'], participantCount: 3, media: 'video',
    });
    expect(result.current.current!.participants).toHaveLength(2);
  });

  it('decline sends declined with a reason; accept hands the invite and media to onAccept', () => {
    const g = makeFakeGateway();
    const onAccept = jest.fn();
    const { result } = renderHook(() => useIncomingDocumentCalls({ gateway: g.gw, localUserId: 'u-bob', onAccept }));
    act(() => { g.push('invite', inviteData('c1')); g.push('invite', inviteData('c2')); });
    act(() => { result.current.decline('not-now'); });
    expect(g.callFrames('declined')[0]).toMatchObject({ callId: 'c1', reason: 'not-now', targetUserIds: ['u-host'], userId: 'u-bob' });
    expect(result.current.current!.callId).toBe('c2');
    act(() => { result.current.accept({ micOn: true, cameraOn: false }); });
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c2' }), { micOn: true, cameraOn: false });
    expect(result.current.current).toBeNull();
    expect(g.callFrames('accepted')).toHaveLength(0);
  });

  it('drops a ring answered on another tab, cancelled, or ended', () => {
    const g = makeFakeGateway();
    const { result } = renderHook(() => useIncomingDocumentCalls({ gateway: g.gw, localUserId: 'u-bob' }));
    act(() => { g.push('invite', inviteData('c1')); g.push('invite', inviteData('c2')); g.push('invite', inviteData('c3')); });
    act(() => { g.push('accepted', { callId: 'c1' }); g.push('cancelled', { callId: 'c2' }); });
    expect(result.current.queue.map((q) => q.callId)).toEqual(['c3']);
    act(() => { g.push('ended', { callId: 'c3' }); });
    expect(result.current.current).toBeNull();
  });

  it('a ring ages out after the TTL and reports a missed call', () => {
    jest.useFakeTimers();
    const g = makeFakeGateway();
    const onMissed = jest.fn();
    const { result } = renderHook(() => useIncomingDocumentCalls({ gateway: g.gw, localUserId: 'u-bob', onMissed }));
    act(() => { g.push('invite', inviteData('c1')); });
    act(() => { jest.advanceTimersByTime(59_000); });
    expect(result.current.current).not.toBeNull();
    act(() => { jest.advanceTimersByTime(1_500); });
    expect(result.current.current).toBeNull();
    expect(onMissed).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1' }));
  });

  it('a replayed invite keeps its original ring time', () => {
    const g = makeFakeGateway();
    const { result } = renderHook(() => useIncomingDocumentCalls({ gateway: g.gw, localUserId: 'u-bob' }));
    const orig = new Date(Date.now() - 50_000).toISOString();
    act(() => { g.push('invite', inviteData('c1', { replayed: true, originalTimestamp: orig })); });
    expect(result.current.current!.expiresAt).toBe(Date.parse(orig) + 60_000);
    act(() => { g.push('invite', inviteData('c2', { replayed: true, originalTimestamp: new Date(Date.now() - 70_000).toISOString() })); });
    expect(result.current.queueLength).toBe(1);
  });
});
