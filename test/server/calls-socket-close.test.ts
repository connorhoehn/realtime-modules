// attachRealtime + calls(): a call whose sockets are gone must not answer
// `status` as live (aws-agentcore report against 0.98.3).
//
// Repro: two clients join `<org>:dm:<a>:<b>` (ring → accept → live), one
// hangs up, then BOTH sockets close; a third connection's `status` said
// `active: true, participants: 1` — a ghost. Two holes made it:
//   - the socket close never reached CallService under attachRealtime (the
//     ws handler calls `onClientDisconnect`; CallService only had
//     `handleDisconnect`, which the realtime-examples gateway calls itself);
//   - the "a DM ends when one party hangs up" rule matched only a bare
//     `dm:` lobby, never a tenant-prefixed `acme:dm:…` one.
//
// Run for the in-memory store, RedisCallStateStore on a Redis double, and
// RedisCallStateStore on a real Redis when one answers at CALL_TEST_REDIS_URL
// (default redis://127.0.0.1:16379, the realtime-examples Tilt Redis).

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createClient } from 'redis';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from '../call/helpers/fakeRedis';

const GRACE_MS = 300;
const REDIS_URL = process.env.CALL_TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

type StoreCase = { name: string; make: () => Promise<CallStateStore | null>; close?: () => Promise<void> };

let realRedis: ReturnType<typeof createClient> | null = null;
const storeCases: StoreCase[] = [
    { name: 'InMemoryCallStateStore', make: async () => new InMemoryCallStateStore() },
    { name: 'RedisCallStateStore (Redis double)', make: async () => new RedisCallStateStore(new FakeRedis() as any) },
    {
        name: `RedisCallStateStore (real Redis ${REDIS_URL})`,
        make: async () => {
            const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 500, reconnectStrategy: false } });
            client.on('error', () => { /* reported through connect() */ });
            try {
                await client.connect();
                await client.ping();
            } catch {
                try { await client.disconnect(); } catch { /* */ }
                return null;
            }
            realRedis = client;
            return new RedisCallStateStore(client as any);
        },
        close: async () => { if (realRedis) { await realRedis.quit(); realRedis = null; } },
    },
];

describe.each(storeCases)('calls() over sockets — no ghost participant after both sockets close ($name)', (sc) => {
    let server: http.Server;
    let handle: RealtimeHandle;
    let port: number;
    let store: CallStateStore | null = null;
    let ended: Array<{ callId: string; lobbyName: string }> = [];
    const open: WebSocket[] = [];

    beforeAll(async () => {
        store = await sc.make();
        if (!store) return;
        server = http.createServer();
        handle = attachRealtime(server, {
            features: [calls({
                stateStore: store,
                rejoinGraceMs: GRACE_MS,
                config: { onCallEnded: (s) => { ended.push({ callId: s.callId, lobbyName: s.lobbyName }); } },
            })],
            path: '/realtime',
            auth: async (req: http.IncomingMessage) => {
                const q = new URL(req.url ?? '', 'http://x').searchParams;
                return { userId: q.get('sub') ?? '', org: q.get('org') ?? '' };
            },
        } as any);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const ws of open) try { ws.terminate(); } catch { /* */ }
        if (handle) await handle.dispose();
        if (server) await new Promise<void>((r) => server.close(() => r()));
        await sc.close?.();
    });
    beforeEach(() => { ended = []; });

    const skip = () => {
        if (store) return false;
        // eslint-disable-next-line no-console
        console.warn(`[calls-socket-close] skipped: no Redis at ${REDIS_URL}`);
        return true;
    };

    type Conn = { ws: WebSocket; frames: any[] };
    const connect = (sub: string) => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}&org=acme`);
        const conn: Conn = { ws, frames: [] };
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
    const closeAndSettle = async (...cs: Conn[]) => {
        for (const c of cs) c.ws.close();
        const start = Date.now();
        while (cs.some((c) => c.ws.readyState !== WebSocket.CLOSED) && Date.now() - start < 2000) await sleep(10);
        await sleep(80); // the server's close handler + fire-and-forget store writes
    };
    const status = async (lobbyName: string) => {
        const c = await connect(`u-watch-${rand()}`);
        send(c, { action: 'status', lobbyName });
        const f = await waitFrame(c, (x) => x.type === 'call' && x.action === 'active-call' && x.data?.lobbyName === lobbyName);
        c.ws.close();
        return f.data;
    };
    /** Ring → accept → live, the frames useConversationCall sends. */
    const liveCall = async (lobbyName: string) => {
        const callId = `call-${rand()}`;
        const a = await connect('u-a');
        const b = await connect('u-b');
        send(a, { action: 'invite', callId, lobbyName, callerId: 'u-a', targetUserIds: ['u-b'] });
        await waitFrame(b, (f) => f.action === 'invite' && f.data?.callId === callId);
        send(b, { action: 'accepted', callId, callerId: 'u-b', userId: 'u-b', targetUserIds: ['u-a'], lobbyName });
        await waitFrame(a, (f) => f.action === 'accepted' && f.data?.callId === callId);
        await sleep(30);
        expect(await status(lobbyName)).toMatchObject({ active: true, callId, participantCount: 2 });
        return { callId, a, b };
    };
    /** useConversationCall.leave(): user-status left to the peers, then `ended` targeted at yourself. */
    const hangUp = (c: Conn, callId: string, lobbyName: string, self: string, peer: string) => {
        send(c, { action: 'user-status', callId, callerId: self, userId: self, lobbyName, status: 'left', reason: 'hung-up', targetUserIds: [peer] });
        send(c, { action: 'ended', callId, callerId: self, lobbyName, targetUserIds: [self] });
    };
    const storedCall = async (callId: string) => (store ? store.getCall(callId) : null);

    it('DM: one hangs up, both sockets close → status is inactive, the store forgot the call, onCallEnded once', async () => {
        if (skip()) return;
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, a, b } = await liveCall(lobby);
        hangUp(a, callId, lobby, 'u-a', 'u-b');
        await sleep(50);
        await closeAndSettle(a, b);

        const s = await status(lobby);
        expect(s).toEqual({ lobbyName: lobby, active: false });
        expect(await storedCall(callId)).toBeNull();

        await sleep(GRACE_MS + 150);
        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        expect(ended.filter((e) => e.callId === callId)).toHaveLength(1);
    });

    it('DM: both sockets close with no hang-up → status is inactive once both are gone, onCallEnded once', async () => {
        if (skip()) return;
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, a, b } = await liveCall(lobby);
        await closeAndSettle(a, b);

        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        expect(await storedCall(callId)).toBeNull();
        await sleep(GRACE_MS + 150);
        expect(ended.filter((e) => e.callId === callId)).toHaveLength(1);
    });

    it('DM: one socket closes → the survivor is live, the dropped person is reported in the rejoin grace; after it the call is gone', async () => {
        if (skip()) return;
        const lobby = `acme${rand()}:dm:u-a:u-b`;
        const { callId, a, b } = await liveCall(lobby);
        const before = Date.now();
        await closeAndSettle(a);

        // The survivor is told who dropped, by name, with the grace.
        expect(await waitFrame(b, (f) => f.action === 'user-status' && f.data?.callId === callId)).toMatchObject({
            data: { status: 'left', userId: 'u-a', rejoinGraceMs: GRACE_MS },
        });
        const s = await status(lobby);
        expect(s).toMatchObject({ active: true, callId, participantCount: 1, participantUserIds: ['u-b'] });
        expect(s.reconnecting).toHaveLength(1);
        expect(s.reconnecting[0].userId).toBe('u-a');
        const until = Date.parse(s.reconnecting[0].graceUntil);
        expect(until).toBeGreaterThanOrEqual(before + GRACE_MS - 50);
        expect(until).toBeLessThanOrEqual(Date.now() + GRACE_MS + 50);

        await sleep(GRACE_MS + 150);
        expect(b.frames.some((f) => f.action === 'ended' && f.data?.callId === callId && f.data?.reason === 'rejoin-grace-expired')).toBe(true);
        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        expect(await storedCall(callId)).toBeNull();
        expect(ended.filter((e) => e.callId === callId)).toHaveLength(1);
        await closeAndSettle(b);
    });

    it('room: one leaves (the room keeps the other), then both sockets close → status is inactive, onCallEnded once', async () => {
        if (skip()) return;
        const lobby = `room:acme-${rand()}`;
        const { callId, a, b } = await liveCall(lobby);
        hangUp(a, callId, lobby, 'u-a', 'u-b');
        await sleep(50);
        // A room may keep one person: b is still in the call, and live.
        expect(await status(lobby)).toMatchObject({ active: true, callId, participantCount: 1, participantUserIds: ['u-b'] });
        expect(ended).toHaveLength(0);

        await closeAndSettle(a, b);
        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        expect(await storedCall(callId)).toBeNull();
        await sleep(GRACE_MS + 150);
        expect(ended.filter((e) => e.callId === callId)).toHaveLength(1);
    });

    it('room: one socket closes → reported in the grace, then removed once the grace expires', async () => {
        if (skip()) return;
        const lobby = `room:acme-${rand()}`;
        const { callId, a, b } = await liveCall(lobby);
        await closeAndSettle(a);
        const s = await status(lobby);
        expect(s).toMatchObject({ active: true, callId, participantCount: 1, participantUserIds: ['u-b'] });
        expect(s.reconnecting?.[0]?.userId).toBe('u-a');

        await closeAndSettle(b);
        expect(await status(lobby)).toEqual({ lobbyName: lobby, active: false });
        await sleep(GRACE_MS + 150);
        expect(await storedCall(callId)).toBeNull();
        expect(ended.filter((e) => e.callId === callId)).toHaveLength(1);
    });
});
