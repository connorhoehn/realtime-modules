// Goal G19: one meeting at a real size — 300 people, 50 rooms, 100 hands,
// a full announcement history. Budgets are lenient (a loaded CI box must not
// flake); they catch an accidental quadratic or a snapshot that balloons.

import { MeetingService } from '../../src/meeting/MeetingService';
import { MAX_ANNOUNCEMENT_LENGTH } from '../../src/meeting/types';
import { connectAs, fakeRouter } from './helpers';

const M = 'demo:all-hands';

describe('MeetingService at scale (300 people, 50 rooms)', () => {
    it('stays fast and keeps the snapshot small', async () => {
        const router = fakeRouter();
        const svc = new MeetingService({ router, config: { rateLimit: false } });
        connectAs(router, 'c-org', 'u-org', 'Organizer');
        await svc.handleAction('c-org', 'subscribe', { meetingId: M });
        const users = Array.from({ length: 300 }, (_, i) => `u${i}`);
        for (const [i, u] of users.entries()) {
            connectAs(router, `c${i}`, u, `Person number ${i} with a longish display name`);
            await svc.handleAction(`c${i}`, 'subscribe', { meetingId: M });
        }

        let t0 = performance.now();
        for (let i = 0; i < 100; i++) await svc.handleAction(`c${i * 3}`, 'hand.raise', { meetingId: M });
        const handsMs = (performance.now() - t0) / 100;

        await svc.handleAction('c-org', 'breakout.configure', {
            meetingId: M,
            mode: 'assigned',
            rooms: Array.from({ length: 50 }, (_, r) => ({ id: `r${r}`, name: `Breakout room number ${r + 1}` })),
        });
        t0 = performance.now();
        await svc.handleAction('c-org', 'breakout.autoAssign', { meetingId: M, userIds: users });
        const autoAssignMs = performance.now() - t0;
        await svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        for (let i = 0; i < 20; i++) {
            await svc.handleAction('c-org', 'breakout.broadcast', { meetingId: M, message: 'x'.repeat(MAX_ANNOUNCEMENT_LENGTH) });
        }

        const state = (await svc.getState(M))!;
        expect(state.hands).toHaveLength(100);
        expect(state.breakout.rooms.every((r) => r.members.length === 6)).toBe(true);
        expect(router.framesFor('c-org', 'error')).toHaveLength(0);

        // A late joiner's snapshot: everything above, worst-case announcements.
        connectAs(router, 'c-late', 'u-late', 'Late');
        await svc.handleAction('c-late', 'subscribe', { meetingId: M });
        const snapshotBytes = Buffer.byteLength(JSON.stringify(router.last('c-late', 'meeting.snapshot')), 'utf8');

        if (process.env.MEETING_SCALE_REPORT) console.log(JSON.stringify({ handsMs, autoAssignMs, snapshotBytes }));
        // Budgets: per hand raise (store + fan-out to 301 clients), one auto-assign, snapshot size.
        expect({ handsMs: Math.round(handsMs), under: handsMs < 25 }).toMatchObject({ under: true });
        expect({ autoAssignMs: Math.round(autoAssignMs), under: autoAssignMs < 50 }).toMatchObject({ under: true });
        expect({ snapshotBytes, under: snapshotBytes < 64 * 1024 }).toMatchObject({ under: true });
        svc.dispose();
    });
});
