/**
 * @jest-environment jsdom
 */
// useDocumentCall and publish control: the media session's publish state
// reaches the hook, the people list shows who is view-only, and the host can
// revoke / grant through platform-api.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import {
  useDocumentCall,
  type DocumentCallMediaBinding,
  type UseDocumentCallOptions,
} from '../../../src/client/video/useDocumentCall';
import { makeFakeGateway, makeFakePlatformApi } from './fakeGateway';

const host = { userId: 'u-host', displayName: 'Connor Hoehn' };
const startInput = {
  title: 'Review', media: 'video' as const, documentIds: ['doc-auth'], targetUserIds: ['u-alice'],
  ring: false, micOn: true, cameraOn: true,
};

function setup(extra: Partial<UseDocumentCallOptions> = {}, pa = makeFakePlatformApi()) {
  const g = makeFakeGateway();
  const hook = renderHook((props: Partial<UseDocumentCallOptions>) => useDocumentCall({
    documentId: 'doc-auth',
    gateway: g.gw,
    platformApi: pa.platformApi,
    fetch: pa.fetchImpl,
    identity: host,
    linkBase: 'https://app.test',
    ...extra,
    ...props,
  }), { initialProps: {} });
  return { g, pa, hook };
}

function binding(over: Partial<DocumentCallMediaBinding> = {}): DocumentCallMediaBinding {
  return {
    connectionState: 'connected',
    setMicEnabled: jest.fn<(on: boolean) => void>(),
    setCameraEnabled: jest.fn<(on: boolean) => void>(),
    startScreenShare: jest.fn<() => void>(),
    stopScreenShare: jest.fn<() => void>(),
    canPublish: true,
    publishRevoked: false,
    publishRevokedReason: null,
    ...over,
  };
}

beforeEach(() => { sessionStorage.clear(); });

describe('useDocumentCall — our own publishing', () => {
  it('surfaces the media session publish state; a revocation turns our mic, camera and share off and says so', async () => {
    const media = binding();
    const { g, hook } = setup({ media });
    await act(async () => { await hook.result.current.start(startInput); });
    expect(hook.result.current.canPublish).toBe(true);
    expect(hook.result.current.publishRevoked).toBe(false);
    g.sent.length = 0;

    hook.rerender({ media: { ...media, canPublish: false, publishRevoked: true, publishRevokedReason: 'off topic' } });
    const r = hook.result.current;
    expect(r.canPublish).toBe(false);
    expect(r.publishRevoked).toBe(true);
    expect(r.publishRevokedReason).toBe('off topic');
    expect(r.self).toEqual({ audioOn: false, cameraOn: false, screenSharing: false });
    expect(r.participants[0]).toMatchObject({ isSelf: true, publishRevoked: true, audioOn: false, cameraOn: false, participantId: 'p-1' });
    expect(g.callFrames('participant-state').at(-1)).toMatchObject({ audioOn: false, cameraOn: false, screenSharing: false });
  });

  it('turning a device on does nothing while revoked; turning it off still works', async () => {
    const media = binding({ canPublish: false, publishRevoked: true });
    const { hook } = setup({ media });
    await act(async () => { await hook.result.current.start(startInput); });
    (media.setMicEnabled as jest.Mock).mockClear();
    (media.setCameraEnabled as jest.Mock).mockClear();
    act(() => { hook.result.current.toggleMic(); });
    act(() => { hook.result.current.toggleCamera(); });
    act(() => { hook.result.current.startScreenShare(); });
    expect(media.setMicEnabled).not.toHaveBeenCalledWith(true);
    expect(media.setCameraEnabled).not.toHaveBeenCalledWith(true);
    expect(media.startScreenShare).not.toHaveBeenCalled();
    expect(hook.result.current.self).toEqual({ audioOn: false, cameraOn: false, screenSharing: false });
  });

  it('startPublishing goes through the media session and turns our state on only when it publishes', async () => {
    const startPublishing = jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const media = binding({ canPublish: false, publishRevoked: true, startPublishing });
    const { g, hook } = setup({ media });
    await act(async () => { await hook.result.current.start(startInput); });
    // Granted: can publish, not started.
    hook.rerender({ media: { ...media, canPublish: true, publishRevoked: false } });
    expect(hook.result.current.canPublish).toBe(true);
    expect(hook.result.current.self.cameraOn).toBe(false);

    let ok: boolean | undefined;
    await act(async () => { ok = await hook.result.current.startPublishing!(); });
    expect(ok).toBe(false);
    expect(hook.result.current.self.audioOn).toBe(false);

    g.sent.length = 0;
    await act(async () => { ok = await hook.result.current.startPublishing!(); });
    expect(ok).toBe(true);
    expect(startPublishing).toHaveBeenCalledTimes(2);
    expect(hook.result.current.self).toMatchObject({ audioOn: true, cameraOn: true });
    expect(g.callFrames('participant-state').at(-1)).toMatchObject({ audioOn: true, cameraOn: true });
  });

  it('startPublishing resolves false without a media session that can publish', async () => {
    const { hook } = setup({ media: binding() });
    await act(async () => { await hook.result.current.start(startInput); });
    await expect(hook.result.current.startPublishing!()).resolves.toBe(false);
  });
});

describe('useDocumentCall — host publish control', () => {
  const aliceMember = { userId: 'u-alice', participantId: 'p-alice', displayName: 'Alice', publishRevoked: false, attributes: { seat: 'guest' } };

  it('marks remote view-only people from their media member', async () => {
    const { hook } = setup({ media: binding({ members: [{ ...aliceMember, publishRevoked: true }] }) });
    await act(async () => { await hook.result.current.start(startInput); });
    const alice = hook.result.current.participants.find((p) => p.userId === 'u-alice')!;
    expect(alice).toMatchObject({ publishRevoked: true, participantId: 'p-alice' });
    expect(alice.media?.attributes).toEqual({ seat: 'guest' });
  });

  it('revoke and grant call platform-api for the participant, and the row follows at once', async () => {
    const media = binding({ members: [aliceMember] });
    const { pa, hook } = setup({ media });
    await act(async () => { await hook.result.current.start(startInput); });

    let out: { changed: boolean } | undefined;
    await act(async () => { out = await hook.result.current.revokePublish!('u-alice', { reason: 'off topic' }); });
    expect(out).toEqual({ changed: true });
    const revoke = pa.calls.find((c) => c.path === '/api/video/sessions/sess-1/participants/p-alice/revoke-publish')!;
    expect(revoke).toMatchObject({ method: 'POST', body: { lobbyName: 'doc-auth', documentId: 'doc-auth', reason: 'off topic' } });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-alice')!.publishRevoked).toBe(true);

    // LVS's frame reaches the member; the row keeps agreeing.
    hook.rerender({ media: { ...media, members: [{ ...aliceMember, publishRevoked: true }] } });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-alice')!.publishRevoked).toBe(true);

    await act(async () => { await hook.result.current.grantPublish!('u-alice'); });
    const grant = pa.calls.find((c) => c.path === '/api/video/sessions/sess-1/participants/p-alice/grant-publish')!;
    expect(grant.body).toEqual({ lobbyName: 'doc-auth', documentId: 'doc-auth' });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-alice')!.publishRevoked).toBe(false);
  });

  it('uses the participant id from call signalling when there is no media member yet', async () => {
    const { g, pa, hook } = setup({ media: binding() });
    await act(async () => { await hook.result.current.start(startInput); });
    act(() => { g.push('participant-state', { callId: 'sess-1', userId: 'u-alice', participantId: 'p-alice-2', status: 'in-call' }); });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-alice')!.participantId).toBe('p-alice-2');
    await act(async () => { await hook.result.current.revokePublish!('u-alice'); });
    expect(pa.calls.some((c) => c.path === '/api/video/sessions/sess-1/participants/p-alice-2/revoke-publish')).toBe(true);
  });

  it('refuses without a request when we are not the host or the person is not in the call', async () => {
    const { pa, hook } = setup({ media: binding({ members: [aliceMember] }) });
    await act(async () => { await hook.result.current.start(startInput); });
    await expect(hook.result.current.revokePublish!('u-nobody')).rejects.toThrow(/not in this call/i);
    await expect(hook.result.current.revokePublish!('u-host')).rejects.toThrow(/yourself/i);

    const guest = setup({ identity: { userId: 'u-bob', displayName: 'Bob' }, media: binding({ members: [aliceMember] }) }, makeFakePlatformApi());
    await act(async () => { await guest.hook.result.current.start(startInput); });
    // Bob started it, so make the host someone else.
    act(() => {
      guest.g.push('call-meta', {
        callId: 'sess-1', documentId: 'doc-auth', title: 'Review', documentIds: ['doc-auth'], hostUserId: 'u-host',
        media: 'video', startedAt: Date.now(), presenting: null, invites: {},
      });
    });
    expect(guest.hook.result.current.isHost).toBe(false);
    const before = guest.pa.calls.length;
    await expect(guest.hook.result.current.revokePublish!('u-alice')).rejects.toThrow(/only the host/i);
    expect(guest.pa.calls.length).toBe(before);
    expect(pa.calls.some((c) => /-publish$/.test(c.path))).toBe(false);
  });

  it("platform-api's refusal rejects with its status and leaves the row as it was", async () => {
    const pa = makeFakePlatformApi({ publishControl: { status: 403, body: { error: 'Only the host can change who may publish' } } });
    const { hook } = setup({ media: binding({ members: [aliceMember] }) }, pa);
    await act(async () => { await hook.result.current.start(startInput); });
    await expect(hook.result.current.revokePublish!('u-alice')).rejects.toMatchObject({ status: 403, message: 'Only the host can change who may publish' });
    expect(hook.result.current.participants.find((p) => p.userId === 'u-alice')!.publishRevoked).toBe(false);
  });
});
