// calls({ allowUntargetedInvites }) — an invite with no targets is broadcast
// to every connected socket, every tenant's. attachRealtime refuses it by
// default (aws-agentcore report against 0.98.3); room walk-ins still work.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Conn = { ws: WebSocket; frames: any[] };

async function start(opts: Parameters<typeof calls>[0]) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [calls(opts)],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => {
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            return { userId: q.get('sub') ?? '', org: q.get('org') ?? '' };
        },
    } as any);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const conns: Conn[] = [];
    const connect = (sub: string, org: string) => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}&org=${org}`);
        const c: Conn = { ws, frames: [] };
        ws.on('message', (raw) => { try { c.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', () => { conns.push(c); resolve(c); });
        ws.on('error', reject);
    });
    const stop = async () => {
        for (const c of conns) c.ws.terminate();
        await handle.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    };
    return { connect, stop };
}

const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify({ service: 'call', ...frame }));
const invitesTo = (c: Conn, callId: string) => c.frames.filter((f) => f.type === 'call' && f.action === 'invite' && f.data?.callId === callId);

describe('calls() — untargeted invites', () => {
    it('refuses a targetless invite by default: a structured error to the sender, nothing to anyone else, no call registered', async () => {
        const srv = await start({});
        try {
            const alice = await srv.connect('u-alice', 'acme');
            const bob = await srv.connect('u-bob', 'acme');
            const mallory = await srv.connect('u-mallory', 'globex');
            send(alice, { action: 'invite', callId: 'c-open', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-alice' });
            send(alice, { action: 'invite', callId: 'c-empty', lobbyName: 'acme:lobby', callerId: 'u-alice', targetUserIds: [] });
            await sleep(100);
            const errors = alice.frames.filter((f) => f.type === 'error');
            expect(errors).toHaveLength(2);
            expect(errors[0]).toMatchObject({
                type: 'error', service: 'call', code: 'untargeted-invite',
                action: 'invite', callId: 'c-open', lobbyName: 'acme:dm:u-alice:u-bob',
            });
            expect(String(errors[0].message)).toMatch(/targetUserIds/);
            expect(errors[1]).toMatchObject({ code: 'untargeted-invite', callId: 'c-empty' });
            expect(invitesTo(bob, 'c-open')).toHaveLength(0);
            expect(invitesTo(mallory, 'c-open')).toHaveLength(0);
            expect(invitesTo(mallory, 'c-empty')).toHaveLength(0);

            send(bob, { action: 'status', lobbyName: 'acme:dm:u-alice:u-bob' });
            await sleep(50);
            expect(bob.frames.find((f) => f.action === 'active-call')?.data).toEqual({ lobbyName: 'acme:dm:u-alice:u-bob', active: false });

            // A targeted invite is untouched.
            send(alice, { action: 'invite', callId: 'c-ok', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-alice', targetUserIds: ['u-bob'] });
            await sleep(50);
            expect(invitesTo(bob, 'c-ok')).toHaveLength(1);
            expect(invitesTo(mallory, 'c-ok')).toHaveLength(0);
        } finally { await srv.stop(); }
    });

    it('lets a room walk-in through (bare and tenant-prefixed room lobbies)', async () => {
        const srv = await start({});
        try {
            const alice = await srv.connect('u-alice', 'acme');
            const bob = await srv.connect('u-bob', 'acme');
            send(alice, { action: 'invite', callId: 'c-room', lobbyName: 'room:design', callerId: 'u-alice' });
            send(alice, { action: 'invite', callId: 'c-room2', lobbyName: 'acme:room:design', callerId: 'u-alice' });
            await sleep(100);
            expect(alice.frames.filter((f) => f.type === 'error')).toHaveLength(0);
            send(bob, { action: 'status', lobbyName: 'acme:room:design' });
            await sleep(50);
            expect(bob.frames.find((f) => f.action === 'active-call')?.data).toMatchObject({ active: true, callId: 'c-room2' });
        } finally { await srv.stop(); }
    });

    it('allowUntargetedInvites: true restores the broadcast', async () => {
        const srv = await start({ allowUntargetedInvites: true });
        try {
            const alice = await srv.connect('u-alice', 'acme');
            const bob = await srv.connect('u-bob', 'acme');
            send(alice, { action: 'invite', callId: 'c-open', lobbyName: 'acme:lobby', callerId: 'u-alice' });
            await sleep(100);
            expect(alice.frames.filter((f) => f.type === 'error')).toHaveLength(0);
            expect(invitesTo(bob, 'c-open')).toHaveLength(1);
        } finally { await srv.stop(); }
    });
});
