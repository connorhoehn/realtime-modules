// A person with more than one socket, on either side of a DM ring.
//
// Reported against 0.99.0 (realtime-examples gateway): a DM ring did not
// reach the callee while the caller had a second, idle socket open. Over the
// library's own socket path (both stores) and a CallService built directly on
// an app-shaped router, the ring reaches the callee whatever the caller's
// other sockets are doing — these tests pin that. What 0.99.0 did get wrong
// is the callee side: two sockets of the callee could both accept, so the DM
// held the callee twice and the caller saw two answers. Now the first accept
// takes the call and a later one from the same person is told
// `ended { reason: 'answered-elsewhere' }`.
//
// The rule, both sides:
//   caller — every socket of the caller other than the one that rang gets no
//     invite, gets the callee's `accepted` and the call's `ended`, and has no
//     say in whether the callee rings.
//   callee — every socket rings; the first `accepted` wins; the others get
//     the winner's `accepted` (dismiss the ring) and, if they accept anyway,
//     `ended { reason: 'answered-elsewhere' }` and nothing reaches the caller.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';
import { CallService } from '../../src/call/CallService';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from '../call/helpers/fakeRedis';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const storeCases: Array<{ name: string; make: () => CallStateStore }> = [
    { name: 'InMemoryCallStateStore', make: () => new InMemoryCallStateStore() },
    { name: 'RedisCallStateStore (Redis double)', make: () => new RedisCallStateStore(new FakeRedis() as any) },
];

type Conn = { frames: any[]; send: (f: Record<string, unknown>) => void; close: () => Promise<void> };

/** The frames of one call a socket received, by action. */
const actions = (c: Conn, callId: string) =>
    c.frames.filter((f) => f.type === 'call' && f.data?.callId === callId).map((f) => f.action as string);
const count = (c: Conn, callId: string, action: string) => actions(c, callId).filter((a) => a === action).length;
const errors = (c: Conn) => c.frames.filter((f) => f.type === 'error');

type Harness = { connect: (sub: string) => Promise<Conn>; settle: () => Promise<void>; stop: () => Promise<void> };

/** attachRealtime + calls() over real sockets. */
async function socketHarness(store: CallStateStore): Promise<Harness> {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [calls({ stateStore: store })],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => {
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            return { userId: q.get('sub') ?? '', org: 'acme' };
        },
    } as any);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const open: WebSocket[] = [];
    const connect = (sub: string) => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}`);
        const frames: any[] = [];
        ws.on('message', (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', () => {
            open.push(ws);
            resolve({
                frames,
                send: (f) => ws.send(JSON.stringify({ service: 'call', ...f })),
                close: async () => {
                    ws.close();
                    while (ws.readyState !== WebSocket.CLOSED) await sleep(10);
                    await sleep(50);
                },
            });
        });
        ws.on('error', reject);
    });
    return {
        connect,
        settle: () => sleep(120),
        stop: async () => {
            for (const ws of open) try { ws.terminate(); } catch { /* */ }
            await handle.dispose();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}

/**
 * A CallService built directly, the way the realtime-examples gateway builds
 * it: an async, cluster-shaped getClientsByUserId that returns { clientId,
 * userId, nodeId } in connection order and treats excludeClientId as
 * optional, a sync getUserIdForClient and a three-state isClientLive.
 */
async function directHarness(store: CallStateStore): Promise<Harness> {
    const clients = new Map<string, { userId: string; frames: any[]; open: boolean }>();
    const router = {
        async getClientsByUserId(userIds: string[], excludeClientId: string | null = null) {
            const out: Array<{ clientId: string; userId: string; nodeId: string }> = [];
            for (const [clientId, c] of clients) {
                if (clientId === excludeClientId || !c.open || !userIds.includes(c.userId)) continue;
                out.push({ clientId, userId: c.userId, nodeId: 'node-1' });
            }
            return out;
        },
        sendToClient(clientId: string, message: unknown) {
            const c = clients.get(clientId);
            if (!c || !c.open) return false;
            c.frames.push(JSON.parse(JSON.stringify(message)));
            return true;
        },
        async broadcastToAll(message: unknown, excludeClientId: string) {
            for (const [cid] of clients) if (cid !== excludeClientId) router.sendToClient(cid, message);
        },
        getUserIdForClient: (clientId: string) => clients.get(clientId)?.userId ?? null,
        isClientLive: (clientId: string) => {
            const c = clients.get(clientId);
            return c ? c.open : null;
        },
    };
    const service = new CallService({
        messageRouter: router as any,
        stateStore: store,
        logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
        config: {
            // The gateway's authorize: callerId must be the sender's user.
            authorize: (clientId: string, _action: string, data: { callerId?: unknown }) =>
                typeof data?.callerId !== 'string' || data.callerId === clients.get(clientId)?.userId,
        },
    } as any);
    let n = 0;
    return {
        connect: async (sub: string) => {
            const clientId = `cid-${sub}-${++n}`;
            const c = { userId: sub, frames: [] as any[], open: true };
            clients.set(clientId, c);
            await service.replayActiveInvitesForUser(clientId, sub);
            return {
                frames: c.frames,
                send: (f) => { void service.handleAction(clientId, String(f.action), f as any); },
                close: async () => { c.open = false; await service.handleDisconnect(clientId); },
            };
        },
        settle: () => sleep(60),
        stop: () => service.dispose(),
    };
}

const harnesses: Array<{ name: string; make: (store: CallStateStore) => Promise<Harness> }> = [
    { name: 'attachRealtime sockets', make: socketHarness },
    { name: 'CallService built directly', make: directHarness },
];

const cases = harnesses.flatMap((h) => storeCases.map((s) => ({ name: `${h.name}, ${s.name}`, h, s })));

describe.each(cases)('DM calls with multi-socket users ($name)', ({ h, s }) => {
    let hx: Harness;
    beforeAll(async () => { hx = await h.make(s.make()); });
    afterAll(async () => { await hx.stop(); });

    const pair = () => {
        const a = `u-a-${rand()}`;
        const b = `u-b-${rand()}`;
        return { a, b, lobbyName: `acme:dm:${a}:${b}`, callId: `c-${rand()}` };
    };
    const status = async (lobbyName: string) => {
        const w = await hx.connect(`u-watch-${rand()}`);
        w.send({ action: 'status', lobbyName });
        await hx.settle();
        const f = w.frames.find((x) => x.action === 'active-call' && x.data?.lobbyName === lobbyName);
        await w.close();
        return f?.data;
    };

    it.each([
        ['opened before the ringing socket, having asked for status', true],
        ['opened after the ringing socket, idle', false],
    ])('caller has a second socket (%s): the callee rings, both caller sockets see the answer and the end', async (_label, secondFirst) => {
        const { a, b, lobbyName, callId } = pair();
        let a1: Conn;
        let a2: Conn;
        if (secondFirst) {
            a2 = await hx.connect(a);
            a2.send({ action: 'status', lobbyName });
            await hx.settle();
            a1 = await hx.connect(a);
        } else {
            a1 = await hx.connect(a);
            a2 = await hx.connect(a);
        }
        const b1 = await hx.connect(b);

        a1.send({ action: 'invite', callId, lobbyName, callerId: a, callerName: 'A', targetUserIds: [b] });
        await hx.settle();
        expect(count(b1, callId, 'invite')).toBe(1);
        expect(actions(a1, callId)).toEqual([]);
        expect(actions(a2, callId)).toEqual([]); // the caller's other socket is not rung
        expect(errors(a1)).toEqual([]);

        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        expect(count(a1, callId, 'accepted')).toBe(1);
        expect(count(a2, callId, 'accepted')).toBe(1);
        expect(await status(lobbyName)).toMatchObject({ active: true, callId, participantCount: 2 });

        // useConversationCall.leave(): user-status to the peer, `ended` at yourself.
        a1.send({ action: 'user-status', callId, callerId: a, userId: a, lobbyName, status: 'left', reason: 'hung-up', targetUserIds: [b] });
        a1.send({ action: 'ended', callId, callerId: a, lobbyName, targetUserIds: [a] });
        await hx.settle();
        expect(count(a2, callId, 'ended')).toBe(1);
        expect(await status(lobbyName)).toMatchObject({ active: false });
        expect(errors(a1)).toEqual([]);
        expect(errors(a2)).toEqual([]);
        await Promise.all([a1.close(), a2.close(), b1.close()]);
    });

    it('closing the caller\'s idle socket mid-ring does not cancel the ring', async () => {
        const { a, b, lobbyName, callId } = pair();
        const a1 = await hx.connect(a);
        const a2 = await hx.connect(a);
        const b1 = await hx.connect(b);
        a1.send({ action: 'invite', callId, lobbyName, callerId: a, targetUserIds: [b] });
        await hx.settle();
        await a2.close();
        await hx.settle();
        expect(actions(b1, callId)).toEqual(['invite']);
        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        expect(count(a1, callId, 'accepted')).toBe(1);
        await Promise.all([a1.close(), b1.close()]);
    });

    it('callee has two sockets: both ring, the first accept wins, the other is dismissed and refused', async () => {
        const { a, b, lobbyName, callId } = pair();
        const a1 = await hx.connect(a);
        const a2 = await hx.connect(a);
        const b1 = await hx.connect(b);
        const b2 = await hx.connect(b);
        a1.send({ action: 'invite', callId, lobbyName, callerId: a, targetUserIds: [b] });
        await hx.settle();
        expect(count(b1, callId, 'invite')).toBe(1);
        expect(count(b2, callId, 'invite')).toBe(1);

        b2.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        expect(count(a1, callId, 'accepted')).toBe(1);
        expect(count(a2, callId, 'accepted')).toBe(1);
        expect(count(b1, callId, 'accepted')).toBe(1); // dismisses b1's ring

        // b1 answers anyway (it had not seen the dismissal yet).
        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        const refusal = b1.frames.find((f) => f.action === 'ended' && f.data?.callId === callId);
        expect(refusal?.data).toMatchObject({ callId, reason: 'answered-elsewhere', userId: b, lobbyName });
        expect(count(a1, callId, 'accepted')).toBe(1);
        expect(count(a2, callId, 'accepted')).toBe(1);
        expect(count(b2, callId, 'ended')).toBe(0);
        expect(await status(lobbyName)).toMatchObject({ active: true, callId, participantCount: 2 });
        await Promise.all([a1.close(), a2.close(), b1.close(), b2.close()]);
    });

    it('callee\'s two sockets accept at the same moment: exactly one takes the call', async () => {
        const { a, b, lobbyName, callId } = pair();
        const a1 = await hx.connect(a);
        const b1 = await hx.connect(b);
        const b2 = await hx.connect(b);
        a1.send({ action: 'invite', callId, lobbyName, callerId: a, targetUserIds: [b] });
        await hx.settle();
        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        b2.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        expect(count(a1, callId, 'accepted')).toBe(1);
        const refused = [b1, b2].filter((c) => c.frames.some((f) => f.action === 'ended' && f.data?.reason === 'answered-elsewhere'));
        expect(refused).toHaveLength(1);
        expect(await status(lobbyName)).toMatchObject({ active: true, participantCount: 2 });
        await Promise.all([a1.close(), b1.close(), b2.close()]);
    });

    it('the refused socket does not keep the call alive, and the winner\'s hang-up ends it', async () => {
        const { a, b, lobbyName, callId } = pair();
        const a1 = await hx.connect(a);
        const b1 = await hx.connect(b);
        const b2 = await hx.connect(b);
        a1.send({ action: 'invite', callId, lobbyName, callerId: a, targetUserIds: [b] });
        await hx.settle();
        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        b2.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        b1.send({ action: 'user-status', callId, callerId: b, userId: b, lobbyName, status: 'left', reason: 'hung-up', targetUserIds: [a] });
        b1.send({ action: 'ended', callId, callerId: b, lobbyName, targetUserIds: [b] });
        await hx.settle();
        expect(await status(lobbyName)).toMatchObject({ active: false });
        await Promise.all([a1.close(), b1.close(), b2.close()]);
    });

    it('a socket of the callee that closed without its close handler running does not block the next one', async () => {
        const { a, b, lobbyName, callId } = pair();
        const a1 = await hx.connect(a);
        const b1 = await hx.connect(b);
        a1.send({ action: 'invite', callId, lobbyName, callerId: a, targetUserIds: [b] });
        await hx.settle();
        b1.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        // The refresh: b1 goes away, a fresh socket of b rejoins the call.
        await b1.close();
        const b2 = await hx.connect(b);
        b2.send({ action: 'accepted', callId, callerId: b, userId: b, targetUserIds: [a], lobbyName });
        await hx.settle();
        expect(b2.frames.some((f) => f.action === 'ended' && f.data?.reason === 'answered-elsewhere')).toBe(false);
        expect(count(a1, callId, 'accepted')).toBe(2);
        await Promise.all([a1.close(), b2.close()]);
    });
});
