// A dropped socket takes its seat back when it reconnects (aws-agentcore
// capacity review, 2026-10-01, change #4; reproduced by its load test's
// `churn` scenario against 0.99.3).
//
// Repro: a live call, one participant's socket drops, ~2 s later a fresh
// socket of the same person sends what useConversationCall sends on every
// reconnect — `status`, then `participant-state` — and never `accepted`
// again. Before the fix nothing re-registered that socket: the roster lacked
// the person, and in a two-party call the survivor got
// `ended { reason: 'rejoin-grace-expired' }` when the grace ran out, however
// soon they had come back. One gateway deploy ended every 1:1 call.
//
// The rejoin is admitted only for someone who held a seat in that call
// (caller or acceptor), on a frame naming the call's own lobby, so it is not
// a way into a call: a stranger, someone only rung, or a frame naming another
// lobby is forwarded as before and seats nobody.
//
// Runs with no store, the in-memory store and RedisCallStateStore on a Redis
// double. Grace is shortened to keep real sockets fast, as in
// calls-socket-close.test.ts.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from '../call/helpers/fakeRedis';

const GRACE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const storeCases: Array<{ name: string; make: () => CallStateStore | undefined }> = [
    { name: 'no store', make: () => undefined },
    { name: 'InMemoryCallStateStore', make: () => new InMemoryCallStateStore() },
    { name: 'RedisCallStateStore (Redis double)', make: () => new RedisCallStateStore(new FakeRedis() as any) },
];

describe.each(storeCases)('calls() over sockets — a reconnected socket rejoins its call ($name)', (sc) => {
    let server: http.Server;
    let handle: RealtimeHandle;
    let port: number;
    let ended: string[] = [];
    const open: WebSocket[] = [];

    beforeAll(async () => {
        server = http.createServer();
        handle = attachRealtime(server, {
            features: [calls({
                stateStore: sc.make(),
                rejoinGraceMs: GRACE_MS,
                // The consumer's tenant rule: the lobby's first segment is the org.
                lobbyGuard: (auth, lobby) => lobby.startsWith(`${String(auth.org)}`),
                config: { onCallEnded: (s) => { ended.push(s.callId); } },
            })],
            path: '/realtime',
            auth: async (req: http.IncomingMessage) => {
                const q = new URL(req.url ?? '', 'http://x').searchParams;
                return { userId: q.get('sub') ?? '', org: q.get('org') ?? 'acme' };
            },
        } as any);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const ws of open) try { ws.terminate(); } catch { /* */ }
        await handle.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });
    beforeEach(() => { ended = []; });

    type Conn = { ws: WebSocket; frames: any[]; sub: string };
    const connect = (sub: string, org = 'acme') => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}&org=${org}`);
        const conn: Conn = { ws, frames: [], sub };
        ws.on('message', (raw) => { try { conn.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', () => { open.push(ws); resolve(conn); });
        ws.on('error', reject);
    });
    const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify({ service: 'call', ...frame }));
    const waitFrame = async (c: Conn, match: (f: any) => boolean, timeoutMs = 2000) => {
        const start = Date.now();
        for (;;) {
            const f = c.frames.find(match);
            if (f) return f;
            if (Date.now() - start > timeoutMs) throw new Error('frame timeout');
            await sleep(10);
        }
    };
    /** A network drop: the socket dies without a close handshake. */
    const drop = async (c: Conn) => {
        c.ws.terminate();
        await sleep(100); // the server's close handler + store writes
    };
    const status = async (lobbyName: string) => {
        const c = await connect(`u-watch-${rand()}`);
        send(c, { action: 'status', lobbyName });
        const f = await waitFrame(c, (x) => x.action === 'active-call' && x.data?.lobbyName === lobbyName);
        c.ws.close();
        return f.data;
    };
    /** useConversationCall.announceSelf(). */
    const announce = (c: Conn, callId: string, lobbyName: string, peers: string[], extra: Record<string, unknown> = {}) =>
        send(c, {
            action: 'participant-state', callId, lobbyName, callerId: c.sub, userId: c.sub,
            displayName: c.sub, audioOn: true, cameraOn: true, screenSharing: false, status: 'in-call',
            targetUserIds: peers, ...extra,
        });
    /** Ring everyone else, everyone accepts: the frames useConversationCall sends. */
    const liveCall = async (lobbyName: string, members: string[]) => {
        const callId = `call-${rand()}`;
        const conns = new Map<string, Conn>();
        for (const m of members) conns.set(m, await connect(m));
        const [caller, ...callees] = members;
        send(conns.get(caller!)!, { action: 'invite', callId, lobbyName, callerId: caller, targetUserIds: callees });
        for (const m of callees) {
            const c = conns.get(m)!;
            await waitFrame(c, (f) => f.action === 'invite' && f.data?.callId === callId);
            send(c, { action: 'accepted', callId, callerId: m, userId: m, targetUserIds: [caller], lobbyName });
        }
        for (const m of callees) await waitFrame(conns.get(caller!)!, (f) => f.action === 'accepted' && f.data?.userId === m);
        await sleep(30);
        expect(await status(lobbyName)).toMatchObject({ active: true, callId, participantCount: members.length });
        return { callId, conns };
    };
    const others = (members: string[], self: string) => members.filter((m) => m !== self);
    const endedFrames = (c: Conn, callId: string) => c.frames.filter((f) => f.action === 'ended' && f.data?.callId === callId);

    it('1:1 — the dropped side reconnects and re-announces: back on the roster, no ended after the grace', async () => {
        const members = ['u-a', 'u-b'];
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, conns } = await liveCall(lobby, members);
        const b = conns.get('u-b')!;
        await drop(conns.get('u-a')!);
        expect(await waitFrame(b, (f) => f.action === 'user-status' && f.data?.callId === callId)).toMatchObject({
            data: { status: 'left', userId: 'u-a', rejoinGraceMs: GRACE_MS },
        });

        const a2 = await connect('u-a');
        send(a2, { action: 'status', lobbyName: lobby });
        announce(a2, callId, lobby, others(members, 'u-a'));
        // The survivor hears the reconnected person, as from any participant-state.
        await waitFrame(b, (f) => f.action === 'participant-state' && f.data?.callId === callId && f.data?.userId === 'u-a');
        await sleep(30);
        const s = await status(lobby);
        expect(s).toMatchObject({ active: true, callId, participantCount: 2 });
        expect([...s.participantUserIds].sort()).toEqual(['u-a', 'u-b']);
        expect(s.reconnecting).toBeUndefined();

        await sleep(GRACE_MS + 200);
        expect(endedFrames(b, callId)).toHaveLength(0);
        expect(endedFrames(a2, callId)).toHaveLength(0);
        expect(await status(lobby)).toMatchObject({ active: true, callId, participantCount: 2 });
        expect(ended).not.toContain(callId);

        // And it is a real seat: a later drop of the new socket starts a grace again.
        await drop(a2);
        const graceLefts = () => b.frames.filter((f) => f.action === 'user-status' && f.data?.callId === callId && f.data?.rejoinGraceMs === GRACE_MS);
        const start = Date.now();
        while (graceLefts().length < 2 && Date.now() - start < 2000) await sleep(10);
        expect(graceLefts()).toHaveLength(2);
        b.ws.close();
    });

    it('group of four — the dropped member reconnects: all four on the roster, nobody is ended', async () => {
        const members = ['u-a', 'u-b', 'u-c', 'u-d'];
        const lobby = `acme${rand()}:room:standup`;
        const { callId, conns } = await liveCall(lobby, members);
        await drop(conns.get('u-c')!);
        for (const m of ['u-a', 'u-b', 'u-d']) {
            await waitFrame(conns.get(m)!, (f) => f.action === 'user-status' && f.data?.callId === callId && f.data?.userId === 'u-c');
        }
        expect((await status(lobby)).participantCount).toBe(3);

        const c2 = await connect('u-c');
        send(c2, { action: 'status', lobbyName: lobby });
        announce(c2, callId, lobby, others(members, 'u-c'));
        await sleep(80);
        const s = await status(lobby);
        expect(s).toMatchObject({ active: true, callId, participantCount: 4 });
        expect([...s.participantUserIds].sort()).toEqual(members);

        await sleep(GRACE_MS + 150);
        for (const m of ['u-a', 'u-b', 'u-d']) expect(endedFrames(conns.get(m)!, callId)).toHaveLength(0);
        for (const m of ['u-a', 'u-b', 'u-d']) conns.get(m)!.ws.close();
        c2.ws.close();
    });

    it('a still-open old socket (half-open after a blip) hands its seat to the new one: one seat, no false "left"', async () => {
        const members = ['u-a', 'u-b'];
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, conns } = await liveCall(lobby, members);
        const a = conns.get('u-a')!;
        const b = conns.get('u-b')!;
        const a2 = await connect('u-a');
        announce(a2, callId, lobby, ['u-b']);
        await sleep(80);
        expect(await status(lobby)).toMatchObject({ active: true, callId, participantCount: 2 });

        // The old socket finally closes: it holds no seat, so nobody is told u-a left.
        await drop(a);
        await sleep(GRACE_MS + 150);
        expect(b.frames.filter((f) => f.action === 'user-status' && f.data?.callId === callId)).toHaveLength(0);
        expect(endedFrames(b, callId)).toHaveLength(0);
        expect(await status(lobby)).toMatchObject({ active: true, callId, participantCount: 2 });
        b.ws.close();
        a2.ws.close();
    });

    it('refused: someone never seated in the call cannot take a seat by announcing; the 1:1 still ends after the grace', async () => {
        const members = ['u-a', 'u-b'];
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, conns } = await liveCall(lobby, members);
        const b = conns.get('u-b')!;
        await drop(conns.get('u-a')!);

        // Same tenant (passes the lobby guard), right callId and lobby — but
        // u-eve was never in the call.
        const eve = await connect('u-eve');
        announce(eve, callId, lobby, ['u-b']);
        await sleep(80);
        const s = await status(lobby);
        expect(s.participantCount).toBe(1);
        expect(s.participantUserIds).toEqual(['u-b']);

        await sleep(GRACE_MS + 200);
        expect(endedFrames(b, callId).map((f) => f.data.reason)).toEqual(['rejoin-grace-expired']);
        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        eve.ws.close();
        b.ws.close();
    });

    it('refused: a callee who was only rung (never accepted) cannot take a seat by announcing', async () => {
        const lobby = `acme${rand()}:room:standup`;
        const callId = `call-${rand()}`;
        const a = await connect('u-a');
        const b = await connect('u-b');
        const c = await connect('u-c');
        send(a, { action: 'invite', callId, lobbyName: lobby, callerId: 'u-a', targetUserIds: ['u-b', 'u-c'] });
        await waitFrame(c, (f) => f.action === 'invite' && f.data?.callId === callId);
        send(b, { action: 'accepted', callId, callerId: 'u-b', userId: 'u-b', targetUserIds: ['u-a'], lobbyName: lobby });
        await waitFrame(a, (f) => f.action === 'accepted' && f.data?.userId === 'u-b');
        announce(c, callId, lobby, ['u-a', 'u-b']);
        await sleep(80);
        const s = await status(lobby);
        expect(s.participantCount).toBe(2);
        expect([...s.participantUserIds].sort()).toEqual(['u-a', 'u-b']);
        for (const x of [a, b, c]) x.ws.close();
    });

    it('refused: a seated person announcing without the lobby, or naming another lobby, is not re-seated', async () => {
        const members = ['u-a', 'u-b'];
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, conns } = await liveCall(lobby, members);
        const b = conns.get('u-b')!;
        await drop(conns.get('u-a')!);

        const a2 = await connect('u-a');
        announce(a2, callId, lobby, ['u-b'], { lobbyName: undefined }); // no lobby: the guard never judged it
        announce(a2, callId, `${lobby.split(':')[0]}:room:elsewhere`, ['u-b']); // a lobby the guard allows, not this call's
        await sleep(80);
        expect((await status(lobby)).participantCount).toBe(1);

        await sleep(GRACE_MS + 200);
        expect(endedFrames(b, callId).map((f) => f.data.reason)).toEqual(['rejoin-grace-expired']);
        a2.ws.close();
        b.ws.close();
    });

    it('refused: the lobby guard still decides — a reconnect from another tenant is refused before any rejoin', async () => {
        const members = ['u-a', 'u-b'];
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, conns } = await liveCall(lobby, members);
        const b = conns.get('u-b')!;
        await drop(conns.get('u-a')!);

        const a2 = await connect('u-a', 'other');
        announce(a2, callId, lobby, ['u-b']);
        expect(await waitFrame(a2, (f) => f.type === 'error' && f.service === 'call')).toMatchObject({ message: expect.stringMatching(/Not authorized/) });
        expect((await status(lobby)).participantCount).toBe(1);
        await sleep(GRACE_MS + 200);
        expect(endedFrames(b, callId).map((f) => f.data.reason)).toEqual(['rejoin-grace-expired']);
        a2.ws.close();
        b.ws.close();
    });
});

// Capacity review #13: calls() dropped `crossNodePubSub`, so a multi-node
// gateway built from attachRealtime never heard another node's departures.
describe('calls() — crossNodePubSub is forwarded to CallService', () => {
    it('subscribes to the departure topic and publishes on a drop', async () => {
        const subscribed: string[] = [];
        const published: Array<{ topic: string; payload: any }> = [];
        const pubsub = {
            subscribe: (topic: string) => { subscribed.push(topic); return () => undefined; },
            publish: (topic: string, payload: string) => { published.push({ topic, payload: JSON.parse(payload) }); },
        };
        const router = {
            sendToClient: () => true,
            broadcastToAll: () => undefined,
            getClientsByUserId: (ids: string[]) => ids.map((u) => ({ clientId: `c-${u}`, userId: u })),
            getUserIdForClient: (cid: string) => cid.replace(/^c-/, ''),
        };
        const svc: any = calls({ crossNodePubSub: pubsub, rejoinGraceMs: 0 }).create({ router: router as any, logger: { debug() {}, info() {}, warn() {}, error() {} } as any });
        expect(subscribed).toEqual(['call:client-departed']);
        await svc.handleCallEvent('c-u-a', 'invite', { callId: 'k1', lobbyName: 'acme:room:x', callerId: 'u-a', targetUserIds: ['u-b'] });
        await svc.handleCallEvent('c-u-b', 'accepted', { callId: 'k1', lobbyName: 'acme:room:x', callerId: 'u-b', targetUserIds: ['u-a'] });
        await svc.handleDisconnect('c-u-b');
        expect(published.map((p) => [p.topic, p.payload.callId, p.payload.departedClientId])).toEqual([['call:client-departed', 'k1', 'c-u-b']]);
        await svc.dispose();
    });
});
