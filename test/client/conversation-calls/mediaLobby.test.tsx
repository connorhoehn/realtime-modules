/**
 * @jest-environment jsdom
 */
// useConversationCall's media lobby (0.134.0, lane L1): a meeting's breakout
// moves a participant's MEDIA to `<lobby>~breakout~<roomId>` while the call
// itself — its callId, its signalling lobby, its roster — stays put. The
// fake platform-api can hold each request open, so overlap is observable.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationCall, type UseConversationCallOptions } from '../../../src/client/video/useConversationCall';
import { breakoutLobbyName } from '../../../src/meeting/lobby';
import { makeFakeGateway, makeFakeMedia } from './fakes';

const LOBBY = 'orgiq:initiative:p-demo';
const R1 = breakoutLobbyName(LOBBY, 'r1');
const R2 = breakoutLobbyName(LOBBY, 'r2');
const alice = { userId: 'u-alice', displayName: 'Alice Chen' };

type Call = { path: string; body: any };

/** platform-api with an optional hold on every request and a refusal per lobby. */
function gatedPlatformApi(opts: { refuseLobby?: string; createConflict?: { lobby: string; remaining: number; status?: number; error?: string } } = {}) {
  const calls: Call[] = [];
  const log: string[] = [];
  let held = false;
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let n = 0;
  const fetchImpl = (async (url: string, init: { body?: string } = {}) => {
    const path = url.replace('http://pa', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b });
    if (/\/end$/.test(path)) { log.push(`end:${body.lobbyName}`); return json(200, { ended: false }); }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (held) await new Promise<void>((r) => waiting.push(r));
      if (path === '/api/video/sessions') {
        log.push(`create:${body.lobbyName}`);
        const conflict = opts.createConflict;
        if (conflict && body.lobbyName === conflict.lobby && conflict.remaining-- > 0) {
          return json(conflict.status ?? 409, { error: conflict.error ?? 'lobbyName already claimed' });
        }
        return json(201, { sessionId: `sess-${++n}` });
      }
      if (/\/join$/.test(path)) {
        log.push(`join:${body.lobbyName}`);
        if (opts.refuseLobby && body.lobbyName === opts.refuseLobby) return json(503, { error: 'SFU unavailable' });
        return json(200, { token: `stage-${n}`, participantId: `p-self-${n}` });
      }
      return json(404, { error: 'no route' });
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetch;
  return {
    fetchImpl, calls, log,
    platformApi: { baseUrl: 'http://pa', getIdToken: async () => 'id-token' },
    hold() { held = true; },
    /** Let the oldest held request through. */
    async step() { await act(async () => { waiting.shift()?.(); await new Promise((r) => setTimeout(r, 0)); }); },
    async releaseAll() { held = false; while (waiting.length) await this.step(); },
    get pending() { return waiting.length; },
    get maxInFlight() { return maxInFlight; },
  };
}

function setup(mediaLobby?: string | null, pa = gatedPlatformApi()) {
  const g = makeFakeGateway();
  const m = makeFakeMedia();
  const base: UseConversationCallOptions = {
    lobbyName: LOBBY,
    self: alice,
    platformApi: pa.platformApi,
    gateway: g.gw,
    fetch: pa.fetchImpl,
    deviceStorage: null,
    useMedia: m.useFakeMedia,
    endedHoldMs: 50,
  };
  const hook = renderHook((p: { mediaLobby?: string | null }) => useConversationCall({
    ...base,
    ...(p.mediaLobby !== undefined ? { mediaLobby: p.mediaLobby } : {}),
  }), { initialProps: { mediaLobby } });
  return { g, m, pa, hook };
}

/** A live page huddle: one `join`, media up. */
async function goLive(s: ReturnType<typeof setup>) {
  await act(async () => { await s.hook.result.current.start([]); });
  act(() => { s.m.set({ isJoined: true, connectionState: 'connected' }); });
  await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
  return s.hook.result.current.call!.callId;
}

describe('useConversationCall mediaLobby (lane L1)', () => {
  it('joins the winning main session after a simultaneous return loses the lobby claim', async () => {
    const s = setup(R1, gatedPlatformApi({ createConflict: { lobby: LOBBY, remaining: 1 } }));
    const callId = await goLive(s);
    const frames = s.g.callFrames().length;
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    expect(s.pa.log.slice(2)).toEqual([`end:${R1}`, `create:${LOBBY}`, `create:${LOBBY}`, `join:${LOBBY}`]);
    expect(s.hook.result.current.call!.callId).toBe(callId);
    expect(s.hook.result.current.error).toBeNull();
    expect(s.g.callFrames().slice(frames)).toEqual([]);
  });

  it.each([
    [409, 'lobbyName already claimed', 3],
    [409, 'Media session changed', 1],
    [403, 'Not admitted', 1],
  ])('bounds retry and preserves refusal %s %s', async (status, error, attempts) => {
    const s = setup(R1, gatedPlatformApi({ createConflict: { lobby: LOBBY, remaining: 10, status, error } }));
    await goLive(s);
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.hook.result.current.phase).toBe('failed'));
    expect(s.pa.log.filter(v => v === `create:${LOBBY}`)).toHaveLength(attempts);
    expect(s.pa.log).not.toContain(`join:${LOBBY}`);
    expect(s.hook.result.current.error).toMatchObject({ status, message: error });
  });

  it('does not retry the claim after leaving during backoff', async () => {
    const s = setup(R1, gatedPlatformApi({ createConflict: { lobby: LOBBY, remaining: 10 } }));
    await goLive(s);
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.pa.log).toContain(`create:${LOBBY}`));
    await act(async () => { await s.hook.result.current.leave(); });
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    expect(s.pa.log.filter(v => v === `create:${LOBBY}`)).toHaveLength(1);
    expect(s.hook.result.current.call).toBeNull();
  });

  it('without mediaLobby the media joins the call lobby, as before', async () => {
    const s = setup(undefined);
    await goLive(s);
    expect(s.pa.log).toEqual([`create:${LOBBY}`, `join:${LOBBY}`]);
    expect(s.hook.result.current.mediaLobby).toBe(LOBBY);
    s.hook.rerender({ mediaLobby: undefined });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.pa.log).toEqual([`create:${LOBBY}`, `join:${LOBBY}`]);
    expect(s.m.calls).not.toContain('leave');
  });

  it('a move leaves the media, then joins the new lobby’s session; the call does not change', async () => {
    const s = setup(LOBBY);
    const callId = await goLive(s);
    const framesBefore = s.g.callFrames().length;

    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    expect(s.pa.log).toEqual([`create:${LOBBY}`, `join:${LOBBY}`, `end:${LOBBY}`, `create:${R1}`, `join:${R1}`]);
    expect(s.pa.calls.find((c) => c.path === '/api/video/sessions/sess-1/end')!.body).toMatchObject({ lobbyName: LOBBY, participantId: 'p-self-1' });
    expect(s.m.calls).toEqual(['leave']);
    expect(s.m.lastOpts.current).toMatchObject({ stageToken: 'stage-2', participantId: 'p-self-2' });
    expect(s.hook.result.current.mediaLobby).toBe(R1);
    expect(s.hook.result.current.call).toMatchObject({ callId, lobbyName: LOBBY });

    // No gateway call frames at all: no ring, no invite/accepted/ended, no join, no participant-state.
    expect(s.g.callFrames().slice(framesBefore)).toEqual([]);

    // Back to the main meeting: the same, the other way.
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.hook.result.current.mediaLobby).toBe(LOBBY));
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    expect(s.pa.log.slice(5)).toEqual([`end:${R1}`, `create:${LOBBY}`, `join:${LOBBY}`]);
    expect(s.g.callFrames().slice(framesBefore)).toEqual([]);
    expect(s.hook.result.current.call!.callId).toBe(callId);
  });

  it('two rapid moves end in the last lobby, one request at a time', async () => {
    const s = setup(LOBBY);
    const callId = await goLive(s);
    const framesBefore = s.g.callFrames().length;
    s.pa.hold();

    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.pa.pending).toBe(1)); // R1's session create is held
    s.hook.rerender({ mediaLobby: R2 });
    await s.pa.step(); // create R1
    await s.pa.step(); // join R1
    // Then the loop sees R2: leave R1, end R1, create + join R2.
    await s.pa.releaseAll();
    await waitFor(() => expect(s.hook.result.current.mediaLobby).toBe(R2));
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));

    expect(s.pa.maxInFlight).toBe(1);
    expect(s.pa.log.slice(2)).toEqual([`end:${LOBBY}`, `create:${R1}`, `join:${R1}`, `end:${R1}`, `create:${R2}`, `join:${R2}`]);
    expect(s.m.calls).toEqual(['leave', 'leave']);
    expect(s.m.lastOpts.current!.stageToken).toBe('stage-3');
    expect(s.hook.result.current.call!.callId).toBe(callId);
    expect(s.g.callFrames().slice(framesBefore)).toEqual([]);
  });

  it('a target that changes mid-move skips the intermediate lobby once the move settles', async () => {
    const s = setup(LOBBY);
    await goLive(s);
    s.pa.hold();
    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.pa.pending).toBe(1));
    // R2, then straight back to R1 before the first move finishes: no detour through R2.
    s.hook.rerender({ mediaLobby: R2 });
    s.hook.rerender({ mediaLobby: R1 });
    await s.pa.releaseAll();
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    expect(s.hook.result.current.mediaLobby).toBe(R1);
    expect(s.pa.log.slice(2)).toEqual([`end:${LOBBY}`, `create:${R1}`, `join:${R1}`]);
  });

  it('leave() mid-move hangs up on the call lobby and ends the session the move made', async () => {
    const s = setup(LOBBY);
    const callId = await goLive(s);
    s.pa.hold();
    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.pa.pending).toBe(1));
    await s.pa.step(); // R1's session exists
    await waitFor(() => expect(s.pa.pending).toBe(1)); // its join is held
    await act(async () => { await s.hook.result.current.leave(); });
    expect(s.hook.result.current.phase).toBe('ended');
    // The hang-up is signalled on the CALL's lobby, to yourself.
    expect(s.g.callFrames('ended').at(-1)).toMatchObject({ callId, lobbyName: LOBBY, targetUserIds: ['u-alice'] });

    await s.pa.releaseAll();
    // The join that finished after the hang-up is ended in its own lobby, and nothing rejoins.
    // (The hang-up itself also ends the half-made session, as any hang-up mid-join does.)
    await waitFor(() => expect(s.pa.log.at(-1)).toBe(`end:${R1}`));
    expect(s.pa.log.filter((x) => !x.startsWith('end:'))).toEqual([`create:${LOBBY}`, `join:${LOBBY}`, `create:${R1}`, `join:${R1}`]);
    expect(s.pa.calls.at(-1)!.body).toMatchObject({ lobbyName: R1, participantId: 'p-self-2' });
    expect(s.pa.log.filter((x) => x.startsWith('end:')).every((x) => x === `end:${LOBBY}` || x === `end:${R1}`)).toBe(true);
    expect(s.hook.result.current.call).toBeNull();
    expect(s.m.lastOpts.current!.stageToken).toBeNull();
  });

  it('leave() after a move ends the breakout session, not the call lobby’s', async () => {
    const s = setup(LOBBY);
    await goLive(s);
    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.hook.result.current.mediaLobby).toBe(R1));
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    await act(async () => { await s.hook.result.current.leave(); });
    await waitFor(() => expect(s.pa.log.at(-1)).toBe(`end:${R1}`));
    expect(s.pa.calls.at(-1)!.body).toMatchObject({ lobbyName: R1, documentId: R1, participantId: 'p-self-2' });
    expect(s.g.callFrames('ended').at(-1)).toMatchObject({ lobbyName: LOBBY });
  });

  it('a failed join keeps the call and surfaces the error; rejoin() retries in the current media lobby', async () => {
    const s = setup(LOBBY, gatedPlatformApi({ refuseLobby: R1 }));
    const callId = await goLive(s);
    const framesBefore = s.g.callFrames().length;
    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.hook.result.current.phase).toBe('failed'));
    expect(s.hook.result.current.error).toMatchObject({ message: 'SFU unavailable', status: 503 });
    expect(s.hook.result.current.call!.callId).toBe(callId);
    expect(s.hook.result.current.mediaLobby).toBe(R1);
    expect(s.g.callFrames().slice(framesBefore)).toEqual([]);

    // The room closes: the next target is honoured and clears the error.
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    expect(s.hook.result.current.error).toBeNull();
    expect(s.pa.log.at(-1)).toBe(`join:${LOBBY}`);

    // rejoin() uses whatever the media lobby is now.
    s.hook.rerender({ mediaLobby: R2 });
    await waitFor(() => expect(s.hook.result.current.mediaLobby).toBe(R2));
    await waitFor(() => expect(s.hook.result.current.phase).toBe('live'));
    await act(async () => { await s.hook.result.current.rejoin(); });
    expect(s.pa.log.slice(-2)).toEqual([`create:${R2}`, `join:${R2}`]);
    expect(s.hook.result.current.call!.callId).toBe(callId);
  });

  it('a call started while mediaLobby names a room joins that room’s media; signalling stays on the call lobby', async () => {
    const s = setup(R1);
    await goLive(s);
    expect(s.pa.log).toEqual([`create:${R1}`, `join:${R1}`]);
    expect(s.g.callFrames('join')[0]).toMatchObject({ lobbyName: LOBBY });
    expect(s.hook.result.current.call!.lobbyName).toBe(LOBBY);
  });

  it('changing mediaLobby while idle joins nothing', async () => {
    const s = setup(LOBBY);
    s.hook.rerender({ mediaLobby: R1 });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.pa.calls).toEqual([]);
    expect(s.hook.result.current.mediaLobby).toBeNull();
  });

  it('inside a room the tiles are the room only; the directory names people the roster has no name for (0.136.0)', async () => {
    const s = setup(LOBBY);
    const callId = await goLive(s);
    // Bob is in the meeting by signalling (no name on the wire); the directory knows him.
    act(() => { s.g.push('participant-state', { callId, userId: 'u-bob', status: 'in-call', lobbyName: LOBBY }); });
    s.hook.rerender({ mediaLobby: LOBBY });
    await waitFor(() => expect(s.hook.result.current.call!.participants.map((p: { userId: string }) => p.userId)).toEqual(['u-alice', 'u-bob']));
    // Alice moves into Room 1; Bob stays in the main meeting, so no tile for him there.
    s.hook.rerender({ mediaLobby: R1 });
    await waitFor(() => expect(s.hook.result.current.mediaLobby).toBe(R1));
    expect(s.hook.result.current.call!.participants.map((p: { userId: string }) => p.userId)).toEqual(['u-alice']);
  });

  it('nameFor fills a name the call signalling does not carry (0.136.0)', async () => {
    const g = makeFakeGateway(); const m = makeFakeMedia(); const pa = gatedPlatformApi();
    const hook = renderHook(() => useConversationCall({ lobbyName: LOBBY, self: alice, platformApi: pa.platformApi, gateway: g.gw, fetch: pa.fetchImpl,
      deviceStorage: null, useMedia: m.useFakeMedia, endedHoldMs: 50, nameFor: (uid) => uid === 'u-bob' ? { displayName: 'Bob Diaz', avatarUrl: '/b.png' } : null }));
    await act(async () => { await hook.result.current.start([]); });
    act(() => { m.set({ isJoined: true, connectionState: 'connected' }); });
    await waitFor(() => expect(hook.result.current.phase).toBe('live'));
    const callId = hook.result.current.call!.callId;
    act(() => { g.push('participant-state', { callId, userId: 'u-bob', status: 'in-call', lobbyName: LOBBY }); });
    await waitFor(() => expect(hook.result.current.call!.participants.find((p: { userId: string }) => p.userId === 'u-bob')).toMatchObject({ displayName: 'Bob Diaz', avatarUrl: '/b.png' }));
  });
});

