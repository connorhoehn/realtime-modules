/**
 * @jest-environment jsdom
 */
// createMeetingLoopback (0.128.0): the real useMeeting over the real service
// with no gateway — what a Storybook stage or an app test uses.

import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMeeting } from '../../src/client/meeting';
import { createMeetingLoopback } from '../../src/meeting';

const M = 'demo:standup';

describe('createMeetingLoopback', () => {
    it('runs a meeting end to end: organizer, hands in order, rooms, announcement, return', async () => {
        const loop = createMeetingLoopback();
        const org = renderHook(() => useMeeting(M, { socket: loop.socketFor('c-org', 'u-org', 'Rowan') }));
        await waitFor(() => expect(org.result.current.ready).toBe(true));
        const ada = renderHook(() => useMeeting(M, { socket: loop.socketFor('c-ada', 'u-ada', 'Ada') }));
        const bram = renderHook(() => useMeeting(M, { socket: loop.socketFor('c-bram', 'u-bram', 'Bram') }));
        await waitFor(() => expect(ada.result.current.ready && bram.result.current.ready).toBe(true));
        expect(org.result.current.isOrganizer).toBe(true);
        expect(ada.result.current.isOrganizer).toBe(false);

        act(() => { bram.result.current.toggleHand(); });
        await waitFor(() => expect(bram.result.current.myHandPosition).toBe(1));
        act(() => { ada.result.current.toggleHand(); });
        await waitFor(() => expect(org.result.current.hands.map((h) => h.userId)).toEqual(['u-bram', 'u-ada']));

        act(() => { org.result.current.configureBreakouts([{ id: 'r1', name: 'Room 1', members: ['u-ada'] }, { id: 'r2', name: 'Room 2', members: ['u-bram'] }], { mode: 'assigned' }); });
        await waitFor(() => expect(org.result.current.breakout.phase).toBe('draft'));
        act(() => { org.result.current.openRooms(); });
        await waitFor(() => expect(ada.result.current.activeLobby).toBe(`${M}~breakout~r1`));
        expect(ada.result.current.activeChat).toBe(`${M}~breakout~r1`);
        expect(await loop.service.admitsBreakoutLobby('u-bram', `${M}~breakout~r1`)).toBe(false);

        act(() => { org.result.current.broadcast('Two minutes'); });
        await waitFor(() => expect(bram.result.current.breakout.announcement?.message).toBe('Two minutes'));

        act(() => { org.result.current.endBreakouts(); });
        await waitFor(() => expect(ada.result.current.activeLobby).toBe(M));
        loop.dispose();
    });

    it("a client's frames are handled in the order it sent them, and disconnect lowers its hand", async () => {
        const loop = createMeetingLoopback();
        const socket = loop.socketFor('c-a', 'u-a', 'Ada');
        const seen: string[] = [];
        socket.onMessage((m) => { seen.push(String(m.action)); });
        // Subscribe and raise in the same tick: the raise must not beat the subscribe.
        socket.send({ service: 'meeting', action: 'subscribe', meetingId: M });
        socket.send({ service: 'meeting', action: 'hand.raise', meetingId: M });
        await waitFor(() => expect(seen).toContain('hands.changed'));
        expect(seen).not.toContain('error');
        expect((await loop.service.getState(M))!.hands).toHaveLength(1);
        await loop.disconnect('c-a');
        expect(await loop.service.getState(M)).toBeNull(); // idle and unwatched: released
        loop.dispose();
    });
});
