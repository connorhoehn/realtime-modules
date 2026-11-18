/**
 * @jest-environment jsdom
 */
// The call reports whether its media session records (0.137.0): platform-api
// decides when the session is found or created, and a consent notice keys on it.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationCall } from '../../../src/client/video/useConversationCall';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';

const LOBBY = 'orgiq:initiative:p-demo';
const alice = { userId: 'u-alice', displayName: 'Alice Chen' };

function live(recording?: { enabled: boolean; reason: string; pending?: true }, recordingChecks?: Array<{ status: number; body: unknown }>) {
  const g = makeFakeGateway(); const m = makeFakeMedia();
  const pa = makeFakePlatformApi({ ...(recording ? { recording } : {}), ...(recordingChecks ? { recordingChecks } : {}) });
  const hook = renderHook(() => useConversationCall({ lobbyName: LOBBY, self: alice, platformApi: pa.platformApi, gateway: g.gw,
    fetch: pa.fetchImpl, deviceStorage: null, useMedia: m.useFakeMedia, endedHoldMs: 50, recordingRecheckMs: 1000 }));
  return { hook, m, pa };
}

const checks = (pa: ReturnType<typeof live>['pa']) => pa.calls.filter((c) => c.method === 'POST' && /\/recording-state$/.test(c.path));

describe('useConversationCall recording (0.137.0)', () => {
  it('null before a call; the server decision once the session answers, keyed by its session id', async () => {
    const { hook, m } = live({ enabled: true, reason: 'default' });
    expect(hook.result.current.recording).toBeNull();
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    await waitFor(() => expect(hook.result.current.phase).toBe('live'));
    expect(hook.result.current.recording).toEqual({ enabled: true, reason: 'default', sessionId: 'sess-1' });
  });

  it('a server that says nothing about recording leaves it null', async () => {
    const { hook, m } = live();
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    await waitFor(() => expect(hook.result.current.phase).toBe('live'));
    expect(hook.result.current.recording).toBeNull();
  });

  describe('a decision still open (pending: an interview started before the candidate answered consent)', () => {
    const waiting = { enabled: false, reason: 'interview-consent-missing', pending: true as const };

    it('looks again until it settles, and a recording that starts mid-call turns on', async () => {
      const { hook, m, pa } = live(waiting, [
        { status: 200, body: { isRecording: false, recording: waiting } },
        { status: 200, body: { isRecording: true, recording: { enabled: true, reason: 'interview-consented' } } },
      ]);
      await act(async () => { await hook.result.current.start([]); });
      act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
      await waitFor(() => expect(hook.result.current.phase).toBe('live'));
      expect(hook.result.current.recording).toEqual({ ...waiting, sessionId: 'sess-1' });
      await waitFor(() => expect(hook.result.current.recording).toEqual({ enabled: true, reason: 'interview-consented', sessionId: 'sess-1' }), { timeout: 4000 });
      expect(checks(pa)[0].path).toBe('/api/video/sessions/sess-1/recording-state');
      expect(checks(pa)[0].body).toEqual({ lobbyName: LOBBY });
      expect(checks(pa)[0].headers).toMatchObject({ Authorization: 'Bearer id-token' });
      const looked = checks(pa).length;
      await new Promise((r) => setTimeout(r, 1300));
      expect(checks(pa)).toHaveLength(looked); // settled: no more looking
    });

    it.each([401, 403, 404])('stops looking on a %i (no access, or the session is gone), keeping what it knew', async (status) => {
      const { hook, m, pa } = live(waiting, [{ status, body: { error: 'refused' } }]);
      await act(async () => { await hook.result.current.start([]); });
      act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
      await waitFor(() => expect(checks(pa)).toHaveLength(1), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 1300));
      expect(checks(pa)).toHaveLength(1);
      expect(hook.result.current.recording).toEqual({ ...waiting, sessionId: 'sess-1' });
    });

    it('a server failure backs off and tries again, then settles', async () => {
      const { hook, m, pa } = live(waiting, [
        { status: 503, body: { error: 'unavailable' } },
        { status: 200, body: { isRecording: true, recording: { enabled: true, reason: 'interview-consented' } } },
      ]);
      await act(async () => { await hook.result.current.start([]); });
      act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
      await waitFor(() => expect(checks(pa)).toHaveLength(1), { timeout: 3000 });
      // Backed off to twice the interval: nothing at 1.5 s after the failure, the retry by 2.5 s.
      await new Promise((r) => setTimeout(r, 1500));
      expect(checks(pa)).toHaveLength(1);
      await waitFor(() => expect(hook.result.current.recording).toMatchObject({ enabled: true }), { timeout: 2000 });
      expect(checks(pa)).toHaveLength(2);
    });

    it('a settled decision is never looked at again', async () => {
      const { hook, m, pa } = live({ enabled: false, reason: 'interview-recording-declined' });
      await act(async () => { await hook.result.current.start([]); });
      act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
      await waitFor(() => expect(hook.result.current.phase).toBe('live'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(checks(pa)).toHaveLength(0);
    });
  });
});
