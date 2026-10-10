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

  it('start([]) rings nobody but seats you: one targetless-by-design join, never an invite', async () => {
    const { g, hook } = setup({ lobbyName: 'assessment:team:T-1', channel: undefined });
    await act(async () => { await hook.result.current.start([]); });
    expect(g.callFrames('invite')).toHaveLength(0);
    const [join] = g.callFrames('join');
    expect(join).toMatchObject({ lobbyName: 'assessment:team:T-1', callerId: 'u-alice', callerName: 'Alice Chen' });
    expect(String(join.callId)).toMatch(/^call-/);
  });

  it('a page huddle adopts the id the gateway seats it in, and survives its last peer leaving', async () => {
    const lobby = 'assessment:team:T-1';
    const { g, m, hook, onCallEnded } = setup({ lobbyName: lobby, channel: undefined });
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    // Someone else's huddle was already live: the gateway answers our join with its id and its people.
    act(() => { g.push('active-call', { lobbyName: lobby, active: true, callId: 'call-live', callerId: 'u-bob', participantUserIds: ['u-bob', 'u-alice'], pageHuddle: true }); });
    expect(hook.result.current.call!.callId).toBe('call-live');
    expect(hook.result.current.call!.participants.map((p) => p.userId)).toContain('u-bob');
    expect(g.callFrames('participant-state').some((f) => f.callId === 'call-live' && (f.targetUserIds as string[]).includes('u-bob'))).toBe(true);
    // Bob leaves: a huddle with only you in it is still a huddle.
    act(() => { g.push('user-status', { callId: 'call-live', userId: 'u-bob', status: 'left', reason: 'hung-up', lobbyName: lobby }); });
    expect(hook.result.current.phase).not.toBe('ended');
    expect(onCallEnded).not.toHaveBeenCalled();
    // Leaving releases only your seat: `ended` aimed at yourself, with the adopted id.
    await act(async () => { await hook.result.current.leave(); });
    expect(g.callFrames('ended').at(-1)).toMatchObject({ callId: 'call-live', targetUserIds: ['u-alice'] });
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

  it("a peer's socket drop (left with rejoinGraceMs) holds the call as reconnecting; their re-announce brings them back", async () => {
    const { g, m, hook, onCallEnded } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { g.push('accepted', { callId, userId: 'u-bob', lobbyName: LOBBY }); });
    // What the server sends the survivor when the other side's socket drops.
    act(() => { g.push('user-status', { callId, userId: 'u-bob', status: 'left', reason: 'peer-disconnected', rejoinGraceMs: 30_000, lobbyName: LOBBY }); });
    expect(hook.result.current.phase).toBe('live');
    expect(onCallEnded).not.toHaveBeenCalled();
    expect(hook.result.current.call!.participants.find((p) => p.userId === 'u-bob')!.state).toBe('reconnecting');
    act(() => { g.push('participant-state', { callId, userId: 'u-bob', status: 'in-call', lobbyName: LOBBY }); });
    expect(hook.result.current.call!.participants.find((p) => p.userId === 'u-bob')!.state).toBe('in-call');
    // If they never come back, the server ends it.
    act(() => { g.push('ended', { callId, lobbyName: LOBBY, reason: 'rejoin-grace-expired' }); });
    expect(hook.result.current.phase).toBe('ended');
  });

  it('dmLobbyName refuses an id containing ":" (it would collide with another member set)', () => {
    expect(() => dmLobbyName(['a', 'b:c'])).toThrow(/contains ':'/);
    expect(() => dmLobbyName(['a:b', 'c'], { prefix: 'acme:' })).toThrow(/contains ':'/);
    expect(dmLobbyName(['u-b', 'u-a'], { prefix: 'acme:' })).toBe('acme:dm:u-a:u-b');
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

describe('useConversationCall — room calls name tiles from the SFU', () => {
  // A room call rings nobody and broadcasts to nobody, so no call frame ever
  // carries a peer's name. The SFU does: useLVSHangout surfaces the stage
  // token's displayName + sub (appUserId). Before, the dock read raw SFU ids.
  const named = (m: ReturnType<typeof makeFakeMedia>, pid: string, displayName: string, appUserId: string) =>
    ({ ...m.remote(pid), displayName, appUserId });

  it('a walk-in with no ring is labelled with their name, not the SFU participant id', async () => {
    const { m, hook } = setup({ lobbyName: 'social:room:standup', channel: 'room:standup' });
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => { m.set({ remotes: [named(m, 'u-sana-munmjc0n', 'Sana Iqbal', 'u-sana')] }); });
    const people = hook.result.current.call!.participants;
    expect(people.map((p) => [p.id, p.displayName])).toEqual([
      ['p-self-1', 'Alice Chen'],
      ['u-sana-munmjc0n', 'Sana Iqbal'],
    ]);
    expect(hook.result.current.call!.participantCount).toBe(2);
    const dock = conversationCallDockProps(hook.result.current, ui)!;
    expect(dock.participants[1]).toMatchObject({ id: 'u-sana-munmjc0n', displayName: 'Sana Iqbal' });
  });

  it('the SFU user id matches a person the call already knows — one tile, not two', async () => {
    const { g, m, hook } = setup();
    await act(async () => { await hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }, { userId: 'u-cara', displayName: 'Cara Diaz' }]); });
    const callId = hook.result.current.call!.callId;
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    act(() => {
      g.push('accepted', { callId, userId: 'u-bob', displayName: 'Bob Stone', lobbyName: LOBBY });
      g.push('accepted', { callId, userId: 'u-cara', displayName: 'Cara Diaz', lobbyName: LOBBY });
    });
    // Two tiles, two people, no participant-state yet: the one-and-one
    // heuristic cannot pair them; the SFU user id does.
    act(() => { m.set({ remotes: [named(m, 'p-cara', 'Cara D.', 'u-cara'), named(m, 'p-bob', 'Bob S.', 'u-bob')] }); });
    const people = hook.result.current.call!.participants;
    expect(people.map((p) => [p.id, p.userId, p.displayName])).toEqual([
      ['p-self-1', 'u-alice', 'Alice Chen'],
      ['p-cara', 'u-cara', 'Cara Diaz'],
      ['p-bob', 'u-bob', 'Bob Stone'],
    ]);
  });
});


describe('useConversationCall initial device capture', () => {
  it('start captures neither device and advertises both off from the first join', async () => {
    const { hook, m, g } = setup({ initialMedia: { micOn: false, cameraOn: false } });
    await act(async () => { await hook.result.current.start([]); });
    expect(m.lastOpts.current!.media).toEqual({ audio: false, video: false });
    expect(hook.result.current.self).toMatchObject({ audioOn: false, cameraOn: false });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    expect(hook.result.current.phase).toBe('live');
    act(() => { g.push('active-call', { lobbyName: LOBBY, active: true, callId: hook.result.current.call!.callId, participantUserIds: ['u-bob', alice.userId], pageHuddle: true }); });
    expect(g.callFrames('participant-state').at(-1)).toMatchObject({ audioOn: false, cameraOn: false });
  });
  it('accept preserves both-off and never overrides an audio-only incoming call', async () => {
    const { hook, m } = setup({ initialMedia: { micOn: false, cameraOn: true } });
    await act(async () => { await hook.result.current.accept({ callId: 'incoming-no-media', lobbyName: LOBBY, channel: null, kind: 'invite', callerId: 'u-bob', callerName: 'Bob', audioOnly: true, targeted: true, receivedAt: 1 }); });
    expect(m.lastOpts.current!.media).toEqual({ audio: false, video: false });
    expect(hook.result.current.self).toMatchObject({ audioOn: false, cameraOn: false });
  });
  it('joining a discovered huddle captures only the selected microphone', async () => {
    const { hook, m, g } = setup({ initialMedia: { micOn: true, cameraOn: false }, devices: { microphoneId: 'chosen-mic' } });
    act(() => { g.push('active-call', { lobbyName: LOBBY, active: true, callId: 'discovered', participantUserIds: ['u-bob'], pageHuddle: true }); });
    await act(async () => { await hook.result.current.rejoin(); });
    expect(m.lastOpts.current!.media).toEqual({ audio: { deviceId: { ideal: 'chosen-mic' } }, video: false });
    expect(hook.result.current.self).toMatchObject({ audioOn: true, cameraOn: false });
  });
  it('rejoining a lost active call keeps current muted/off states, without reacquiring either device', async () => {
    const { hook, m } = setup();
    await act(async () => { await hook.result.current.start([]); });
    act(() => { hook.result.current.toggleMic(); hook.result.current.toggleCamera(); });
    await act(async () => { await hook.result.current.rejoin(); });
    expect(m.lastOpts.current!.media).toEqual({ audio: false, video: false });
    expect(hook.result.current.self).toMatchObject({ audioOn: false, cameraOn: false });
  });
  it('denied later camera/microphone acquisition keeps flags off and the active call live', async () => {
    const m = makeFakeMedia();
    const requests: Array<{ kind: string; constraints: unknown }> = [];
    const { hook } = setup({ initialMedia: { micOn: false, cameraOn: false }, devices: { microphoneId: 'mic-2', cameraId: 'cam-2' }, useMedia: opts => ({ ...m.useFakeMedia(opts),
      setMicrophoneEnabled: async (_on, constraints) => { requests.push({ kind: 'audio', constraints }); throw new Error('denied'); },
      setCameraEnabled: async (_on, constraints) => { requests.push({ kind: 'video', constraints }); throw new Error('denied'); },
    }) });
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    await act(async () => { hook.result.current.toggleMic(); hook.result.current.toggleCamera(); await Promise.resolve(); });
    expect(requests).toEqual([{ kind: 'audio', constraints: { deviceId: { ideal: 'mic-2' } } }, { kind: 'video', constraints: expect.objectContaining({ deviceId: { ideal: 'cam-2' } }) }]);
    expect(hook.result.current.self).toMatchObject({ audioOn: false, cameraOn: false });
    expect(hook.result.current.phase).toBe('live');
    expect(hook.result.current.error).toBeNull();
  });
  it('late enabled-device receipt from a departed call cannot change the next call', async () => {
    const m = makeFakeMedia();
    let resolve!: () => void;
    const { hook } = setup({ initialMedia: { micOn: false, cameraOn: false }, useMedia: opts => ({ ...m.useFakeMedia(opts), setCameraEnabled: () => new Promise<void>(done => { resolve = done; }) }) });
    await act(async () => { await hook.result.current.start([]); });
    act(() => { hook.result.current.toggleCamera(); });
    await act(async () => { await hook.result.current.leave(); await hook.result.current.start([]); });
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(hook.result.current.self.cameraOn).toBe(false);
  });
});
