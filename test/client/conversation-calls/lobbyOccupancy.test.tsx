/**
 * @jest-environment jsdom
 */
// 0.136.0 (lane L9): a page sees a huddle in its lobby go live, change and
// end without a refresh. useLobbyCall watches the lobby; useConversationCall's
// discovery rides the same `watch` (one subscription) and learns of a call
// started after mount from `lobby-occupancy` pushes.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useLobbyCall, parseLobbyOccupancy } from '../../../src/client/video/useLobbyCall';
import { useConversationCall, type UseConversationCallOptions } from '../../../src/client/video/useConversationCall';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';

const LOBBY = 'acme:page:roadmap';
const OTHER = 'acme:page:budget';
const occ = (lobbyName: string, extra: Record<string, unknown> = {}) => ({
  lobbyName, active: true, callId: 'h1', participantUserIds: ['u-bob', 'u-cara'], participantCount: 2,
  startedAt: '2026-10-16T10:00:00.000Z', pageHuddle: true, ...extra,
});
const ended = (lobbyName: string) => ({ lobbyName, active: false, callId: null, participantUserIds: [], participantCount: 0, startedAt: null });

describe('useLobbyCall', () => {
  function setup(lobby: string | null = LOBBY, enabled = true) {
    const g = makeFakeGateway();
    const socket = { send: g.gw.send, onMessage: g.gw.onMessage, sessionEpoch: 1 };
    const hook = renderHook(({ l, e, s }) => useLobbyCall(l, { enabled: e, socket: s }), { initialProps: { l: lobby, e: enabled, s: socket } });
    return { g, hook, socket };
  }

  it('watches on mount and reports the snapshot and every push', () => {
    const { g, hook } = setup();
    expect(g.callFrames()).toEqual([{ service: 'call', action: 'watch', lobbyName: LOBBY }]);
    expect(hook.result.current).toEqual({ live: false, callId: null, participantUserIds: [], count: 0, startedAt: null });
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    expect(hook.result.current).toEqual({ live: true, callId: 'h1', participantUserIds: ['u-bob', 'u-cara'], count: 2, startedAt: '2026-10-16T10:00:00.000Z' });
    act(() => { g.push('lobby-occupancy', occ(LOBBY, { participantUserIds: ['u-bob', 'u-bob'], participantCount: 2 })); });
    expect(hook.result.current).toMatchObject({ participantUserIds: ['u-bob'], count: 1 });
    // Another lobby's frame, and the reply to a status query, change nothing.
    act(() => { g.push('lobby-occupancy', ended(OTHER)); g.push('active-call', ended(LOBBY)); });
    expect(hook.result.current.live).toBe(true);
    act(() => { g.push('lobby-occupancy', ended(LOBBY)); });
    expect(hook.result.current).toEqual({ live: false, callId: null, participantUserIds: [], count: 0, startedAt: null });
  });

  it('unwatches the old lobby and watches the new one; a stale frame never shows', () => {
    const { g, hook, socket } = setup();
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    hook.rerender({ l: OTHER, e: true, s: socket });
    expect(g.callFrames().slice(1)).toEqual([
      { service: 'call', action: 'unwatch', lobbyName: LOBBY },
      { service: 'call', action: 'watch', lobbyName: OTHER },
    ]);
    expect(hook.result.current.live).toBe(false);
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    expect(hook.result.current.live).toBe(false);
    act(() => { g.push('lobby-occupancy', occ(OTHER, { callId: 'h2' })); });
    expect(hook.result.current).toMatchObject({ live: true, callId: 'h2' });
    hook.unmount();
    expect(g.callFrames().at(-1)).toEqual({ service: 'call', action: 'unwatch', lobbyName: OTHER });
  });

  it('watches again after a reconnect', () => {
    const { g, hook, socket } = setup();
    hook.rerender({ l: LOBBY, e: true, s: { ...socket } }); // a new inline socket object is not a reconnect
    expect(g.callFrames('watch')).toHaveLength(1);
    hook.rerender({ l: LOBBY, e: true, s: { ...socket, sessionEpoch: 2 } });
    expect(g.callFrames('watch')).toHaveLength(2);
  });

  it('sends nothing when disabled or without a lobby', () => {
    const { g, hook, socket } = setup(LOBBY, false);
    hook.rerender({ l: null as unknown as string, e: true, s: socket });
    expect(g.callFrames()).toHaveLength(0);
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    expect(hook.result.current.live).toBe(false);
  });

  it('parseLobbyOccupancy refuses what is not a frame and drops an inactive call\'s people', () => {
    expect(parseLobbyOccupancy(null)).toBeNull();
    expect(parseLobbyOccupancy({ active: true })).toBeNull();
    expect(parseLobbyOccupancy({ lobbyName: LOBBY, active: false, callId: 'h1', participantUserIds: ['u-bob'] }))
      .toEqual(ended(LOBBY));
  });
});

describe('useConversationCall — discovery through watch', () => {
  const alice = { userId: 'u-alice', displayName: 'Alice Chen' };
  function setup(extra: Partial<UseConversationCallOptions> = {}) {
    const g = makeFakeGateway();
    const m = makeFakeMedia();
    const pa = makeFakePlatformApi();
    const hook = renderHook((p: Partial<UseConversationCallOptions>) => useConversationCall({
      lobbyName: LOBBY, channel: null, self: alice, platformApi: pa.platformApi, gateway: g.gw,
      fetch: pa.fetchImpl, deviceStorage: null, useMedia: m.useFakeMedia, endedHoldMs: 50, ...extra, ...p,
    }), { initialProps: {} });
    return { g, m, pa, hook };
  }

  it('one watch, no status; a call started after mount is offered and cleared when it ends', () => {
    const { g, hook } = setup();
    expect(g.callFrames('watch')).toEqual([{ service: 'call', action: 'watch', lobbyName: LOBBY }]);
    expect(g.callFrames('status')).toHaveLength(0);
    expect(hook.result.current.call).toBeNull();
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.call).toMatchObject({ callId: 'h1', participantCount: 2 });
    act(() => { g.push('lobby-occupancy', occ(LOBBY, { participantUserIds: ['u-bob'], participantCount: 1 })); });
    expect(hook.result.current.call).toMatchObject({ callId: 'h1', participantCount: 1 });
    act(() => { g.push('lobby-occupancy', ended(LOBBY)); });
    expect(hook.result.current.call).toBeNull();
  });

  it('a discovered page huddle is joined with join', async () => {
    const { g, hook } = setup();
    act(() => { g.push('lobby-occupancy', occ(LOBBY)); });
    await act(async () => { await hook.result.current.rejoin(); });
    expect(g.callFrames('join')[0]).toMatchObject({ callId: 'h1', lobbyName: LOBBY });
  });

  it('a lobby change unwatches the old lobby; discover:false watches nothing', () => {
    const { g, hook } = setup();
    hook.rerender({ lobbyName: OTHER });
    expect(g.callFrames().filter((f) => f.action === 'watch' || f.action === 'unwatch')).toEqual([
      { service: 'call', action: 'watch', lobbyName: LOBBY },
      { service: 'call', action: 'unwatch', lobbyName: LOBBY },
      { service: 'call', action: 'watch', lobbyName: OTHER },
    ]);
    const quiet = setup({ discover: false });
    expect(quiet.g.callFrames('watch')).toHaveLength(0);
  });

  it('inside the huddle, its own occupancy pushes never re-announce or offer it', async () => {
    const { g, m, hook } = setup();
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    const callId = hook.result.current.call!.callId;
    const announced = g.callFrames('participant-state').length;
    act(() => {
      g.push('lobby-occupancy', occ(LOBBY, { callId, participantUserIds: ['u-alice', 'u-bob'] }));
      g.push('lobby-occupancy', occ(LOBBY, { callId, participantUserIds: ['u-alice', 'u-bob', 'u-cara'] }));
    });
    expect(g.callFrames('participant-state')).toHaveLength(announced);
    expect(hook.result.current.phase).toBe('live');
    expect(hook.result.current.call!.callId).toBe(callId);
  });
});
