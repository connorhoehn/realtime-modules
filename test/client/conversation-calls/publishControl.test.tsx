/**
 * @jest-environment jsdom
 */
// useConversationCall and publish control: the media session's publish state
// reaches the call and the dock, the forced token refresh after a grant goes
// to platform-api, and nothing turns on while the host has you view-only.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useConversationCall, type UseConversationCallOptions } from '../../../src/client/video/useConversationCall';
import { conversationCallDockProps } from '../../../src/client/video/conversationCallDockProps';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';

const LOBBY = 'acme:dm:u-alice:u-bob';
const alice = { userId: 'u-alice', displayName: 'Alice Chen' };
const ui = { title: 'Bob Stone', onOpenPeople: () => undefined, onOpenSettings: () => undefined, tile: () => undefined };

function setup(extra: Partial<UseConversationCallOptions> = {}, pa = makeFakePlatformApi()) {
  const g = makeFakeGateway();
  const m = makeFakeMedia();
  const hook = renderHook(() => useConversationCall({
    lobbyName: LOBBY,
    channel: 'chat:dm:u-alice:u-bob',
    self: alice,
    platformApi: pa.platformApi,
    gateway: g.gw,
    fetch: pa.fetchImpl,
    deviceStorage: null,
    useMedia: m.useFakeMedia,
    ...extra,
  }));
  return { g, m, pa, hook };
}

async function live() {
  const s = setup();
  await act(async () => { await s.hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }]); });
  act(() => { s.g.push('accepted', { callId: s.hook.result.current.call!.callId, userId: 'u-bob', lobbyName: LOBBY }); });
  act(() => { s.m.set({ isJoined: true, connectionState: 'connected', remotes: [{ ...s.m.remote('p-bob'), publishRevoked: true }] }); });
  return s;
}

describe('useConversationCall — publish control', () => {
  it('forwards the publish state and marks view-only people', async () => {
    const { hook } = await live();
    expect(hook.result.current.canPublish).toBe(true);
    expect(hook.result.current.publishRevoked).toBe(false);
    const bob = hook.result.current.call!.participants.find((p) => p.participantId === 'p-bob')!;
    expect(bob.publishRevoked).toBe(true);
    expect(hook.result.current.call!.participants.find((p) => p.isLocal)!.publishRevoked).toBe(false);
  });

  it('a revocation turns our mic, camera and share off, tells the call, and blocks turning them on', async () => {
    const { g, m, hook } = await live();
    g.sent.length = 0;
    act(() => { m.set({ canPublish: false, publishRevoked: true, publishRevokedReason: 'off topic' }); });
    const r = hook.result.current;
    expect(r.publishRevoked).toBe(true);
    expect(r.publishRevokedReason).toBe('off topic');
    expect(r.self).toEqual({ audioOn: false, cameraOn: false, screenSharing: false });
    expect(r.call!.participants.find((p) => p.isLocal)!.publishRevoked).toBe(true);
    expect(g.callFrames('participant-state').at(-1)).toMatchObject({ audioOn: false, cameraOn: false, screenSharing: false });

    m.calls.length = 0;
    act(() => { hook.result.current.toggleMic(); hook.result.current.toggleCamera(); hook.result.current.toggleScreenShare(); });
    expect(m.calls).toEqual([]);
    expect(hook.result.current.self).toEqual({ audioOn: false, cameraOn: false, screenSharing: false });

    const dock = conversationCallDockProps(hook.result.current, ui)!;
    expect(dock.mic.disabledReason).toMatch(/view-only/i);
    expect(dock.camera.disabledReason).toMatch(/view-only/i);
    expect(dock.screenShare.disabledReason).toMatch(/view-only/i);
  });

  it('startPublishing after a grant turns our state back on only when it publishes', async () => {
    const { m, hook } = await live();
    act(() => { m.set({ canPublish: false, publishRevoked: true }); });
    act(() => { m.set({ canPublish: true, publishRevoked: false }); });
    expect(hook.result.current.self.audioOn).toBe(false);
    expect(conversationCallDockProps(hook.result.current, ui)!.mic.disabledReason).toBeUndefined();

    m.set({ startPublishingResult: false });
    let ok: boolean | undefined;
    await act(async () => { ok = await hook.result.current.startPublishing!(); });
    expect(ok).toBe(false);
    expect(hook.result.current.self.audioOn).toBe(false);

    m.set({ startPublishingResult: true });
    await act(async () => { ok = await hook.result.current.startPublishing!(); });
    expect(ok).toBe(true);
    expect(hook.result.current.self).toMatchObject({ audioOn: true, cameraOn: true });
  });

  it('the forced refresh after a grant asks platform-api for a new token; later calls get it', async () => {
    const { m, pa } = await live();
    const getAuthToken = m.lastOpts.current!.getAuthToken!;
    expect(await getAuthToken()).toBe('stage-token');
    expect(await getAuthToken({ forceRefresh: true, reason: 'publish-granted' })).toBe('refreshed-1');
    const refresh = pa.calls.find((c) => /\/refresh-token$/.test(c.path))!;
    expect(refresh).toMatchObject({ method: 'POST', path: '/api/video/sessions/sess-1/refresh-token', body: { lobbyName: LOBBY, participantId: 'p-self-1' } });
    expect(await getAuthToken()).toBe('refreshed-1');
  });

  it('a refused forced refresh rejects (the publish fails) and keeps the current token', async () => {
    const s = setup({}, makeFakePlatformApi({ refreshStatus: 409 }));
    await act(async () => { await s.hook.result.current.start([{ userId: 'u-bob', displayName: 'Bob Stone' }]); });
    const getAuthToken = s.m.lastOpts.current!.getAuthToken!;
    await expect(getAuthToken({ forceRefresh: true, reason: 'publish-granted' })).rejects.toMatchObject({ status: 409 });
    expect(await getAuthToken()).toBe('stage-token');
  });

  it('a subscriber who has not been granted sees the controls disabled as a viewer', async () => {
    const { m, hook } = await live();
    act(() => { m.set({ canPublish: false, publishRevoked: false }); });
    const dock = conversationCallDockProps(hook.result.current, ui)!;
    expect(dock.mic.disabledReason).toMatch(/viewer/i);
    expect(dock.camera.disabledReason).toMatch(/viewer/i);
  });
});
