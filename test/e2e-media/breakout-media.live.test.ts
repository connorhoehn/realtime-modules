/**
 * G21 — live-media rehearsal: breakout rooms move real WebRTC media between
 * LVS lobbies on a real SFU. Opt-in; the normal suite skips it.
 *
 * What runs: the real gateway (`attachRealtime` + `meeting()`, ./server.ts),
 * two headless Chromium pages with fake camera/mic (Ada, Bram; ./page.tsx:
 * useMeeting + useFollowMeetingLobby + useLVSHangout), and an organizer
 * (Olive) on a plain WebSocket. Assertions read the SFU's own producer list
 * (GET /api/channels/:arn/producers), one ARN per lobby.
 *
 * Needs, none of them installed by this repo:
 *   - a Redis and an SFU from ~/Projects/live-video-streaming, private ports:
 *       redis-server --port 16499 --bind 127.0.0.1 --save '' --appendonly no
 *       cd ~/Projects/live-video-streaming && NODE_ID=g21-sfu PORT=3913 SEED_NODES= \
 *         IS_DASHBOARD=false MEDIASOUP_WORKERS=1 MEDIASOUP_RTC_PORT=40160 \
 *         MEDIASOUP_RTC_TCP_PORT=40170 MEDIASOUP_RTC_TCP_PORT_PER_POD=false \
 *         MEDIASOUP_ANNOUNCED_IP=127.0.0.1 MEDIASOUP_ANNOUNCED_IP_TCP=127.0.0.1 \
 *         ADMIN_TOKEN=admin LVS_AUTH_BYPASS=true JWT_KEY_DIR=/tmp/g21-no-keys \
 *         REDIS_URL=redis://127.0.0.1:16499 node src/server.js
 *     (JWT_KEY_DIR names a missing directory: the SFU mints ephemeral keys.)
 *   - `playwright` (Chromium cached) and `esbuild`, from wherever they are
 *     installed: PLAYWRIGHT_MODULE / ESBUILD_MODULE point at the package
 *     directories when this repo's node_modules lacks them.
 *
 * Run:
 *   REAL_LVS=1 REAL_LVS_URL=http://127.0.0.1:3913 \
 *   PLAYWRIGHT_MODULE=~/Projects/live-video-streaming/node_modules/playwright \
 *   ESBUILD_MODULE=~/Projects/ui-components/node_modules/esbuild \
 *     npx jest test/e2e-media --testTimeout=180000
 */

import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { breakoutLobbyName } from '../../src/meeting';
import { lobbyArn, startMediaServer, type MediaServer } from './server';

const enabled = process.env.REAL_LVS === '1';
const SFU = (process.env.REAL_LVS_URL ?? 'http://127.0.0.1:3913').replace(/\/$/, '');
const MOVE_DEADLINE_MS = 30_000;

const USERS: Record<string, string> = { 'ada-token': 'ada', 'bram-token': 'bram', 'olive-token': 'olive' };

function load(name: string, override: string | undefined): any {
    const expand = (p: string) => p.replace(/^~(?=\/)/, process.env.HOME ?? '~');
    try { return require(override ? expand(override) : name); } catch (e) {
        throw new Error(`${name} is not resolvable${override ? ` at ${override}` : ''}; set ${name.toUpperCase()}_MODULE (${String(e)})`);
    }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `probe` until `ok`, or fail at the deadline with the last observation. */
async function within<T>(what: string, ms: number, probe: () => Promise<T>, ok: (v: T) => boolean): Promise<{ value: T; ms: number }> {
    const t0 = Date.now();
    let last: T | undefined;
    let lastErr: unknown = null;
    while (Date.now() - t0 < ms) {
        try { last = await probe(); lastErr = null; if (ok(last)) return { value: last, ms: Date.now() - t0 }; } catch (e) { lastErr = e; }
        await delay(250);
    }
    throw new Error(`${what}: not true within ${ms} ms; last ${JSON.stringify(last)}${lastErr ? ` (${String(lastErr)})` : ''}`);
}

interface Producer { id: string; kind: string; participantId: string }
async function producers(arn: string): Promise<Producer[]> {
    const res = await fetch(`${SFU}/api/channels/${encodeURIComponent(arn)}/producers`);
    if (!res.ok) throw new Error(`producers ${res.status}`);
    return ((await res.json()) as { producers: Producer[] }).producers;
}
/** Which fixture users publish into `arn`, as "user:kind" sorted. */
async function publishers(arn: string): Promise<string[]> {
    return (await producers(arn)).map((p) => `${p.participantId.split('-')[0]}:${p.kind}`).sort();
}
const both = (u: string) => [`${u}:audio`, `${u}:video`];

function organizerSocket(url: string, meetingId: string) {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime?token=olive-token`);
    const frames: any[] = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* */ } });
    const opened = new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
    const send = (action: string, extra: Record<string, unknown> = {}) =>
        ws.send(JSON.stringify({ service: 'meeting', action, meetingId, ...extra }));
    return { ws, frames, opened, send };
}

(enabled ? describe : describe.skip)('G21 live media: breakout rooms on a real SFU', () => {
    let server: MediaServer | null = null;
    let browser: any = null;
    let organizer: ReturnType<typeof organizerSocket> | null = null;

    afterAll(async () => {
        await browser?.close().catch(() => undefined);
        organizer?.ws.close();
        await server?.close().catch(() => undefined);
    });

    it('moves each publisher into its room lobby, refuses a forged join, and brings everyone back', async () => {
        const started = Date.now();
        const health = await fetch(`${SFU}/api/health`).catch(() => null);
        expect(health?.status).toBe(200);

        const playwright = load('playwright', process.env.PLAYWRIGHT_MODULE);
        const esbuild = load('esbuild', process.env.ESBUILD_MODULE);
        server = await startMediaServer({ sfuUrl: SFU, users: USERS, esbuild });

        const meetingId = `g21-${randomUUID().slice(0, 8)}`;
        const lobby = { main: meetingId, r1: breakoutLobbyName(meetingId, 'r1'), r2: breakoutLobbyName(meetingId, 'r2') };
        const arn = { main: await lobbyArn(SFU, lobby.main), r1: await lobbyArn(SFU, lobby.r1), r2: await lobbyArn(SFU, lobby.r2) };
        expect(new Set(Object.values(arn)).size).toBe(3);

        // The organizer subscribes first, so the meeting's creator is Olive.
        organizer = organizerSocket(server.url, meetingId);
        await organizer.opened;
        organizer.send('subscribe');
        await within('organizer snapshot', 5_000, async () => organizer!.frames.find((f) => f.action === 'meeting.snapshot'),
            (f) => f?.data?.you?.organizer === true);

        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
        });
        const open = async (user: string) => {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(`${server!.url}/?user=${user}&token=${user}-token&meeting=${encodeURIComponent(meetingId)}&sfu=${encodeURIComponent(SFU)}`);
            return page;
        };
        const ada = await open('ada');
        const bram = await open('bram');
        const state = (page: any) => page.evaluate(() => {
            const v = (window as any).__g21;
            const videos = [...document.querySelectorAll('video[data-pid]')].map((el) => {
                const e = el as HTMLVideoElement;
                return { pid: e.dataset.pid, w: e.videoWidth, t: e.currentTime };
            });
            return { activeLobby: v.activeLobby, lobby: v.call?.lobby ?? null, joined: v.isJoined, conn: v.connectionState,
                error: v.hangoutError ?? v.followError ?? v.joinError ?? v.bootError ?? null, videos };
        });
        /** The other participant's video is decoding on this page. */
        const sees = (s: { videos: Array<{ pid?: string; w: number; t: number }> }, user: string) =>
            s.videos.some((v) => v.pid?.startsWith(`${user}-`) && v.w > 0 && v.t > 0);
        const timings: Record<string, number> = {};

        // 1. Both publish into the main lobby, and each decodes the other.
        timings.mainPublish = (await within('both publish into main', MOVE_DEADLINE_MS, () => publishers(arn.main),
            (p) => JSON.stringify(p) === JSON.stringify([...both('ada'), ...both('bram')]))).ms;
        timings.mainDecode = (await within('each decodes the other in main', MOVE_DEADLINE_MS,
            async () => [await state(ada), await state(bram)], ([a, b]) => sees(a, 'bram') && sees(b, 'ada'))).ms;
        const mainProducers = await producers(arn.main);

        // 2. Ada → r1, Bram → r2; open.
        const t2 = Date.now();
        organizer.send('breakout.configure', { mode: 'assigned', rooms: [
            { id: 'r1', name: 'Room 1', members: ['ada'] },
            { id: 'r2', name: 'Room 2', members: ['bram'] },
        ] });
        organizer.send('breakout.open');
        await within('rooms open', 5_000, async () => organizer!.frames.filter((f) => f.action === 'breakout.changed').pop(),
            (f) => f?.data?.breakout?.phase === 'open');
        const rooms = await within('each publisher sits only in its room', MOVE_DEADLINE_MS,
            async () => ({ main: await publishers(arn.main), r1: await publishers(arn.r1), r2: await publishers(arn.r2) }),
            (p) => p.main.length === 0 && JSON.stringify(p.r1) === JSON.stringify(both('ada')) && JSON.stringify(p.r2) === JSON.stringify(both('bram')));
        timings.roomsMove = Date.now() - t2;
        const [adaInRoom, bramInRoom] = [await state(ada), await state(bram)];
        expect(adaInRoom).toMatchObject({ activeLobby: lobby.r1, lobby: lobby.r1 });
        expect(bramInRoom).toMatchObject({ activeLobby: lobby.r2, lobby: lobby.r2 });
        // In separate rooms they no longer receive each other: once both are
        // connected in their rooms, hold long enough for discovery to surface
        // any producer in the channel, and see no remote tile.
        await within('both connected in their rooms', MOVE_DEADLINE_MS, async () => [await state(ada), await state(bram)],
            ([a, b]) => a.conn === 'connected' && b.conn === 'connected');
        await delay(2_000);
        const [adaHeld, bramHeld] = [await state(ada), await state(bram)];
        expect([adaHeld.videos, bramHeld.videos]).toEqual([[], []]);
        const roomProducers = { r1: await producers(arn.r1), r2: await producers(arn.r2) };

        // 3. A forged join: Bram asks for a token for r1.
        const forged = await bram.evaluate((l: string) => (window as any).__g21.mint(l), lobby.r1);
        expect(forged.status).toBe(403);
        expect(forged.body?.token).toBeUndefined();
        expect(server.mints).toEqual(expect.arrayContaining([
            { userId: 'ada', lobby: lobby.r1, status: 200 },
            { userId: 'bram', lobby: lobby.r1, status: 403 },
        ]));
        expect(await publishers(arn.r1)).toEqual(both('ada'));

        // 4. End breakouts: both return to the main lobby and decode each other again.
        const t4 = Date.now();
        organizer.send('breakout.end', { immediate: true });
        const back = await within('both back in main', MOVE_DEADLINE_MS,
            async () => ({ main: await publishers(arn.main), r1: await publishers(arn.r1), r2: await publishers(arn.r2) }),
            (p) => JSON.stringify(p.main) === JSON.stringify([...both('ada'), ...both('bram')]) && p.r1.length === 0 && p.r2.length === 0);
        timings.returnMove = Date.now() - t4;
        timings.returnDecode = (await within('each decodes the other after return', MOVE_DEADLINE_MS,
            async () => [await state(ada), await state(bram)], ([a, b]) => sees(a, 'bram') && sees(b, 'ada'))).ms;
        const returned = await producers(arn.main);

        const pids = (ps: Producer[]) => [...new Set(ps.map((p) => p.participantId))].sort();
        // A move is a new WHIP session: fresh participant ids each hop.
        expect(pids(returned)).not.toEqual(pids(mainProducers));
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
            meetingId, arn,
            main: pids(mainProducers), r1: pids(roomProducers.r1), r2: pids(roomProducers.r2), returned: pids(returned),
            rooms: rooms.value, back: back.value, forged: forged.status, timings, totalMs: Date.now() - started,
        }, null, 2));
    }, 180_000);
});
