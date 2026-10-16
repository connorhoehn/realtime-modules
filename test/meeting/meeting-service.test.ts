import { MeetingService } from '../../src/meeting/MeetingService';
import { InMemoryMeetingStateStore } from '../../src/meeting/MeetingStateStore';
import { breakoutLobbyName } from '../../src/meeting/lobby';
import { connectAs, fakeRouter, type FakeRouter } from './helpers';

const M = 'orgiq:initiative:p-demo';

async function setup(opts: { isOrganizer?: any; now?: () => number; closingGraceMs?: number; rateLimit?: any } = {}) {
    const router = fakeRouter();
    const store = new InMemoryMeetingStateStore();
    const svc = new MeetingService({ router, config: { store, ...opts } });
    connectAs(router, 'c-org', 'u-org', 'Olive Organizer');
    connectAs(router, 'c-a', 'u-a', 'Ana');
    connectAs(router, 'c-b', 'u-b', 'Ben');
    connectAs(router, 'c-c', 'u-c', 'Cy');
    for (const c of ['c-org', 'c-a', 'c-b', 'c-c']) await svc.handleAction(c, 'subscribe', { meetingId: M });
    return { router, store, svc };
}

const err = (r: FakeRouter, c: string) => r.last(c, 'error')?.error;

describe('MeetingService — subscribe and authority', () => {
    it('sends a snapshot; the first subscriber is the default organizer', async () => {
        const { router, svc } = await setup();
        const org = router.last('c-org', 'meeting.snapshot');
        expect(org.data.you).toEqual({ userId: 'u-org', organizer: true });
        expect(org.data.createdBy).toBe('u-org');
        expect(router.last('c-a', 'meeting.snapshot').data.you.organizer).toBe(false);
        svc.dispose();
    });

    it('a refused channel subscription is FORBIDDEN and seats nothing', async () => {
        const router = fakeRouter();
        const svc = new MeetingService({ router });
        connectAs(router, 'c-x', 'u-x');
        router.deny.add('c-x');
        await svc.handleAction('c-x', 'subscribe', { meetingId: M });
        expect(err(router, 'c-x').code).toBe('FORBIDDEN');
        await svc.handleAction('c-x', 'hand.raise', { meetingId: M });
        expect(err(router, 'c-x').code).toBe('NOT_SUBSCRIBED');
        expect(await svc.getState(M)).toBeNull();
    });

    it('rejects unknown verbs, bad meeting ids and anonymous mutations', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-a', 'hand.wave', { meetingId: M });
        expect(err(router, 'c-a').code).toBe('INVALID_ACTION');
        await svc.handleAction('c-a', 'hand.raise', { meetingId: 'has space' });
        expect(err(router, 'c-a').code).toBe('INVALID_PAYLOAD');
        connectAs(router, 'c-anon', null);
        await svc.handleAction('c-anon', 'subscribe', { meetingId: M });
        await svc.handleAction('c-anon', 'hand.raise', { meetingId: M });
        expect(err(router, 'c-anon').code).toBe('UNAUTHENTICATED');
    });

    it('an isOrganizer hook replaces first-subscriber authority; a throwing hook refuses', async () => {
        const { router, svc } = await setup({ isOrganizer: ({ userId }: any) => {
            if (userId === 'u-c') throw new Error('directory down');
            return userId === 'u-a';
        } });
        expect(router.last('c-a', 'meeting.snapshot').data.you.organizer).toBe(true);
        expect(router.last('c-org', 'meeting.snapshot').data.you.organizer).toBe(false);
        await svc.handleAction('c-org', 'hand.lowerAll', { meetingId: M });
        expect(err(router, 'c-org').code).toBe('FORBIDDEN');
        await svc.handleAction('c-c', 'breakout.configure', { meetingId: M, rooms: [{ name: 'x' }] });
        expect(err(router, 'c-c').code).toBe('FORBIDDEN');
        svc.dispose();
    });
});

describe('MeetingService — raised hands', () => {
    it('keeps an ordered queue, broadcasts the whole slice, and ignores a second raise', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-b', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-b', 'hand.raise', { meetingId: M });
        const frame = router.last('c-org', 'hands.changed');
        expect(frame.data.hands.map((h: any) => h.userId)).toEqual(['u-b', 'u-a']);
        expect(frame.data.hands[0].displayName).toBe('Ben');
        expect(router.framesFor('c-org', 'hands.changed')).toHaveLength(2);
        svc.dispose();
    });

    it('the auth context display name wins over the frame', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M, displayName: 'The Real CEO' });
        expect(router.last('c-a', 'hands.changed').data.hands[0].displayName).toBe('Ana');
        svc.dispose();
    });

    it('only an organizer lowers someone else or everyone', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-b', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-b', 'hand.lower', { meetingId: M, userId: 'u-a' });
        expect(err(router, 'c-b').code).toBe('FORBIDDEN');
        await svc.handleAction('c-org', 'hand.lower', { meetingId: M, userId: 'u-a' });
        expect(router.last('c-b', 'hands.changed').data.hands.map((h: any) => h.userId)).toEqual(['u-b']);
        await svc.handleAction('c-org', 'hand.lowerAll', { meetingId: M });
        expect(router.last('c-b', 'hands.changed').data.hands).toEqual([]);
        svc.dispose();
    });

    it("a user's last connection leaving lowers their hand; a second tab keeps it up", async () => {
        const { router, svc } = await setup();
        connectAs(router, 'c-a2', 'u-a');
        await svc.handleAction('c-a2', 'subscribe', { meetingId: M });
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.onClientDisconnect('c-a');
        expect((await svc.getState(M))!.hands).toHaveLength(1);
        await svc.onClientDisconnect('c-a2');
        expect((await svc.getState(M))!.hands).toHaveLength(0);
        expect(router.last('c-b', 'hands.changed').data.hands).toEqual([]);
        svc.dispose();
    });
});

describe('MeetingService — breakout rooms', () => {
    async function withRooms(mode: 'assigned' | 'self-select' = 'assigned') {
        const ctx = await setup();
        await ctx.svc.handleAction('c-org', 'breakout.configure', {
            meetingId: M, mode, rooms: [{ id: 'r1', name: "Mara's Room" }, { id: 'r2', name: '' }],
        });
        return ctx;
    }

    it('configure creates closed draft rooms with default names and minted ids', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ name: 'A' }, {}] });
        const b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b.phase).toBe('draft');
        expect(b.rooms.map((r: any) => r.name)).toEqual(['A', 'Room 2']);
        expect(b.rooms.every((r: any) => r.state === 'closed' && /^[A-Za-z0-9_-]+$/.test(r.id))).toBe(true);
        expect(new Set(b.rooms.map((r: any) => r.id)).size).toBe(2);
        svc.dispose();
    });

    it('refuses bad room ids, duplicates and too many rooms', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'a b', name: 'x' }] });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'a' }, { id: 'a' }] });
        expect(err(router, 'c-org').message).toMatch(/Duplicate/);
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: Array.from({ length: 51 }, () => ({})) });
        expect(err(router, 'c-org').message).toMatch(/At most 50/);
        svc.dispose();
    });

    it('assign moves a person (one room at most) and autoAssign round-robins', async () => {
        const { router, svc } = await withRooms();
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'r1', 'u-b': 'r1' } });
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'r2', 'u-b': null } });
        let rooms = router.last('c-a', 'breakout.changed').data.breakout.rooms;
        expect(rooms.map((r: any) => r.members)).toEqual([[], ['u-a']]);
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'nope' } });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.autoAssign', { meetingId: M, userIds: ['u-a', 'u-b', 'u-c', 'u-a'] });
        rooms = router.last('c-a', 'breakout.changed').data.breakout.rooms;
        expect(rooms.map((r: any) => r.members)).toEqual([['u-a', 'u-c'], ['u-b']]);
        svc.dispose();
    });

    it('in assigned mode a participant joins only their room; an organizer may visit any', async () => {
        const { router, svc } = await withRooms('assigned');
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'r1' } });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-b', 'breakout.join', { meetingId: M, roomId: 'r1' });
        expect(err(router, 'c-b').code).toBe('FORBIDDEN');
        await svc.handleAction('c-org', 'breakout.join', { meetingId: M, roomId: 'r2' });
        const b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b.rooms.find((r: any) => r.id === 'r2').members).toEqual(['u-org']);
        expect(b.phase).toBe('open');
        svc.dispose();
    });

    it('self-select: join any open room, never a closed one; leave returns to main', async () => {
        const { router, svc } = await withRooms('self-select');
        await svc.handleAction('c-a', 'breakout.join', { meetingId: M, roomId: 'r1' });
        expect(err(router, 'c-a').code).toBe('CONFLICT');
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M, roomIds: ['r1'] });
        await svc.handleAction('c-a', 'breakout.join', { meetingId: M, roomId: 'r2' });
        expect(err(router, 'c-a').message).toMatch(/closed/);
        await svc.handleAction('c-a', 'breakout.join', { meetingId: M, roomId: 'r1' });
        let state = (await svc.getState(M))!;
        expect(state.breakout.rooms[0]!.members).toEqual(['u-a']);
        await svc.handleAction('c-a', 'breakout.leave', { meetingId: M });
        state = (await svc.getState(M))!;
        expect(state.breakout.rooms[0]!.members).toEqual([]);
        svc.dispose();
    });

    it('assigned: leave keeps the placement and marks the person returned; rejoin clears it', async () => {
        const { svc } = await withRooms('assigned');
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'r1' } });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-a', 'breakout.leave', { meetingId: M });
        let b = (await svc.getState(M))!.breakout;
        expect(b.returned).toEqual(['u-a']);
        expect(b.rooms[0]!.members).toEqual(['u-a']);
        await svc.handleAction('c-a', 'breakout.join', { meetingId: M, roomId: 'r1' });
        b = (await svc.getState(M))!.breakout;
        expect(b.returned).toEqual([]);
        svc.dispose();
    });

    it('allowReturnToMain=false holds participants in their room', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', members: ['u-a'] }], mode: 'assigned', allowReturnToMain: false });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-a', 'breakout.leave', { meetingId: M });
        expect(err(router, 'c-a').code).toBe('FORBIDDEN');
        svc.dispose();
    });

    it('addRoom appends a closed room in any phase, with a free default name; open rooms stay open', async () => {
        const { router, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M });
        let b = (await svc.getState(M))!.breakout;
        expect(b.phase).toBe('draft');
        expect(b.rooms.map((r) => r.name)).toEqual(['Room 1']);
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', name: 'Room 2' }, { id: 'r2', name: 'B' }] });
        await svc.handleAction('c-org', 'breakout.assign', { meetingId: M, assignments: { 'u-a': 'r1' } });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, id: 'late', name: '  Late arrivals  ' });
        b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b.phase).toBe('open');
        expect(b.rooms.map((r: any) => [r.id.length > 0, r.name, r.state])).toEqual([
            [true, 'Room 2', 'open'], [true, 'B', 'open'], [true, 'Room 3', 'closed'], [true, 'Late arrivals', 'closed'],
        ]);
        expect(b.rooms[0].members).toEqual(['u-a']);
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M, roomIds: ['late'] });
        expect((await svc.getState(M))!.breakout.rooms.find((r) => r.id === 'late')!.state).toBe('open');
        svc.dispose();
    });

    it('addRoom refuses non-organizers, bad or duplicate ids, bad names and the room cap', async () => {
        const router = fakeRouter();
        const svc = new MeetingService({ router, config: { maxRooms: 2 } });
        connectAs(router, 'c-org', 'u-org');
        connectAs(router, 'c-a', 'u-a');
        for (const c of ['c-org', 'c-a']) await svc.handleAction(c, 'subscribe', { meetingId: M });
        await svc.handleAction('c-a', 'breakout.addRoom', { meetingId: M });
        expect(err(router, 'c-a').code).toBe('FORBIDDEN');
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, id: 'a b' });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, name: '   ' });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, name: 'x'.repeat(81) });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, id: 'r1' });
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M, id: 'r1' });
        expect(err(router, 'c-org').code).toBe('CONFLICT');
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.addRoom', { meetingId: M });
        expect(err(router, 'c-org').message).toMatch(/At most 2/);
        expect((await svc.getState(M))!.breakout.rooms).toHaveLength(2);
        svc.dispose();
    });

    it('rename changes one room in any phase; no-op renames broadcast nothing; limits are enforced', async () => {
        const { router, svc } = await withRooms();
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        const before = router.framesFor('c-a', 'breakout.changed').length;
        await svc.handleAction('c-org', 'breakout.rename', { meetingId: M, roomId: 'r2', name: ' Design crit ' });
        const b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b.rooms.map((r: any) => r.name)).toEqual(["Mara's Room", 'Design crit']);
        expect(b.phase).toBe('open');
        await svc.handleAction('c-org', 'breakout.rename', { meetingId: M, roomId: 'r2', name: 'Design crit' });
        expect(router.framesFor('c-a', 'breakout.changed')).toHaveLength(before + 1);
        await svc.handleAction('c-a', 'breakout.rename', { meetingId: M, roomId: 'r2', name: 'mine' });
        expect(err(router, 'c-a').code).toBe('FORBIDDEN');
        await svc.handleAction('c-org', 'breakout.rename', { meetingId: M, roomId: 'nope', name: 'x' });
        expect(err(router, 'c-org').code).toBe('NOT_FOUND');
        await svc.handleAction('c-org', 'breakout.rename', { meetingId: M, roomId: 'r1', name: '' });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.rename', { meetingId: M, roomId: 'r1', name: 7 });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        expect((await svc.getState(M))!.breakout.rooms[0]!.name).toBe("Mara's Room");
        svc.dispose();
    });

    it('cannot reconfigure open rooms; closing the last open room returns to draft', async () => {
        const { router, svc } = await withRooms();
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [] });
        expect(err(router, 'c-org').code).toBe('CONFLICT');
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M, roomIds: ['r1'] });
        expect((await svc.getState(M))!.breakout.phase).toBe('open');
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M, roomIds: ['r2'] });
        expect((await svc.getState(M))!.breakout.phase).toBe('draft');
        svc.dispose();
    });

    it('broadcast sends an announcement frame and stores it; end clears the session', async () => {
        const { router, svc } = await withRooms();
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: '  Two minutes left  ' });
        const a = router.last('c-b', 'breakout.announcement');
        expect(a.data).toMatchObject({ message: 'Two minutes left', fromUserId: 'u-org', fromDisplayName: 'Olive Organizer' });
        await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: 'x'.repeat(501) });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        await svc.handleAction('c-org', 'breakout.end', { meetingId: M });
        const b = (await svc.getState(M))!.breakout;
        expect(b.phase).toBe('draft');
        expect(b.rooms.every((r) => r.state === 'closed')).toBe(true);
        svc.dispose();
    });

    it('the timer closes every room when it runs out', async () => {
        jest.useFakeTimers();
        try {
            let now = Date.parse('2026-10-15T12:00:00Z');
            jest.setSystemTime(now);
            const { router, svc } = await setup({ now: () => now });
            await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', members: ['u-a'] }] });
            await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 60_000 });
            expect(err(router, 'c-org').code).toBe('CONFLICT');
            await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
            await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 60_000 });
            expect((await svc.getState(M))!.breakout.endsAt).toBe('2026-10-15T12:01:00.000Z');
            now += 60_000;
            jest.advanceTimersByTime(60_000);
            await jest.runOnlyPendingTimersAsync();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const b = router.last('c-a', 'breakout.changed').data.breakout;
            expect(b.phase).toBe('draft');
            expect(b.endsAt).toBeNull();
            svc.dispose();
        } finally {
            jest.useRealTimers();
        }
    });

    it('a timer that ran out while nobody was watching closes on the next read', async () => {
        let now = Date.parse('2026-10-15T12:00:00Z');
        const { svc } = await setup({ now: () => now });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 1000 });
        svc.dispose(); // no timer fires
        now += 5000;
        expect((await svc.getState(M))!.breakout.phase).toBe('draft');
    });

    it('rejects a timer longer than maxTimerMs', async () => {
        const { router, svc } = await withRooms();
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 5 * 60 * 60 * 1000 });
        expect(err(router, 'c-org').code).toBe('INVALID_PAYLOAD');
        svc.dispose();
    });
});

describe('MeetingService — closing grace (closingGraceMs)', () => {
    const T0 = Date.parse('2026-10-16T12:00:00Z');
    async function openWithGrace(graceMs = 30_000) {
        jest.useFakeTimers();
        jest.setSystemTime(T0);
        const clock = { now: T0 };
        const ctx = await setup({ now: () => clock.now, closingGraceMs: graceMs });
        await ctx.svc.handleAction('c-org', 'breakout.configure', {
            meetingId: M, mode: 'self-select', rooms: [{ id: 'r1', name: 'A', members: ['u-a'] }, { id: 'r2', name: 'B' }],
        });
        await ctx.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        const advance = async (ms: number) => {
            clock.now += ms;
            jest.advanceTimersByTime(ms);
            await jest.runOnlyPendingTimersAsync();
            for (let i = 0; i < 10; i++) await Promise.resolve();
        };
        return { ...ctx, clock, advance };
    }
    afterEach(() => jest.useRealTimers());

    it('closing all rooms counts down, refuses joins, then closes when the grace runs out', async () => {
        const { router, svc, advance } = await openWithGrace();
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        let b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b).toMatchObject({ phase: 'open', closing: true, endsAt: '2026-10-16T12:00:30.000Z' });
        expect(b.rooms.every((r: any) => r.state === 'open')).toBe(true);
        expect(svc.admitsBreakoutLobbySync('u-a', breakoutLobbyName(M, 'r1'))).toBe(true);
        await svc.handleAction('c-b', 'breakout.join', { meetingId: M, roomId: 'r2' });
        expect(err(router, 'c-b')).toMatchObject({ code: 'CONFLICT', message: 'The rooms are closing' });
        await advance(30_000);
        b = router.last('c-a', 'breakout.changed').data.breakout;
        expect(b).toMatchObject({ phase: 'draft', closing: false, endsAt: null });
        expect(svc.admitsBreakoutLobbySync('u-a', breakoutLobbyName(M, 'r1'))).toBe(false);
        svc.dispose();
    });

    it('a second close, immediate: true, or end during the countdown closes at once', async () => {
        const { svc } = await openWithGrace();
        await svc.handleAction('c-org', 'breakout.end', { meetingId: M });
        expect((await svc.getState(M))!.breakout.closing).toBe(true);
        await svc.handleAction('c-org', 'breakout.end', { meetingId: M });
        expect((await svc.getState(M))!.breakout).toMatchObject({ phase: 'draft', closing: false });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M, immediate: true });
        expect((await svc.getState(M))!.breakout).toMatchObject({ phase: 'draft', closing: false });
        svc.dispose();
    });

    it('opening rooms cancels the countdown; a timer replaces it; closing some rooms keeps it', async () => {
        const { svc } = await openWithGrace();
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M, roomIds: ['r2'] });
        expect((await svc.getState(M))!.breakout).toMatchObject({ closing: true, endsAt: '2026-10-16T12:00:30.000Z' });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M, roomIds: ['r2'] });
        expect((await svc.getState(M))!.breakout).toMatchObject({ phase: 'open', closing: false, endsAt: null });
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 120_000 });
        expect((await svc.getState(M))!.breakout).toMatchObject({ closing: false, endsAt: '2026-10-16T12:02:00.000Z' });
        svc.dispose();
    });

    it('a running timer that ends sooner than the grace keeps its deadline', async () => {
        const { svc } = await openWithGrace(60_000);
        await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 10_000 });
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        expect((await svc.getState(M))!.breakout).toMatchObject({ closing: true, endsAt: '2026-10-16T12:00:10.000Z' });
        svc.dispose();
    });

    it('without a grace (the default) closing is immediate; the grace is clamped to five minutes', async () => {
        const plain = await setup();
        await plain.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
        await plain.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await plain.svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        expect((await plain.svc.getState(M))!.breakout).toMatchObject({ phase: 'draft', closing: false });
        plain.svc.dispose();
        const { svc } = await openWithGrace(60 * 60_000);
        await svc.handleAction('c-org', 'breakout.close', { meetingId: M });
        expect((await svc.getState(M))!.breakout.endsAt).toBe('2026-10-16T12:05:00.000Z');
        svc.dispose();
    });
});

describe('MeetingService — admitsBreakoutLobby (for a host lobby guard)', () => {
    it('answers null for non-breakout lobbies and follows placement for breakout ones', async () => {
        const { svc } = await setup();
        expect(await svc.admitsBreakoutLobby('u-a', M)).toBeNull();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, mode: 'assigned', rooms: [{ id: 'r1', members: ['u-a'] }, { id: 'r2' }] });
        expect(await svc.admitsBreakoutLobby('u-a', breakoutLobbyName(M, 'r1'))).toBe(false); // not open yet
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        expect(await svc.admitsBreakoutLobby('u-a', breakoutLobbyName(M, 'r1'))).toBe(true);
        expect(await svc.admitsBreakoutLobby('u-a', breakoutLobbyName(M, 'r2'))).toBe(false);
        expect(await svc.admitsBreakoutLobby('u-org', breakoutLobbyName(M, 'r2'))).toBe(true);
        expect(await svc.admitsBreakoutLobby('u-a', breakoutLobbyName(M, 'ghost'))).toBe(false);
        expect(await svc.admitsBreakoutLobby('u-a', breakoutLobbyName('other-meeting', 'r1'))).toBe(false);
        // The synchronous form, for calls({ lobbyGuard }), gives the same answers from the mirror.
        expect(svc.admitsBreakoutLobbySync('u-a', M)).toBeNull();
        expect(svc.admitsBreakoutLobbySync('u-a', breakoutLobbyName(M, 'r1'))).toBe(true);
        expect(svc.admitsBreakoutLobbySync('u-a', breakoutLobbyName(M, 'r2'))).toBe(false);
        expect(svc.admitsBreakoutLobbySync('u-org', breakoutLobbyName(M, 'r2'))).toBe(true);
        expect(svc.admitsBreakoutLobbySync('u-b', breakoutLobbyName('unseen', 'r1'))).toBe(false);
        svc.dispose();
    });
});

describe('MeetingService — concurrency', () => {
    it('concurrent raises from many users all land, in arrival order', async () => {
        const router = fakeRouter();
        const svc = new MeetingService({ router });
        const ids = Array.from({ length: 20 }, (_, i) => `u-${i}`);
        for (const u of ids) { connectAs(router, `c-${u}`, u); await svc.handleAction(`c-${u}`, 'subscribe', { meetingId: M }); }
        await Promise.all(ids.map((u) => svc.handleAction(`c-${u}`, 'hand.raise', { meetingId: M })));
        const state = (await svc.getState(M))!;
        expect(state.hands.map((h) => h.userId)).toEqual(ids);
        expect(state.version).toBe(1 + ids.length);
        svc.dispose();
    });
});

describe('MeetingService — announcement history (0.130.0)', () => {
    it('keeps the last 20, oldest first; a late joiner gets them; a new session keeps them', async () => {
        const { router, store, svc } = await setup({ rateLimit: false });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        for (let i = 1; i <= 25; i++) await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: `note ${i}` });
        const b = (await svc.getState(M))!.breakout;
        expect(b.announcements!.map((a) => a.message)).toEqual(Array.from({ length: 20 }, (_, i) => `note ${i + 6}`));
        expect(b.announcement!.message).toBe('note 25');
        connectAs(router, 'c-late', 'u-late', 'Late');
        await svc.handleAction('c-late', 'subscribe', { meetingId: M });
        expect(router.last('c-late', 'meeting.snapshot').data.breakout.announcements).toHaveLength(20);
        await svc.handleAction('c-org', 'breakout.end', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r2' }] });
        const again = (await svc.getState(M))!.breakout;
        expect(again.announcement).toBeNull();
        expect(again.announcements).toHaveLength(20);
        void store;
        svc.dispose();
    });

    it('stored state from before the field still takes announcements', async () => {
        const { store, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        const old = (await store.get(M))!;
        delete (old.breakout as { announcements?: unknown }).announcements;
        await store.put(old);
        await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: 'hello' });
        expect((await svc.getState(M))!.breakout.announcements!.map((a) => a.message)).toEqual(['hello']);
        svc.dispose();
    });
});

describe('MeetingService — configure refuses what the catalog refuses (0.131.0)', () => {
    it.each([
        ['a misspelled mode', { rooms: [{ id: 'r1' }], mode: 'self_select' }],
        ['a non-boolean allowReturnToMain', { rooms: [{ id: 'r1' }], allowReturnToMain: 'yes' }],
        ['a room that is not an object', { rooms: ['Room 1'] }],
        ['a room that is null', { rooms: [null] }],
        ['a numeric room name', { rooms: [{ id: 'r1', name: 42 }] }],
        ['members that are not userIds', { rooms: [{ id: 'r1', members: ['u-a', 7] }] }],
    ])('refuses %s with INVALID_PAYLOAD and changes nothing', async (_why, payload) => {
        const { router, svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'keep' }], mode: 'assigned' });
        const before = (await svc.getState(M))!;
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, ...payload });
        expect(router.last('c-org', 'error').error.code).toBe('INVALID_PAYLOAD');
        const after = (await svc.getState(M))!;
        expect(after.version).toBe(before.version);
        expect(after.breakout.mode).toBe('assigned');
        svc.dispose();
    });

    it('absent fields still keep their current values', async () => {
        const { svc } = await setup();
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }], mode: 'assigned', allowReturnToMain: false });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', name: null }] });
        const b = (await svc.getState(M))!.breakout;
        expect(b.mode).toBe('assigned');
        expect(b.settings.allowReturnToMain).toBe(false);
        expect(b.rooms[0]!.name).toBe('Room 1');
        svc.dispose();
    });
});

describe('MeetingService — rate limit (0.132.0)', () => {
    it('refuses writes past the burst with RATE_LIMITED, broadcasts nothing, and refills over time', async () => {
        let now = Date.parse('2026-10-16T12:00:00Z');
        const { router, svc } = await setup({ now: () => now, rateLimit: { burst: 3, perSecond: 1 } });
        const toggles = () => router.framesFor('c-org', 'hands.changed').length;
        for (let i = 0; i < 3; i++) await svc.handleAction('c-a', i % 2 ? 'hand.lower' : 'hand.raise', { meetingId: M });
        const sent = toggles();
        await svc.handleAction('c-a', 'hand.lower', { meetingId: M });
        expect(err(router, 'c-a').code).toBe('RATE_LIMITED');
        expect(toggles()).toBe(sent);
        // Another person in the same meeting has their own bucket.
        await svc.handleAction('c-b', 'hand.raise', { meetingId: M });
        expect(toggles()).toBe(sent + 1);
        // A second later there is one token again.
        now += 1000;
        await svc.handleAction('c-a', 'hand.lower', { meetingId: M });
        expect(toggles()).toBe(sent + 2);
        svc.dispose();
    });

    it('the default is generous: a quick burst of ordinary clicks passes', async () => {
        const { router, svc } = await setup();
        for (let i = 0; i < 12; i++) await svc.handleAction('c-a', i % 2 ? 'hand.lower' : 'hand.raise', { meetingId: M });
        expect(router.framesFor('c-a', 'error')).toHaveLength(0);
        svc.dispose();
    });

    it('subscribe is never limited, and rateLimit: false turns it off', async () => {
        const { router, svc } = await setup({ rateLimit: { burst: 1, perSecond: 0.001 } });
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-a', 'hand.lower', { meetingId: M });
        expect(err(router, 'c-a').code).toBe('RATE_LIMITED');
        await svc.handleAction('c-a', 'subscribe', { meetingId: M });
        expect(router.last('c-a', 'meeting.snapshot')).toBeDefined();
        svc.dispose();
        const off = await setup({ rateLimit: false });
        for (let i = 0; i < 40; i++) await off.svc.handleAction('c-a', i % 2 ? 'hand.lower' : 'hand.raise', { meetingId: M });
        expect(off.router.framesFor('c-a', 'error')).toHaveLength(0);
        off.svc.dispose();
    });
});

describe('MeetingService — resetMeeting (0.135.0)', () => {
    it('clears hands, rooms and announcements for everyone still subscribed, with a newer version', async () => {
        const { router, svc } = await setup({ rateLimit: false });
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', members: ['u-a'] }], mode: 'assigned' });
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: 'two minutes' });
        await svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 60_000 });
        const before = (await svc.getState(M))!.version;
        await svc.resetMeeting(M);
        const s = (await svc.getState(M))!;
        expect(s.hands).toEqual([]);
        expect(s.breakout.phase).toBe('none');
        expect(s.breakout.rooms).toEqual([]);
        expect(s.breakout.announcement).toBeNull();
        expect(s.breakout.announcements).toEqual([]);
        expect(s.breakout.endsAt).toBeNull();
        expect(s.version).toBeGreaterThan(before);
        expect(s.createdBy).toBe('u-org');
        expect(router.last('c-a', 'breakout.changed').data.breakout.phase).toBe('none');
        expect(router.last('c-a', 'hands.changed').data.hands).toEqual([]);
        // The organizer can run a fresh session in the same lobby.
        await svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r9' }] });
        expect((await svc.getState(M))!.breakout.rooms.map((r) => r.id)).toEqual(['r9']);
        svc.dispose();
    });

    it('is idempotent and leaves an unknown meeting alone', async () => {
        const { router, svc } = await setup();
        const frames = router.framesFor('c-a').length;
        await svc.resetMeeting(M); // nothing live: no frames
        await svc.resetMeeting('never:opened');
        expect(router.framesFor('c-a').length).toBe(frames);
        expect(await svc.getState('never:opened')).toBeNull();
        svc.dispose();
    });
});

