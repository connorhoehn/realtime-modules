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

function harness() {
  const router = fakeRouter();
  const svc = new MeetingService({ router });
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

    act(() => org.result.current.configureBreakouts([{ id: 'r1', name: "Hilla's Room" }, { id: 'r2', name: 'Room 2' }], { mode: 'assigned' }));
    act(() => org.result.current.assign({ 'u-a': 'r1' }));
    act(() => org.result.current.openRooms());
    await waitFor(() => expect(ana.result.current.myRoom?.id).toBe('r1'));
    expect(ana.result.current.activeLobby).toBe(`${M}~breakout~r1`);
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
});
