/**
 * @jest-environment jsdom
 */
// useConversationCall against a fake gateway, a fake platform-api and a fake
// media layer: ring → accept → live → leave, both sides, with a tenant-prefixed
// lobby that must never be rewritten and frames that must never be broadcast.

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationCall, type UseConversationCallOptions } from '../../../src/client/video/useConversationCall';
import { useIncomingConversationCalls } from '../../../src/client/video/useIncomingConversationCalls';
import { conversationCallDockProps } from '../../../src/client/video/conversationCallDockProps';
import { dmLobbyName } from '../../../src/client/video/conversationLobby';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';

const LOBBY = dmLobbyName(['u-bob', 'u-alice'], { prefix: 'acme:' });
const alice = { userId: 'u-alice', displayName: 'Alice Chen' };

function setup(extra: Partial<UseConversationCallOptions> = {}, pa = makeFakePlatformApi()) {
  const g = makeFakeGateway();
  const m = makeFakeMedia();
  const onCallStarted = jest.fn();
  const onCallEnded = jest.fn();
  const onCallMissed = jest.fn();
  const hook = renderHook(() => useConversationCall({
    lobbyName: LOBBY,
    channel: 'chat:dm:u-alice:u-bob',
    self: alice,
    platformApi: pa.platformApi,
    gateway: g.gw,
    fetch: pa.fetchImpl,
    deviceStorage: null,
    useMedia: m.useFakeMedia,
    onCallStarted,
    onCallEnded,
    onCallMissed,
    endedHoldMs: 50,
    ...extra,
  }));
  return { g, m, pa, hook, onCallStarted, onCallEnded, onCallMissed };
}

const ui = { title: 'Bob Stone', onOpenPeople: () => undefined, onOpenSettings: () => undefined, tile: () => undefined };

/** Every call frame except the `status` query names who it is for. */
function expectAllTargeted(sent: Record<string, any>[]) {
  for (const f of sent.filter((x) => x.service === 'call' && x.action !== 'status')) {
    expect(Array.isArray(f.targetUserIds) && f.targetUserIds.length > 0).toBe(true);
  }
}

afterEach(() => { jest.useRealTimers(); });

describe('useConversationCall — caller', () => {
  it('dmLobbyName sorts members and prefixes verbatim', () => {
    expect(LOBBY).toBe('acme:dm:u-alice:u-bob');
    expect(dmLobbyName(['b', 'a', 'a', ''])).toBe('dm:a:b');
  });

  it('start → PA session on the verbatim lobby, a targeted invite, phase calling', async () => {
    const { g, pa, hook } = setup();
    expect(g.callFrames('status')[0]).toMatchObject({ lobbyName: LOBBY });
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }]); });

    const create = pa.calls.find((c) => c.path === '/api/video/sessions')!;
    expect(create.body).toMatchObject({ lobbyName: LOBBY, documentId: LOBBY, findOrCreate: true, displayName: 'Alice Chen' });
    expect(create.headers.Authorization).toBe('Bearer id-token');
    expect(pa.calls.some((c) => c.path === '/api/video/sessions/sess-1/join' && c.body.lobbyName === LOBBY)).toBe(true);

    const [inv] = g.callFrames('invite');
    expect(inv).toMatchObject({ lobbyName: LOBBY, callerId: 'u-alice', callerName: 'Alice Chen', targetUserIds: ['u-bob'], channel: 'chat:dm:u-alice:u-bob' });
    expect(String(inv.callId)).toMatch(/^call-/);

    const r = hook.result.current;
    expect(r.phase).toBe('calling');
    expect(r.callingTo).toBe('Bob Stone');
    expect(r.call).toMatchObject({ lobbyName: LOBBY, startedAt: null, host: 'u-alice', participantCount: 1 });
    expect(r.call!.participants.map((p) => [p.userId, p.state])).toEqual([['u-alice', 'in-call'], ['u-bob', 'ringing']]);

    const dock = conversationCallDockProps(r, ui)!;
    expect(dock).toMatchObject({ phase: 'calling', callingTo: 'Bob Stone', elapsedMs: null, participantCount: 1, localParticipantId: 'p-self-1' });
    expect(dock.participants.map((p) => p.userId)).toEqual(['p-self-1']);
    expectAllTargeted(g.sent);
  });

  it('accepted → started, live once media is up, participant-state to the callee', async () => {
    const { g, m, hook, onCallStarted } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { g.push('accepted', { callId, callerId: 'u-bob', userId: 'u-bob', displayName: 'Bob Stone', lobbyName: LOBBY }); });

    expect(onCallStarted).toHaveBeenCalledWith(expect.objectContaining({ callId, lobbyName: LOBBY, peerUserIds: ['u-bob'] }));
    expect(hook.result.current.phase).toBe('live');
    expect(hook.result.current.call!.participantCount).toBe(2);
    const ps = g.callFrames('participant-state').at(-1)!;
    expect(ps).toMatchObject({ callId, lobbyName: LOBBY, userId: 'u-alice', participantId: 'p-self-1', targetUserIds: ['u-bob'], status: 'in-call' });

    // Bob's tile arrives and his announcement names it.
    act(() => {
      m.set({ remotes: [m.remote('p-bob')] });
      g.push('participant-state', { callId, userId: 'u-bob', displayName: 'Bob Stone', participantId: 'p-bob', audioOn: false, cameraOn: true, status: 'in-call' });
    });
    const people = hook.result.current.call!.participants;
    expect(people.map((p) => [p.id, p.userId, p.displayName, p.audioOn])).toEqual([
      ['p-self-1', 'u-alice', 'Alice Chen', true],
      ['p-bob', 'u-bob', 'Bob Stone', false],
    ]);
    const dock = conversationCallDockProps(hook.result.current, ui)!;
    expect(dock.phase).toBe('active');
    expect(dock.participantCount).toBe(2);
    expect(typeof dock.elapsedMs).toBe('number');
    expect(dock.participants[1]).toMatchObject({ id: 'p-bob', userId: 'p-bob', audioOn: false, isMuted: true, connection: 'connected' });
    expectAllTargeted(g.sent);
  });

  it('leave → left to the peer, ended to yourself, PA end, media leave, onCallEnded', async () => {
    const { g, m, pa, hook, onCallEnded } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { g.push('accepted', { callId, userId: 'u-bob', lobbyName: LOBBY }); });
    await act(async () => { await hook.result.current.leave(); });

    expect(g.callFrames('user-status').at(-1)).toMatchObject({ callId, status: 'left', reason: 'hung-up', targetUserIds: ['u-bob'] });
    expect(g.callFrames('ended').at(-1)).toMatchObject({ callId, targetUserIds: ['u-alice'] });
    expect(g.callFrames('cancelled')).toHaveLength(0);
    await waitFor(() => expect(pa.calls.some((c) => c.path === '/api/video/sessions/sess-1/end')).toBe(true));
    expect(pa.calls.find((c) => c.path.endsWith('/end'))!.body).toMatchObject({ lobbyName: LOBBY, participantId: 'p-self-1', userId: 'u-alice' });
    expect(m.calls).toContain('leave');
    expect(onCallEnded).toHaveBeenCalledWith(expect.objectContaining({ callId, reason: 'left' }));
    expect(hook.result.current.phase).toBe('ended');
    expect(conversationCallDockProps(hook.result.current, ui)!.phase).toBe('ended');
    await waitFor(() => expect(hook.result.current.phase).toBe('idle'));
    expect(conversationCallDockProps(hook.result.current, ui)).toBeNull();
    expectAllTargeted(g.sent);
  });

  it('hanging up before an answer cancels the ring', async () => {
    const { g, hook, onCallEnded } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    await act(async () => { await hook.result.current.leave(); });
    expect(g.callFrames('cancelled')[0]).toMatchObject({ targetUserIds: ['u-bob'], lobbyName: LOBBY });
    expect(onCallEnded).not.toHaveBeenCalled();
  });

  it('a decline from everyone rung ends the attempt', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { g.push('declined', { callId, callerId: 'u-bob', lobbyName: LOBBY }); });
    expect(hook.result.current.phase).toBe('ended');
    expect(hook.result.current.ended!.reason).toBe('declined');
  });

  it('nobody answers → cancelled after the ring timeout, onCallMissed', async () => {
    jest.useFakeTimers();
    const { g, hook, onCallMissed } = setup({ ringTimeoutMs: 1000 });
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    await act(async () => { jest.advanceTimersByTime(1001); });
    expect(g.callFrames('cancelled')).toHaveLength(1);
    expect(onCallMissed).toHaveBeenCalledWith(expect.objectContaining({ direction: 'outgoing' }));
    expect(hook.result.current.ended!.reason).toBe('no-answer');
  });

  it('a peer hanging up ends a two-person call; a refresh only marks them reconnecting', async () => {
    const { g, m, hook, onCallEnded } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { g.push('accepted', { callId, userId: 'u-bob', lobbyName: LOBBY }); });
    act(() => { g.push('user-status', { callId, userId: 'u-bob', status: 'left', reason: 'unload', lobbyName: LOBBY }); });
    expect(hook.result.current.call!.participants.find((p) => p.userId === 'u-bob')!.state).toBe('reconnecting');
    act(() => { g.push('user-status', { callId, userId: 'u-bob', status: 'left', reason: 'hung-up', lobbyName: LOBBY }); });
    expect(hook.result.current.phase).toBe('ended');
    expect(onCallEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'peer-left' }));
  });

  it('a media failure is failed; rejoin makes a fresh session in the same call', async () => {
    const { m, pa, hook } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ connectionState: 'failed' }); });
    expect(hook.result.current.phase).toBe('failed');
    const dock = conversationCallDockProps(hook.result.current, ui)!;
    expect(dock.phase).toBe('error');
    expect(dock.error).toMatchObject({ title: 'Lost the call', retryLabel: 'Rejoin' });
    act(() => { m.set({ connectionState: 'connecting' }); });
    await act(async () => { await hook.result.current.rejoin(); });
    expect(pa.calls.filter((c) => /\/join$/.test(c.path))).toHaveLength(2);
    expect(hook.result.current.call!.callId).toBe(callId);
  });

  it('a join refused by platform-api is failed with its status', async () => {
    const { hook } = setup({}, makeFakePlatformApi({ joinStatus: 410 }));
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    expect(hook.result.current.phase).toBe('failed');
    expect(hook.result.current.error).toMatchObject({ message: 'This call has ended.', status: 410 });
  });

  it('mic / camera toggles drive the media layer and re-announce', async () => {
    const { g, m, hook } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { g.push('accepted', { callId, userId: 'u-bob', lobbyName: LOBBY }); });
    act(() => { hook.result.current.toggleMic(); });
    act(() => { hook.result.current.toggleCamera(); });
    expect(m.calls).toEqual(expect.arrayContaining(['mute:true', 'camera:false']));
    expect(hook.result.current.self).toEqual({ audioOn: false, cameraOn: false, screenSharing: false });
    expect(g.callFrames('participant-state').at(-1)).toMatchObject({ audioOn: false, cameraOn: false, targetUserIds: ['u-bob'] });
  });
});

describe('useConversationCall — callee', () => {
  const ringFrame = (extra: Record<string, unknown> = {}) => ({
    callId: 'call-bob-1', lobbyName: LOBBY, callerId: 'u-bob', callerName: 'Bob Stone', targetUserIds: ['u-alice'], ...extra,
  });

  it('a ring for this lobby is ringing; other lobbies and my own invites are not', () => {
    const { g, hook } = setup();
    act(() => { g.push('invite', ringFrame({ lobbyName: 'acme:dm:u-alice:u-carol', callId: 'x' })); });
    act(() => { g.push('invite', ringFrame({ callerId: 'u-alice', callId: 'y' })); });
    act(() => { g.push('invite', ringFrame({ kind: 'document-review', callId: 'z' })); });
    expect(hook.result.current.phase).toBe('idle');
    act(() => { g.push('invite', ringFrame()); });
    expect(hook.result.current.phase).toBe('ringing');
    expect(hook.result.current.incoming).toMatchObject({ callId: 'call-bob-1', callerName: 'Bob Stone', targeted: true, lobbyName: LOBBY });
    expect(conversationCallDockProps(hook.result.current, ui)).toBeNull();
  });

  it('accept → accepted to the caller, PA join on the lobby, live with the caller', async () => {
    const { g, m, pa, hook, onCallStarted } = setup();
    act(() => { g.push('invite', ringFrame()); });
    await act(async () => { await hook.result.current.accept(); });
    expect(g.callFrames('accepted')[0]).toMatchObject({ callId: 'call-bob-1', callerId: 'u-alice', userId: 'u-alice', targetUserIds: ['u-bob'], lobbyName: LOBBY });
    expect(pa.calls.find((c) => c.path === '/api/video/sessions')!.body).toMatchObject({ lobbyName: LOBBY, findOrCreate: true });
    expect(onCallStarted).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-bob-1', peerUserIds: ['u-bob'] }));
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    const r = hook.result.current;
    expect(r.phase).toBe('live');
    expect(r.incoming).toBeNull();
    expect(r.call).toMatchObject({ callId: 'call-bob-1', host: 'u-bob', participantCount: 2 });
    expect(r.call!.participants.map((p) => p.displayName)).toEqual(['Alice Chen', 'Bob Stone']);
    expectAllTargeted(g.sent);
  });

  it('decline → declined to the caller, back to idle', () => {
    const { g, hook } = setup();
    act(() => { g.push('invite', ringFrame()); });
    act(() => { hook.result.current.decline('busy'); });
    expect(g.callFrames('declined')[0]).toMatchObject({ callId: 'call-bob-1', targetUserIds: ['u-bob'], callerId: 'u-alice', reason: 'busy' });
    expect(hook.result.current.phase).toBe('idle');
  });

  it('the caller giving up stops the ring and is a missed call', () => {
    const { g, hook, onCallMissed } = setup();
    act(() => { g.push('invite', ringFrame()); });
    act(() => { g.push('cancelled', { callId: 'call-bob-1', callerId: 'u-bob', lobbyName: LOBBY }); });
    expect(hook.result.current.phase).toBe('idle');
    expect(onCallMissed).toHaveBeenCalledWith(expect.objectContaining({ direction: 'incoming', peerUserIds: ['u-bob'] }));
  });

  it('a server-synthetic end of the call ends it for me', async () => {
    const { g, m, hook, onCallEnded } = setup();
    act(() => { g.push('invite', ringFrame()); });
    await act(async () => { await hook.result.current.accept(); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { g.push('ended', { callId: 'call-bob-1', reason: 'rejoin-grace-expired', lobbyName: LOBBY }); });
    expect(hook.result.current.phase).toBe('ended');
    expect(onCallEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rejoin-grace-expired' }));
  });

  it('answering from the app-wide toast clears this surface', async () => {
    const g = makeFakeGateway();
    const m = makeFakeMedia();
    const pa = makeFakePlatformApi();
    const both = renderHook(() => ({
      toast: useIncomingConversationCalls({ gateway: g.gw, self: { userId: 'u-alice' } }),
      thread: useConversationCall({ lobbyName: LOBBY, self: alice, platformApi: pa.platformApi, gateway: g.gw, fetch: pa.fetchImpl, deviceStorage: null, useMedia: m.useFakeMedia }),
    }));
    act(() => { g.push('invite', ringFrame()); });
    expect(both.result.current.toast.rings).toHaveLength(1);
    expect(both.result.current.thread.phase).toBe('ringing');
    const ring = both.result.current.toast.rings[0]!;
    act(() => { both.result.current.toast.accept(ring); });
    await act(async () => { await both.result.current.thread.accept(ring); });
    expect(both.result.current.toast.rings).toHaveLength(0);
    expect(both.result.current.thread.call!.callId).toBe('call-bob-1');
  });
});

describe('useConversationCall — discovery', () => {
  it('a live call in the lobby is offered; rejoin joins it', async () => {
    const { g, pa, hook } = setup();
    act(() => { g.push('active-call', { lobbyName: LOBBY, active: true, callId: 'call-live', participantUserIds: ['u-bob'] }); });
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.call).toMatchObject({ callId: 'call-live', participantCount: 1 });
    await act(async () => { await hook.result.current.rejoin(); });
    expect(g.callFrames('accepted')[0]).toMatchObject({ callId: 'call-live', targetUserIds: ['u-bob'], lobbyName: LOBBY });
    expect(pa.calls.some((c) => /\/join$/.test(c.path))).toBe(true);
    expect(hook.result.current.call!.callId).toBe('call-live');
  });

  it('a reconnect re-asks status and re-announces', async () => {
    const { g, hook } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { g.push('accepted', { callId, userId: 'u-bob', lobbyName: LOBBY }); });
    const before = g.callFrames('participant-state').length;
    g.gw.sessionEpoch = 2;
    hook.rerender();
    expect(g.callFrames('status')).toHaveLength(2);
    expect(g.callFrames('participant-state').length).toBeGreaterThan(before);
  });
});
