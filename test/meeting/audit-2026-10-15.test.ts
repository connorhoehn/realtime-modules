// Regressions from the 2026-10-15 audit sweep (docs/design/meeting-rooms-audit.md).

import { MeetingService } from '../../src/meeting/MeetingService';
import { InMemoryMeetingStateStore } from '../../src/meeting/MeetingStateStore';
import { INITIAL_MEETING_STATE, meetingReducer } from '../../src/client/meeting/reducer';
import { EMPTY_BREAKOUT } from '../../src/meeting/types';
import { connectAs, fakeRouter } from './helpers';

const M = 'room:lounge';

describe('audit: a late snapshot never rolls back newer state', () => {
    it('keeps the newer hands slice and still takes organizer status and readiness', () => {
        let s = meetingReducer(INITIAL_MEETING_STATE, { kind: 'reset', meetingId: M });
        s = meetingReducer(s, { kind: 'frame', frame: { type: 'meeting', action: 'hands.changed', meetingId: M, data: { version: 7, hands: [{ userId: 'u-a', displayName: 'Ana', raisedAt: '' }] } } });
        s = meetingReducer(s, { kind: 'frame', frame: { type: 'meeting', action: 'meeting.snapshot', meetingId: M, data: { version: 6, hands: [], breakout: EMPTY_BREAKOUT, createdBy: 'u-org', you: { userId: 'u-org', organizer: true } } } });
        expect(s.ready).toBe(true);
        expect(s.you).toEqual({ userId: 'u-org', organizer: true });
        expect(s.version).toBe(7);
        expect(s.hands.map((h) => h.userId)).toEqual(['u-a']);
    });

    it('a newer snapshot still replaces everything', () => {
        let s = meetingReducer(INITIAL_MEETING_STATE, { kind: 'reset', meetingId: M });
        s = meetingReducer(s, { kind: 'frame', frame: { type: 'meeting', action: 'hands.changed', meetingId: M, data: { version: 3, hands: [{ userId: 'x', displayName: 'X', raisedAt: '' }] } } });
        s = meetingReducer(s, { kind: 'frame', frame: { type: 'meeting', action: 'meeting.snapshot', meetingId: M, data: { version: 4, hands: [], breakout: EMPTY_BREAKOUT, createdBy: null, you: { userId: 'x', organizer: false } } } });
        expect(s.hands).toEqual([]);
        expect(s.version).toBe(4);
    });
});

describe('audit: meeting state is released when idle', () => {
    async function setup() {
        const router = fakeRouter();
        const store = new InMemoryMeetingStateStore();
        const svc = new MeetingService({ router, config: { store } });
        connectAs(router, 'c-org', 'u-org');
        connectAs(router, 'c-a', 'u-a');
        await svc.handleAction('c-org', 'subscribe', { meetingId: M });
        await svc.handleAction('c-a', 'subscribe', { meetingId: M });
        return { router, store, svc };
    }

    it('the last disconnect of an idle meeting drops it from the store and the sync mirror', async () => {
        const { store, svc } = await setup();
        expect(store.size).toBe(1);
        await svc.onClientDisconnect('c-a');
        expect(store.size).toBe(1);
        await svc.onClientDisconnect('c-org');
        expect(store.size).toBe(0);
        expect(svc.admitsBreakoutLobbySync('u-org', `${M}~breakout~r1`)).toBe(false);
        svc.dispose();
    });

    it('unsubscribing the last client releases too, after lowering their hand', async () => {
        const { store, svc } = await setup();
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-org', 'unsubscribe', { meetingId: M });
        expect(store.size).toBe(1); // Ana still here, hand up
        await svc.handleAction('c-a', 'unsubscribe', { meetingId: M });
        expect(store.size).toBe(0);
        svc.dispose();
    });

    it('a meeting with breakout rooms survives everyone leaving, so the organizer finds them again', async () => {
        const { store, svc, router } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', name: 'Room 1' }] });
        await svc.onClientDisconnect('c-a');
        await svc.onClientDisconnect('c-org');
        expect(store.size).toBe(1);
        connectAs(router, 'c-org2', 'u-org');
        await svc.handleAction('c-org2', 'subscribe', { meetingId: M });
        const snap = router.last('c-org2', 'meeting.snapshot');
        expect(snap.data.breakout.rooms.map((r: any) => r.id)).toEqual(['r1']);
        expect(snap.data.you.organizer).toBe(true);
        svc.dispose();
    });

    it('an anonymous connection leaving also releases', async () => {
        const router = fakeRouter();
        const store = new InMemoryMeetingStateStore();
        const svc = new MeetingService({ router, config: { store } });
        connectAs(router, 'c-anon', null);
        await svc.handleAction('c-anon', 'subscribe', { meetingId: M });
        expect(store.size).toBe(1);
        await svc.onClientDisconnect('c-anon');
        expect(store.size).toBe(0);
    });
});

describe('audit: meeting ids that look like breakout lobbies are refused', () => {
    it('refuses a meetingId containing ~breakout~', async () => {
        const router = fakeRouter();
        const svc = new MeetingService({ router });
        connectAs(router, 'c', 'u');
        await svc.handleAction('c', 'subscribe', { meetingId: 'room:x~breakout~r1' });
        expect(router.last('c', 'error').error.code).toBe('INVALID_PAYLOAD');
        expect(await svc.getState('room:x~breakout~r1')).toBeNull();
    });
});
