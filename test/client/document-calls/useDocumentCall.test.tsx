/**
 * @jest-environment jsdom
 */
// useDocumentCall against a fake gateway + fake platform-api.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDocumentCall, type UseDocumentCallOptions } from '../../../src/client/video/useDocumentCall';
import { makeFakeGateway, makeFakePlatformApi } from './fakeGateway';

const identity = { userId: 'u-host', displayName: 'Connor Hoehn' };

function setup(extra: Partial<UseDocumentCallOptions> = {}, pa = makeFakePlatformApi()) {
  const g = makeFakeGateway();
  const onNavigate = jest.fn();
  const updateDocumentMeta = jest.fn();
  const hook = renderHook((props: Partial<UseDocumentCallOptions>) => useDocumentCall({
    documentId: 'doc-auth',
    gateway: g.gw,
    platformApi: pa.platformApi,
    fetch: pa.fetchImpl,
    identity,
    onNavigate,
    updateDocumentMeta,
    linkBase: 'https://app.test',
    ...extra,
    ...props,
  }), { initialProps: {} });
  return { g, pa, hook, onNavigate, updateDocumentMeta };
}

const startInput = {
  title: 'Auth architecture review', media: 'video' as const,
  documentIds: ['doc-auth', 'doc-migration'], documentTitles: { 'doc-migration': 'Migration brief' },
  targetUserIds: ['u-alice', 'u-frank'], message: 'Review the sign-in flow and migration plan.',
  ring: true, micOn: true, cameraOn: true,
};

beforeEach(() => { sessionStorage.clear(); });

describe('useDocumentCall', () => {
  it('start → PA session, join, and an invite with the document-call payload', async () => {
    const { g, pa, hook, updateDocumentMeta } = setup();
    await waitFor(() => expect(g.callFrames('status')).toHaveLength(1));
    await act(async () => { await hook.result.current.start(startInput); });

    const create = pa.calls.find((c) => c.method === 'POST' && c.path === '/api/video/sessions')!;
    expect(create.body).toMatchObject({ kind: 'document-review', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'], media: 'video', findOrCreate: true, lobbyName: 'doc-auth', documentId: 'doc-auth' });
    expect(pa.calls.some((c) => c.path === '/api/video/sessions/sess-1/join')).toBe(true);

    const [inv] = g.callFrames('invite');
    expect(inv).toMatchObject({
      callId: 'sess-1', lobbyName: 'doc-auth', targetUserIds: ['u-alice', 'u-frank'], callerId: 'u-host', callerName: 'Connor Hoehn',
      kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'],
      documentTitles: { 'doc-migration': 'Migration brief' }, message: 'Review the sign-in flow and migration plan.', media: 'video', participantCount: 1,
    });
    expect(inv.ring).toBeUndefined();
    expect(inv.participants[0]).toEqual({ userId: 'u-host', displayName: 'Connor Hoehn' });
    expect(g.callFrames('participant-state')[0]).toMatchObject({ callId: 'sess-1', status: 'in-call', audioOn: true, cameraOn: true, userId: 'u-host' });
    expect(updateDocumentMeta).toHaveBeenCalledWith({ activeCallSessionId: 'sess-1' });

    const r = hook.result.current;
    expect(r.joined).toBe(true);
    expect(r.isHost).toBe(true);
    expect(r.phase).toBe('active');
    expect(r.lvs).toEqual({ stageToken: 'stage-token', participantId: 'p-1', sessionId: 'sess-1' });
    expect(r.inviteLink).toBe('https://app.test/documents/doc-auth?call=sess-1');
    expect(r.call).toMatchObject({ callId: 'sess-1', title: 'Auth architecture review', hostUserId: 'u-host' });
  });

  it('ring:false and audio mode', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start({ ...startInput, ring: false, media: 'audio' }); });
    expect(g.callFrames('invite')[0].ring).toBe(false);
    expect(hook.result.current.self.cameraOn).toBe(false);
  });

  it('builds the people list from call-meta and roster frames', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start(startInput); });
    act(() => {
      g.push('call-meta', {
        callId: 'sess-1', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'],
        hostUserId: 'u-host', media: 'video', startedAt: Date.now() - 581_000,
        presenting: { documentId: 'doc-auth', userId: 'u-alice', since: 1 },
        invites: {
          'u-alice': { at: 1, state: 'accepted', by: 'u-host' },
          'u-frank': { at: 1, state: 'accepted', by: 'u-host' },
          'u-bob': { at: 1, state: 'ringing', by: 'u-host' },
          'u-carol': { at: 1, state: 'missed', by: 'u-host' },
          'u-dan': { at: 1, state: 'notified', by: 'u-host' },
        },
      });
      g.push('participant-state', { callId: 'sess-1', callerId: 'u-alice', userId: 'u-alice', displayName: 'Alice Chen', audioOn: true, cameraOn: true, status: 'in-call' });
      g.push('participant-state', { callId: 'sess-1', callerId: 'u-frank', userId: 'u-frank', displayName: 'Frank Davis', audioOn: false, cameraOn: false, status: 'in-call' });
      g.push('user-status', { callId: 'sess-1', userId: 'u-frank', status: 'reconnecting' });
    });
    const people = hook.result.current.participants;
    expect(people.map((p) => [p.userId, p.state])).toEqual([
      ['u-host', 'in-call'], ['u-alice', 'in-call'], ['u-frank', 'reconnecting'], ['u-bob', 'ringing'], ['u-carol', 'missed'],
    ]);
    const alice = people.find((p) => p.userId === 'u-alice')!;
    expect(alice).toMatchObject({ displayName: 'Alice Chen', presenting: true, isHost: false });
    expect(people[0]).toMatchObject({ isSelf: true, isHost: true, displayName: 'Connor Hoehn' });
    expect(people.find((p) => p.userId === 'u-frank')).toMatchObject({ audioOn: false, cameraOn: false });
    expect(hook.result.current.inCallCount).toBe(3);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(581_000);
    // A newcomer's state made us re-announce ours (late-join).
    expect(g.callFrames('participant-state').length).toBeGreaterThan(1);

    act(() => { g.push('invite-expired', { callId: 'sess-1', userId: 'u-bob' }); });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-bob')!.state).toBe('missed');
  });

  it('reconnect re-sends status, meta and participant-state', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start(startInput); });
    g.sent.length = 0;
    g.gw.connectionState = 'reconnecting';
    hook.rerender({ gateway: { ...g.gw } });
    expect(hook.result.current.phase).toBe('reconnecting');
    g.gw.connectionState = 'connected';
    g.gw.sessionEpoch = 2;
    hook.rerender({ gateway: { ...g.gw } });
    expect(g.callFrames('status')[0]).toMatchObject({ lobbyName: 'doc-auth' });
    expect(g.callFrames('meta')[0]).toMatchObject({ callId: 'sess-1' });
    expect(g.callFrames('participant-state')[0]).toMatchObject({ callId: 'sess-1', status: 'in-call' });
    expect(hook.result.current.phase).toBe('active');
  });

  it('follow is persisted per tab and survives a remount', async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.start(startInput); });
    act(() => { hook.result.current.follow('u-alice'); });
    expect(sessionStorage.getItem('doc-call:follow:sess-1')).toBe('u-alice');
    expect(hook.result.current.following).toMatchObject({ userId: 'u-alice' });
    act(() => { hook.result.current.follow(null); });
    expect(sessionStorage.getItem('doc-call:follow:sess-1')).toBeNull();
  });

  it('a follower navigates when the person they follow presents another document; host takeover moves the follow', async () => {
    const { g, hook, onNavigate } = setup({ identity: { userId: 'u-frank', displayName: 'Frank Davis' } });
    act(() => { g.push('active-call', { lobbyName: 'doc-auth', active: true, callId: 'sess-9', participantCount: 3 }); });
    await act(async () => { await hook.result.current.join('sess-9', { micOn: true, cameraOn: false }); });
    expect(g.callFrames('accepted')[0]).toMatchObject({ callId: 'sess-9', userId: 'u-frank' });
    expect(g.callFrames('meta')[0]).toMatchObject({ callId: 'sess-9' });
    const meta = (presenting: unknown) => ({
      callId: 'sess-9', documentId: 'doc-auth', title: 'T', documentIds: ['doc-auth', 'doc-migration'], hostUserId: 'u-host',
      media: 'video', startedAt: Date.now(), presenting, invites: { 'u-frank': { at: 1, state: 'accepted' } },
    });
    act(() => { g.push('call-meta', meta({ documentId: 'doc-auth', userId: 'u-alice', since: 1 })); });
    act(() => { hook.result.current.follow('u-alice'); });
    expect(onNavigate).not.toHaveBeenCalled();
    act(() => { g.push('call-meta', meta({ documentId: 'doc-migration', userId: 'u-alice', since: 2 })); });
    expect(onNavigate).toHaveBeenLastCalledWith('doc-migration');
    expect(hook.result.current.following).toMatchObject({ userId: 'u-alice', location: { documentId: 'doc-migration' } });
    // The app routes there; the page now shows doc-migration and the call stays.
    hook.rerender({ documentId: 'doc-migration' });
    expect(hook.result.current.joined).toBe(true);
    // The host takes over from Alice: Frank was following Alice, so he now follows the host.
    act(() => { g.push('call-meta', meta({ documentId: 'doc-auth', userId: 'u-host', since: 3 })); });
    expect(hook.result.current.following?.userId).toBe('u-host');
    expect(onNavigate).toHaveBeenLastCalledWith('doc-auth');
  });

  it('present / setDocuments / setTitle send their frames (and PATCH the record)', async () => {
    const { g, pa, hook } = setup();
    await act(async () => { await hook.result.current.start(startInput); });
    act(() => { hook.result.current.present('doc-migration'); });
    expect(g.callFrames('present')[0]).toMatchObject({ callId: 'sess-1', documentId: 'doc-migration' });
    await act(async () => { await hook.result.current.setDocuments(['doc-migration', 'doc-new'], { 'doc-new': 'Rollout' }); });
    expect(pa.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ documentIds: ['doc-auth', 'doc-migration', 'doc-new'] });
    expect(g.callFrames('set-documents')[0]).toMatchObject({ documentIds: ['doc-auth', 'doc-migration', 'doc-new'], documentTitles: { 'doc-new': 'Rollout' } });
    await act(async () => { await hook.result.current.setTitle(' New title '); });
    expect(g.callFrames('set-title')[0]).toMatchObject({ title: 'New title' });
    act(() => { hook.result.current.ringAgain('u-bob'); });
    expect(g.callFrames('invite').pop()).toMatchObject({ targetUserIds: ['u-bob'], kind: 'document-review' });
  });

  it('leave ends only this person; the last one out clears activeCallSessionId', async () => {
    const pa = makeFakePlatformApi({ endResult: { ended: true } });
    const { g, hook, updateDocumentMeta } = setup({}, pa);
    await act(async () => { await hook.result.current.start(startInput); });
    await act(async () => { await hook.result.current.leave(); });
    expect(g.callFrames('ended')[0]).toMatchObject({ callId: 'sess-1' });
    expect(g.callFrames('ended')[0].forEveryone).toBeUndefined();
    expect(hook.result.current.joined).toBe(false);
    expect(hook.result.current.phase).toBe('ended');
    expect(updateDocumentMeta).toHaveBeenLastCalledWith({ activeCallSessionId: '' });
  });

  it('an ended frame for the joined call moves to ended', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start(startInput); });
    act(() => { g.push('ended', { callId: 'sess-1', forEveryone: true, reason: 'ended-for-everyone' }); });
    expect(hook.result.current.phase).toBe('ended');
    expect(hook.result.current.ended).toMatchObject({ reason: 'ended-for-everyone' });
    expect(hook.result.current.call).toBeNull();
  });

  it('discovers a live call on the document from platform-api (Join · N state)', async () => {
    const pa = makeFakePlatformApi({ sessions: [
      { sessionId: 'old', documentId: 'doc-auth', status: 'ended', startedAt: '2026-09-01T00:00:00Z', startedBy: 'u-x' },
      { sessionId: 'live', documentId: 'doc-auth', status: 'active', startedAt: '2026-09-24T09:00:00Z', startedBy: 'u-alice', kind: 'document-review', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'], hostUserId: 'u-alice', participantCount: 3 },
    ] });
    const { hook } = setup({}, pa);
    await waitFor(() => expect(hook.result.current.call?.callId).toBe('live'));
    expect(hook.result.current.joined).toBe(false);
    expect(hook.result.current.inCallCount).toBe(3);
    expect(hook.result.current.call).toMatchObject({ title: 'Auth architecture review', hostUserId: 'u-alice' });
  });
});
