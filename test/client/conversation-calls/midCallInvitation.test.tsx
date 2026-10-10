/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, jest } from '@jest/globals';
import { useConversationCall } from '../../../src/client/video/useConversationCall';
import type { GatewayMessage } from '../../../src/client/types';
import type { ConversationCallInviteResult } from '../../../src/client/video/conversationCallTypes';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';

const lobby = 'orgiq:initiative:p-observability';
function setup() {
  const g = makeFakeGateway(), m = makeFakeMedia(), pa = makeFakePlatformApi();
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const gateway = { ...g.gw, onMessage: (fn: (msg: GatewayMessage) => void) => {
    handlers.add(fn); const off = g.gw.onMessage(fn); return () => { handlers.delete(fn); off(); };
  } };
  const stop = jest.fn();
  const camera = { id: 'camera-stable', getTracks: () => [{ id: 'camera-track', stop }] } as unknown as MediaStream;
  const screen = { id: 'screen-stable', getTracks: () => [{ id: 'screen-track', stop }] } as unknown as MediaStream;
  const hook = renderHook(() => useConversationCall({ lobbyName: lobby, channel: 'initiative:p-observability',
    self: { userId: 'u-alice', displayName: 'Alice' }, gateway, platformApi: pa.platformApi, fetch: pa.fetchImpl, deviceStorage: null,
    useMedia: opts => { const media = m.useFakeMedia(opts); return { ...media, isScreenSharing: !!opts.stageToken,
      participants: media.participants.map(person => person.isLocal ? { ...person, streams: [camera], screenStream: screen } : person) }; },
  }));
  const fail = (details: Record<string, unknown>) => {
    for (const fn of handlers) fn({ type: 'error', service: 'call', ...details } as unknown as GatewayMessage);
  };
  const live = async () => {
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' });
      g.push('active-call', { lobbyName: lobby, active: true, callId: 'call-existing', callerId: 'u-bob', participantUserIds: ['u-alice', 'u-bob'], pageHuddle: true }); });
    expect(hook.result.current.phase).toBe('live');
  };
  const invite = (targets: { userId: string; displayName?: string }[] = [{ userId: 'u-carol', displayName: 'Carol' }]) => {
    let result!: ConversationCallInviteResult;
    act(() => { result = hook.result.current.inviteUsers(targets); }); return result;
  };
  return { g, m, pa, gateway, hook, fail, live, invite, stop, camera, screen };
}

describe('native mid-call invitations', () => {
  it('requests unique people on the adopted call without restarting either camera or screen', async () => {
    const s = setup(); await s.live();
    const requests = s.pa.calls.length, mediaActions = s.m.calls.slice(), token = s.m.lastOpts.current!.stageToken;
    const result = s.invite([{ userId: 'u-alice' }, { userId: 'u-bob' }, { userId: '' }, { userId: 'u-carol', displayName: 'Carol' }, { userId: 'u-carol' }]);
    expect(result.requestedUserIds).toEqual(['u-carol']);
    expect(s.g.callFrames('invite')).toEqual([expect.objectContaining({ callId: 'call-existing', lobbyName: lobby,
      callerId: 'u-alice', targetUserIds: ['u-carol'], channel: 'initiative:p-observability', requestId: result.requestId })]);
    expect(s.hook.result.current.invitationRequests).toEqual([expect.objectContaining({ userId: 'u-carol', state: 'requested' })]);
    expect(s.hook.result.current.call!.participantCount).toBe(2);
    expect(s.hook.result.current.call!.participants.some(p => p.userId === 'u-carol')).toBe(false);
    expect(s.hook.result.current.call!.participants[0]!.stream).toBe(s.camera);
    expect(s.hook.result.current.call!.participants[0]!.screenStream).toBe(s.screen);
    expect(s.m.lastOpts.current!.stageToken).toBe(token); expect(s.pa.calls).toHaveLength(requests);
    expect(s.m.calls).toEqual(mediaActions); expect(s.stop).not.toHaveBeenCalled(); s.hook.unmount();
  });

  it('keeps local request distinct until the native accepted frame admits the person', async () => {
    const s = setup(); await s.live(); const requested = s.invite();
    expect(s.invite().requestedUserIds).toEqual([]); expect(s.g.callFrames('invite')).toHaveLength(1);
    act(() => { s.g.push('accepted', { callId: 'call-unrelated', userId: 'u-carol', lobbyName: lobby }); });
    expect(s.hook.result.current.invitationRequests[0]!.state).toBe('requested');
    act(() => { s.g.push('accepted', { callId: 'call-existing', userId: 'u-carol', lobbyName: lobby }); });
    expect(s.hook.result.current.invitationRequests[0]).toMatchObject({ requestId: requested.requestId, state: 'accepted' });
    expect(s.hook.result.current.call!.participantCount).toBe(3);
    expect(s.hook.result.current.call!.participants.find(p => p.userId === 'u-carol')).toMatchObject({ state: 'in-call', displayName: 'Carol' });
    expect(s.invite().requestedUserIds).toEqual([]); s.hook.unmount();
  });

  it('correlates an authorization rejection to its request without deleting a different pending request or live media', async () => {
    const s = setup(); await s.live(); const first = s.invite(); s.invite([{ userId: 'u-dan', displayName: 'Dan' }]);
    act(() => s.fail({ action: 'invite', callId: 'call-existing', requestId: first.requestId, message: 'Not authorized to call those users' }));
    expect(s.hook.result.current.invitationRequests.map(r => [r.userId, r.state])).toEqual([['u-carol', 'failed'], ['u-dan', 'requested']]);
    expect(s.hook.result.current.invitationError).toBe('Not authorized to call those users');
    expect(s.hook.result.current.phase).toBe('live'); expect(s.stop).not.toHaveBeenCalled();
    expect(s.hook.result.current.call!.participants[0]!.screenStream).toBe(s.screen); s.hook.unmount();
  });

  it('exposes a legacy uncorrelated rejection honestly and ignores unrelated scoped errors', async () => {
    const s = setup(); await s.live(); s.invite();
    act(() => s.fail({ action: 'invite', callId: 'another-call', message: 'Other call denied' }));
    act(() => s.fail({ action: 'status', callId: 'call-existing', message: 'Other action denied' }));
    expect(s.hook.result.current.invitationError).toBeNull();
    act(() => s.fail({ message: 'Not authorized for call action: invite' }));
    expect(s.hook.result.current.invitationError).toBe('Not authorized for call action: invite');
    expect(s.hook.result.current.invitationRequests[0]!.state).toBe('requested'); s.hook.unmount();
  });

  it('refuses idle, disconnected, recovering media and ended calls without creating or joining another session', async () => {
    const s = setup(); expect(s.invite().reason).toMatch(/Join a connected call/); await s.live();
    const requests = s.pa.calls.length; s.gateway.connectionState = 'disconnected';
    expect(s.invite().reason).toMatch(/Reconnect/); s.gateway.connectionState = 'connected';
    act(() => s.m.set({ connectionState: 'reconnecting' })); expect(s.invite().reason).toMatch(/Join a connected call/);
    act(() => s.m.set({ connectionState: 'connected' }));
    expect(s.pa.calls).toHaveLength(requests); expect(s.g.callFrames('invite')).toHaveLength(0);
    await act(async () => { await s.hook.result.current.leave(); });
    expect(s.invite().requestedUserIds).toEqual([]); expect(s.hook.result.current.invitationRequests).toEqual([]); s.hook.unmount();
  });

  it('surfaces a local send failure and permits an explicit retry without altering media', async () => {
    const s = setup(); await s.live(); const normal = s.gateway.send;
    s.gateway.send = () => { throw new Error('Socket closed'); };
    expect(s.invite()).toEqual({ requestedUserIds: [], reason: 'Socket closed' });
    expect(s.hook.result.current.invitationRequests[0]!.state).toBe('failed');
    s.gateway.send = normal; expect(s.invite().requestedUserIds).toEqual(['u-carol']);
    expect(s.hook.result.current.invitationError).toBeNull(); expect(s.stop).not.toHaveBeenCalled(); s.hook.unmount();
  });

  it('records decline and busy feedback without ending a page huddle, and permits an explicit fresh request', async () => {
    const s = setup(); await s.live(); s.invite();
    act(() => s.g.push('declined', { callId: 'call-existing', callerId: 'u-carol', lobbyName: lobby }));
    expect(s.hook.result.current.invitationRequests[0]!.state).toBe('declined'); expect(s.hook.result.current.phase).toBe('live');
    expect(s.invite().requestedUserIds).toEqual(['u-carol']);
    act(() => s.g.push('user-status', { callId: 'call-existing', userId: 'u-carol', status: 'busy', lobbyName: lobby }));
    expect(s.hook.result.current.invitationRequests[0]!.state).toBe('busy'); expect(s.hook.result.current.phase).toBe('live'); s.hook.unmount();
  });
});
