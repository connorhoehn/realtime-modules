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

function live(recording?: { enabled: boolean; reason: string }) {
  const g = makeFakeGateway(); const m = makeFakeMedia(); const pa = makeFakePlatformApi(recording ? { recording } : {});
  const hook = renderHook(() => useConversationCall({ lobbyName: LOBBY, self: alice, platformApi: pa.platformApi, gateway: g.gw,
    fetch: pa.fetchImpl, deviceStorage: null, useMedia: m.useFakeMedia, endedHoldMs: 50 }));
  return { hook, m };
}

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
});
