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
 * Auth (default: on). The SFU checks a bearer on its session routes
 * (POST /api/sessions, /:arn/join; live-video-streaming
 * src/middleware/cognito-auth.js). The harness server holds the SFU's
 * LVS_SERVICE_TOKEN and is the only caller that presents it; the browser gets
 * a per-lobby participant token and never the service token. The spec asserts
 * an anonymous create, an anonymous join and a join with a forged bearer are
 * each refused 401, that the shipped page does not contain the service
 * token, then runs the full scenario. COGNITO_USER_POOL_ID is a placeholder:
 * with no pool set, cognito-auth.js:88-91 answers a bearer-less call 500
 * (auth_config_error) before it checks the bearer, so a placeholder pool makes
 * the refusal the 401 it is in a deployment; the service path needs no pool.
 * REAL_LVS_AUTH=bypass runs against an LVS_AUTH_BYPASS SFU instead (no direct-
 * call checks; the host's mint guard is then the only guard).
 *
 * Known hole, recorded in the output (`arnHole`), not asserted: GET
 * /api/channels/:arn is unauthenticated and returns the channel's streamKey
 * (live-video-streaming src/api/channels/index.js:1983-1995), and that
 * streamKey mints a publisher token at POST /api/channels/:arn/participant-
 * tokens (src/api/channels/participantTokens.js). So the room guard holds only
 * while a client never learns another room's channel ARN; this host hands a
 * client only the ARN it minted for.
 *
 * Needs, none of them installed by this repo:
 *   - a Redis and an SFU from ~/Projects/live-video-streaming, private ports:
 *       redis-server --port 16499 --bind 127.0.0.1 --save '' --appendonly no
 *       export G21_SVC=$(openssl rand -hex 24)
 *       cd ~/Projects/live-video-streaming && NODE_ID=g21-sfu PORT=3913 SEED_NODES= \
 *         IS_DASHBOARD=false MEDIASOUP_WORKERS=1 MEDIASOUP_RTC_PORT=40160 \
 *         MEDIASOUP_RTC_TCP_PORT=40170 MEDIASOUP_RTC_TCP_PORT_PER_POD=false \
 *         MEDIASOUP_ANNOUNCED_IP=127.0.0.1 MEDIASOUP_ANNOUNCED_IP_TCP=127.0.0.1 \
 *         ADMIN_TOKEN=$(openssl rand -hex 24) LVS_SERVICE_TOKEN=$G21_SVC \
 *         COGNITO_USER_POOL_ID=us-east-1_g21NoPool JWT_KEY_DIR=/tmp/g21-no-keys \
 *         REDIS_URL=redis://127.0.0.1:16499 node src/server.js
 *     (JWT_KEY_DIR names a missing directory: the SFU mints ephemeral keys.
 *     For bypass mode drop LVS_SERVICE_TOKEN and COGNITO_USER_POOL_ID and set
 *     LVS_AUTH_BYPASS=true.) The SFU spawns ffmpeg children (thumbnails, HLS)
 *     that outlive it: list them with `pgrep -P <sfu pid>` before stopping it.
 *   - `playwright` (Chromium cached) and `esbuild`, from wherever they are
 *     installed: PLAYWRIGHT_MODULE / ESBUILD_MODULE point at the package
 *     directories when this repo's node_modules lacks them.
 *
 * Run:
 *   REAL_LVS=1 REAL_LVS_URL=http://127.0.0.1:3913 REAL_LVS_SERVICE_TOKEN=$G21_SVC \
 *   PLAYWRIGHT_MODULE=~/Projects/live-video-streaming/node_modules/playwright \
 *   ESBUILD_MODULE=~/Projects/ui-components/node_modules/esbuild \
 *     npx jest test/e2e-media --testTimeout=180000
 *
 * Two SFU nodes (optional, REAL_LVS_URL_B): the main lobby and r2 stay on node
 * A, breakout r1 is placed on node B. LVS has no placement hint on its API: a
 * channel is owned by the node that takes its first WHIP
 * (src/cluster/ChannelRouter.js:435), so the host places a lobby by creating
 * its session and minting its token on the chosen node and returning that
 * node's URL with the token; the page publishes there. The spec asserts Ada's
 * r1 producers are local on B, that A holds none locally for r1 (it holds
 * piped copies: LVS fans a new producer out to its peers), and that main has
 * none on B. Start both nodes like the single
 * one above with these per-node changes (same Redis, same tokens):
 *     A: NODE_ID=g21-sfu-a PORT=3913 SEED_NODES=127.0.0.1:5014 \
 *        MEDIASOUP_RTC_PORT=40160 MEDIASOUP_RTC_TCP_PORT=40170
 *     B: NODE_ID=g21-sfu-b PORT=3914 SEED_NODES=127.0.0.1:5013 \
 *        MEDIASOUP_RTC_PORT=40180 MEDIASOUP_RTC_TCP_PORT=40190
 *     both: HOST=127.0.0.1 CLUSTER_ANNOUNCE_ADDRESS=127.0.0.1
 *   (gossip port = 4100 + PORT - 3000, src/app.js:92-94) and add
 *   REAL_LVS_URL_B=http://127.0.0.1:3914 to the run. Limits of this local
 *   cluster, none of them on the path the spec takes:
 *   - CLUSTER_PUBSUB stays `memory`: `redis` switches dcore locks to its Redis
 *     backend, which needs `ioredis`, absent from live-video-streaming's
 *     node_modules and package.json (src/services/cluster-adapter.js:117-118,
 *     distributed-core dist/cluster/Cluster.js:142), so the node exits at
 *     boot. Gossip and peer RPC (the pipe handshake) run over TCP; channel,
 *     session and ownership state share the Redis.
 *   - A peer's HTTP port is taken to be the local PORT
 *     (src/services/cluster-adapter.js:403, src/cluster/ChannelRouter.js:1135;
 *     GET /api/nodes on A lists B at :3913), so a 307 to the owner or a
 *     /api/proxy hop between two nodes on one host lands on the wrong node.
 *     The spec never needs one: each client talks only to its lobby's node.
 *   - No subscriber decodes media across nodes: A registers piped copies of
 *     r1's producers, but each lobby's publishers and subscribers share a
 *     node, and useLVSHangout has no subscribe-only mode for a viewer on the
 *     other node, so nothing consumes a pipe.
 */

import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { breakoutLobbyName } from '../../src/meeting';
import { lobbyArn, startMediaServer, type MediaServer } from './server';

const enabled = process.env.REAL_LVS === '1';
const SFU = (process.env.REAL_LVS_URL ?? 'http://127.0.0.1:3913').replace(/\/$/, '');
/** 'on' (default): the SFU checks bearers and only the host holds the service token. 'bypass': LVS_AUTH_BYPASS. */
const AUTH: 'on' | 'bypass' = process.env.REAL_LVS_AUTH === 'bypass' ? 'bypass' : 'on';
const SERVICE_TOKEN = AUTH === 'on' ? (process.env.REAL_LVS_SERVICE_TOKEN ?? '') : undefined;
/** Optional second SFU node in the same cluster: when set, breakout r1 is placed on it. */
const SFU_B = process.env.REAL_LVS_URL_B ? process.env.REAL_LVS_URL_B.replace(/\/$/, '') : null;
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

interface Producer { id: string; kind: string; participantId: string; isPiped?: boolean }
/** The producers one SFU node holds for `arn`: its own (isPiped false) plus any piped in from a peer node. */
async function producers(arn: string, base: string = SFU): Promise<Producer[]> {
    const res = await fetch(`${base}/api/channels/${encodeURIComponent(arn)}/producers`);
    if (!res.ok) throw new Error(`producers ${res.status}`);
    return ((await res.json()) as { producers: Producer[] }).producers;
}
/** Which fixture users publish into `arn` on node `base` (local producers only), as "user:kind" sorted. */
async function publishers(arn: string, base: string = SFU): Promise<string[]> {
    return (await producers(arn, base)).filter((p) => !p.isPiped).map((p) => `${p.participantId.split('-')[0]}:${p.kind}`).sort();
}
/** POST to an SFU route with no bearer, or with a bearer that is not the service token. */
async function sfuStatus(route: string, body: unknown, bearer?: string, base: string = SFU): Promise<number> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return (await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) })).status;
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
        const nodeIds: Record<string, string> = { a: ((await health!.json()) as { nodeId: string }).nodeId };
        if (SFU_B) {
            const healthB = await fetch(`${SFU_B}/api/health`).catch(() => null);
            expect(healthB?.status).toBe(200);
            nodeIds.b = ((await healthB!.json()) as { nodeId: string }).nodeId;
            expect(nodeIds.b).not.toBe(nodeIds.a);
        }
        if (AUTH === 'on' && !SERVICE_TOKEN) {
            throw new Error('REAL_LVS_SERVICE_TOKEN is required (the SFU\'s LVS_SERVICE_TOKEN); set REAL_LVS_AUTH=bypass for an LVS_AUTH_BYPASS SFU');
        }

        const playwright = load('playwright', process.env.PLAYWRIGHT_MODULE);
        const esbuild = load('esbuild', process.env.ESBUILD_MODULE);
        const meetingId = `g21-${randomUUID().slice(0, 8)}`;
        const lobby = { main: meetingId, r1: breakoutLobbyName(meetingId, 'r1'), r2: breakoutLobbyName(meetingId, 'r2') };
        // Placement: with a second node, r1 lives there; main and r2 stay on node A.
        const node = { main: SFU, r1: SFU_B ?? SFU, r2: SFU };
        const sfuFor = (l: string) => (l === lobby.r1 ? node.r1 : l === lobby.r2 ? node.r2 : node.main);
        server = await startMediaServer({ sfuUrl: SFU, sfuServiceToken: SERVICE_TOKEN, sfuFor, users: USERS, esbuild });
        const arnOf = (l: string) => lobbyArn(sfuFor(l), l, SERVICE_TOKEN);
        const arn = { main: await arnOf(lobby.main), r1: await arnOf(lobby.r1), r2: await arnOf(lobby.r2) };
        expect(new Set(Object.values(arn)).size).toBe(3);

        // 0. Auth on: the SFU's session routes refuse a caller without the
        // service token, so a stage token comes only through the host's mint
        // (and its room guard). The browser is never handed the service token.
        const direct: Record<string, number> = {};
        if (AUTH === 'on') {
            direct.anonCreate = await sfuStatus('/api/sessions', { creatorId: 'bram', lobbyName: lobby.r1, findOrCreate: true });
            direct.anonJoin = await sfuStatus(`/api/sessions/${encodeURIComponent(arn.r1)}/join`, { userId: 'bram', role: 'publisher' });
            direct.forgedBearerJoin = await sfuStatus(`/api/sessions/${encodeURIComponent(arn.r1)}/join`,
                { userId: 'bram', role: 'publisher' }, 'bram-token');
            for (const status of Object.values(direct)) expect([401, 403]).toContain(status);
            const shipped = (await (await fetch(`${server.url}/`)).text()) + (await (await fetch(`${server.url}/page.js`)).text());
            expect(shipped.includes(SERVICE_TOKEN!)).toBe(false);
        }

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
            async () => ({ main: await publishers(arn.main), r1: await publishers(arn.r1, node.r1), r2: await publishers(arn.r2, node.r2) }),
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
        const roomProducers = { r1: (await producers(arn.r1, node.r1)).filter((p) => !p.isPiped), r2: await producers(arn.r2, node.r2) };
        expect(server.mints.filter((m) => m.lobby === lobby.r1 && m.status === 200).map((m) => m.sfu)).toEqual([node.r1]);
        // Two nodes: Ada's r1 media is held by node B, not node A. Node A may
        // hold a piped copy (LVS fans a new producer out to its peers), never
        // a local producer for r1.
        let crossNode: Record<string, unknown> | null = null;
        if (SFU_B) {
            const onA = await producers(arn.r1, SFU);
            expect(onA.filter((p) => !p.isPiped)).toEqual([]);
            expect(await publishers(arn.main, SFU_B)).toEqual([]);
            crossNode = {
                r1HeldBy: nodeIds.b,
                r1LocalOnB: roomProducers.r1.map((p) => `${p.participantId}:${p.kind}`),
                r1PipedOnA: onA.filter((p) => p.isPiped).map((p) => `${p.participantId}:${p.kind}`),
            };
        }

        // 3. A forged join: Bram asks for a token for r1.
        const forged = await bram.evaluate((l: string) => (window as any).__g21.mint(l), lobby.r1);
        expect(forged.status).toBe(403);
        expect(forged.body?.token).toBeUndefined();
        expect(server.mints).toEqual(expect.arrayContaining([
            { userId: 'ada', lobby: lobby.r1, status: 200, sfu: node.r1 },
            { userId: 'bram', lobby: lobby.r1, status: 403 },
        ]));
        expect(await publishers(arn.r1, node.r1)).toEqual(both('ada'));
        expect(server.mints.filter((m) => m.userId === 'bram' && m.lobby === lobby.r1 && m.status === 200)).toEqual([]);
        // Recorded, not asserted (an LVS hole outside this repo): anyone who
        // knows a channel ARN can read its streamKey from the unauthenticated
        // GET /api/channels/:arn, and that streamKey mints a publisher token
        // at POST /api/channels/:arn/participant-tokens. The room guard holds
        // only while a client never learns another room's ARN; the host hands
        // a client only the ARN it minted for.
        const r1Channel = await (await fetch(`${node.r1}/api/channels/${encodeURIComponent(arn.r1)}`)).json() as { streamKey?: string };
        const arnHole = {
            channelReadExposesStreamKey: typeof r1Channel.streamKey === 'string',
            streamKeyMintStatus: r1Channel.streamKey
                ? await sfuStatus(`/api/channels/${encodeURIComponent(arn.r1)}/participant-tokens`, { role: 'publisher' }, r1Channel.streamKey, node.r1)
                : null,
        };

        // 4. End breakouts: both return to the main lobby and decode each other again.
        const t4 = Date.now();
        organizer.send('breakout.end', { immediate: true });
        const back = await within('both back in main', MOVE_DEADLINE_MS,
            async () => ({ main: await publishers(arn.main), r1: await publishers(arn.r1, node.r1), r2: await publishers(arn.r2, node.r2) }),
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
            auth: AUTH, nodeIds, crossNode, direct, arnHole, meetingId, arn,
            main: pids(mainProducers), r1: pids(roomProducers.r1), r2: pids(roomProducers.r2), returned: pids(returned),
            rooms: rooms.value, back: back.value, forged: forged.status, timings, totalMs: Date.now() - started,
        }, null, 2));
    }, 180_000);
});
