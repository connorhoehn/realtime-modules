/**
 * @jest-environment jsdom
 */
// useMeeting against the real MeetingService: each hook instance's socket is
// bridged to the service through the fake router, so these tests exercise
// the whole wire contract, not a hand-written imitation of the server.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GatewayMessage } from '../../../src/client/types';
import { useMeeting } from '../../../src/client/meeting';
import { MeetingService } from '../../../src/meeting/MeetingService';
import { connectAs, fakeRouter } from '../../meeting/helpers';

const M = 'orgiq:initiative:p-demo';

function harness(config: ConstructorParameters<typeof MeetingService>[0]['config'] = {}) {
  const router = fakeRouter();
  const svc = new MeetingService({ router, config });
  const handlers = new Map<string, Set<(m: GatewayMessage) => void>>();
  const sent = new Map<string, Record<string, any>[]>();
  // Deliver every frame the router records for a client to that client's hook.
  const origToClient = router.sendToClient;
  const origToChannel = router.sendToChannel;
  const deliver = (clientId: string, frame: unknown) => {
    for (const h of handlers.get(clientId) ?? []) act(() => h(frame as GatewayMessage));
  };
  router.sendToClient = (clientId, message) => { origToClient(clientId, message); deliver(clientId, message); };
  router.sendToChannel = (channel, message) => {
    origToChannel(channel, message);
    for (const [clientId, chans] of router.subs) if (chans.has(channel)) deliver(clientId, message);
  };
  const socketFor = (clientId: string, userId: string, name: string) => {
    connectAs(router, clientId, userId, name);
    const list: Record<string, any>[] = [];
    sent.set(clientId, list);
    return {
      send: (msg: Record<string, unknown>) => {
        list.push(msg);
        const { service: _s, action, ...data } = msg as any;
        void svc.handleAction(clientId, action, data);
      },
      onMessage: (h: (m: GatewayMessage) => void) => {
        const set = handlers.get(clientId) ?? new Set();
        set.add(h);
        handlers.set(clientId, set);
        return () => { set.delete(h); };
      },
    };
  };
  return { router, svc, socketFor, sent };
}

describe('useMeeting', () => {
  it('subscribes, learns organizer status from the snapshot, and unsubscribes on unmount', async () => {
    const h = harness();
    const socket = h.socketFor('c-org', 'u-org', 'Olive');
    const { result, unmount } = renderHook(() => useMeeting(M, { socket }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.isOrganizer).toBe(true);
    expect(result.current.activeLobby).toBe(M);
    unmount();
    expect(h.sent.get('c-org')!.map((f) => f.action)).toEqual(['subscribe', 'unsubscribe']);
    h.svc.dispose();
  });

  it('raise, toggle and queue position across two users', async () => {
    const h = harness();
    const org = (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ana.result.current.ready).toBe(true));
    act(() => org.result.current.raiseHand());
    act(() => ana.result.current.toggleHand());
    await waitFor(() => expect(ana.result.current.hands).toHaveLength(2));
    expect(ana.result.current.myHandPosition).toBe(2);
    expect(org.result.current.myHandPosition).toBe(1);
    act(() => ana.result.current.toggleHand());
    await waitFor(() => expect(org.result.current.hands.map((x) => x.userId)).toEqual(['u-org']));
    expect(ana.result.current.myHandPosition).toBeNull();
    h.svc.dispose();
  });

  it('breakout flow: configure, assign, open, follow activeLobby, announcement, return, end', async () => {
    const h = harness();
    const org = (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ana.result.current.ready).toBe(true));

    act(() => org.result.current.configureBreakouts([{ id: 'r1', name: "Mara's Room" }, { id: 'r2', name: 'Room 2' }], { mode: 'assigned' }));
    act(() => org.result.current.assign({ 'u-a': 'r1' }));
    act(() => org.result.current.openRooms());
    await waitFor(() => expect(ana.result.current.myRoom?.id).toBe('r1'));
    expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`);
    expect(ana.result.current.activeChat).toBe(`${M}~breakout~r1`);
    expect(org.result.current.activeChat).toBe(M);
    expect(org.result.current.activeLobby).toBe(M);

    act(() => org.result.current.broadcast('Wrap up in two minutes'));
    await waitFor(() => expect(ana.result.current.state.announcement?.message).toBe('Wrap up in two minutes'));
    act(() => ana.result.current.dismissAnnouncement());
    expect(ana.result.current.state.announcement).toBeNull();

    act(() => ana.result.current.returnToMain());
    await waitFor(() => expect(ana.result.current.activeLobby).toBe(M));
    act(() => ana.result.current.joinRoom('r1'));
    await waitFor(() => expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`));

    act(() => org.result.current.endBreakouts());
    await waitFor(() => expect(ana.result.current.breakout.phase).toBe('draft'));
    expect(ana.result.current.activeLobby).toBe(M);
    h.svc.dispose();
  });

  it('chatChannel: activeChat is the host chat name, with the breakout suffix inside a room (lane L3)', async () => {
    const h = harness();
    const CHAT = 'orgiq:huddle:call-7f3a';
    const org = (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk, chatChannel: CHAT })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk, chatChannel: CHAT })); })();
    // no chatChannel: the 0.126.0 naming is unchanged
    const ben = (() => { const sk = h.socketFor('c-b', 'u-b', 'Ben'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ben.result.current.ready).toBe(true));
    expect(ana.result.current.activeChat).toBe(CHAT);
    expect(ben.result.current.activeChat).toBe(M);

    act(() => org.result.current.configureBreakouts([{ id: 'r1', name: 'Room 1' }], { mode: 'assigned' }));
    act(() => org.result.current.assign({ 'u-a': 'r1', 'u-b': 'r1' }));
    act(() => org.result.current.openRooms());
    await waitFor(() => expect(ana.result.current.myRoom?.id).toBe('r1'));
    await waitFor(() => expect(ben.result.current.myRoom?.id).toBe('r1'));
    expect(ana.result.current.activeChat).toBe(`${CHAT}~breakout~r1`);
    expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`); // media still follows the lobby
    expect(org.result.current.activeChat).toBe(CHAT);
    expect(ben.result.current.activeChat).toBe(`${M}~breakout~r1`);

    act(() => ana.result.current.returnToMain());
    await waitFor(() => expect(ana.result.current.activeChat).toBe(CHAT));
    h.svc.dispose();
  });

  it('addRoom and renameRoom while rooms are open reach every client', async () => {
    const h = harness();
    const org = (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ana.result.current.ready).toBe(true));
    act(() => org.result.current.configureBreakouts([{ id: 'r1', name: 'Room 1' }]));
    act(() => org.result.current.openRooms());
    act(() => org.result.current.addRoom({ id: 'r2' }));
    act(() => org.result.current.addRoom({ name: 'Overflow' }));
    act(() => org.result.current.renameRoom('r1', 'Design crit'));
    await waitFor(() => expect(ana.result.current.breakout.rooms.map((r) => r.name)).toEqual(['Design crit', 'Room 2', 'Overflow']));
    expect(ana.result.current.breakout.rooms.map((r) => r.state)).toEqual(['open', 'closed', 'closed']);
    expect(ana.result.current.breakout.phase).toBe('open');
    act(() => ana.result.current.renameRoom('r1', 'mine'));
    await waitFor(() => expect(ana.result.current.error?.code).toBe('FORBIDDEN'));
    h.svc.dispose();
  });

  it('closing grace: closeRooms() counts down for everyone; closeRooms(undefined, { immediate }) closes now', async () => {
    const h = harness({ closingGraceMs: 30_000 });
    const org = (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ana.result.current.ready).toBe(true));
    act(() => org.result.current.configureBreakouts([{ id: 'r1', name: 'Room 1', members: ['u-a'] }]));
    act(() => org.result.current.openRooms());
    await waitFor(() => expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`));
    act(() => org.result.current.closeRooms());
    await waitFor(() => expect(ana.result.current.breakout.closing).toBe(true));
    expect(ana.result.current.breakout.endsAt).not.toBeNull();
    expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`);
    act(() => org.result.current.closeRooms(undefined, { immediate: true }));
    await waitFor(() => expect(ana.result.current.activeLobby).toBe(M));
    expect(org.result.current.state.error).toBeNull();
    h.svc.dispose();
  });

  it('surfaces a refusal as error and clears it', async () => {
    const h = harness();
    (() => { const sk = h.socketFor('c-org', 'u-org', 'Olive'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    const ana = (() => { const sk = h.socketFor('c-a', 'u-a', 'Ana'); return renderHook(() => useMeeting(M, { socket: sk })); })();
    await waitFor(() => expect(ana.result.current.ready).toBe(true));
    act(() => ana.result.current.lowerAllHands());
    await waitFor(() => expect(ana.result.current.error?.code).toBe('FORBIDDEN'));
    act(() => ana.result.current.clearError());
    expect(ana.result.current.error).toBeNull();
    h.svc.dispose();
  });

  it('switching meetings resets state; null or enabled=false is inert', async () => {
    const h = harness();
    const socket = h.socketFor('c-a', 'u-a', 'Ana');
    const { result, rerender } = renderHook(({ id, enabled }: { id: string | null; enabled: boolean }) => useMeeting(id, { socket, enabled }), {
      initialProps: { id: M as string | null, enabled: true },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ id: 'room:other', enabled: true });
    expect(result.current.state.meetingId).toBe('room:other');
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ id: null, enabled: true });
    expect(result.current.ready).toBe(false);
    expect(result.current.activeLobby).toBeNull();
    const before = h.sent.get('c-a')!.length;
    act(() => result.current.raiseHand());
    expect(h.sent.get('c-a')!.length).toBe(before);
    h.svc.dispose();
  });

  it('with neither socket nor provider the hook is inert, not a crash', () => {
    const { result } = renderHook(() => useMeeting(M));
    expect(result.current.ready).toBe(false);
    act(() => result.current.raiseHand());
    expect(result.current.hands).toEqual([]);
  });

  it('clockOffsetMs follows the server clock from frame timestamps (0.129.0)', async () => {
    const h = harness({ now: () => Date.now() + 40_000 }); // the server runs 40 s ahead
    const socket = h.socketFor('c-org', 'u-org', 'Olive');
    const { result } = renderHook(() => useMeeting(M, { socket }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.clockOffsetMs).toBeGreaterThan(39_000);
    expect(result.current.clockOffsetMs).toBeLessThanOrEqual(40_000);
    // A breakout deadline read with the offset is the server's, not this device's.
    act(() => { result.current.configureBreakouts([{ id: 'r1', name: 'Room 1' }]); });
    act(() => { result.current.openRooms(); });
    act(() => { result.current.setTimer(60_000); });
    await waitFor(() => expect(result.current.breakout.endsAt).not.toBeNull());
    const leftLocal = Date.parse(result.current.breakout.endsAt!) - Date.now();
    const leftServer = Date.parse(result.current.breakout.endsAt!) - (Date.now() + result.current.clockOffsetMs);
    expect(leftLocal).toBeGreaterThan(99_000); // the naive reading is 40 s too long
    expect(Math.abs(leftServer - 60_000)).toBeLessThan(1_500);
  });
});

