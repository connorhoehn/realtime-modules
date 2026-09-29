// calls({ lobbyGuard }) — a tenant-scoped host refuses lobbies outside the
// sender's org, from the gateway auth result, before any routing.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';

function nextFrame(ws: WebSocket, match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('frame timeout')); }, timeoutMs);
        const onMsg = (raw: WebSocket.RawData) => {
            try {
                const f = JSON.parse(String(raw));
                if (match(f)) { clearTimeout(timer); ws.off('message', onMsg); resolve(f); }
            } catch { /* */ }
        };
        ws.on('message', onMsg);
    });
}

describe('calls({ lobbyGuard })', () => {
    let server: http.Server;
    let handle: RealtimeHandle;
    let port: number;
    const seen: Array<[unknown, string]> = [];

    beforeAll(async () => {
        server = http.createServer();
        handle = attachRealtime(server, {
            features: [calls({ lobbyGuard: (auth, lobby) => { seen.push([auth, lobby]); return lobby.startsWith(`${String(auth.org)}:`); } })],
            path: '/realtime',
            auth: async (req: http.IncomingMessage) => {
                const q = new URL(req.url ?? '', 'http://x').searchParams;
                return { userId: q.get('sub') ?? '', displayName: q.get('name') ?? '', org: q.get('org') ?? '' };
            },
        } as any);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        await handle.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });

    const connect = (sub: string, org: string) => new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}&org=${org}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });

    it('delivers a ring in your org and refuses one outside it', async () => {
        const alice = await connect('u-alice', 'acme');
        const bob = await connect('u-bob', 'acme');
        const ring = nextFrame(bob, (f) => f.type === 'call' && f.action === 'invite');
        alice.send(JSON.stringify({ service: 'call', action: 'invite', callId: 'c1', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-alice', targetUserIds: ['u-bob'] }));
        expect((await ring).data).toMatchObject({ callId: 'c1', lobbyName: 'acme:dm:u-alice:u-bob' });
        expect(seen[0]![0]).toMatchObject({ userId: 'u-alice', org: 'acme' });

        const refused = nextFrame(alice, (f) => f.type === 'error');
        alice.send(JSON.stringify({ service: 'call', action: 'invite', callId: 'c2', lobbyName: 'globex:dm:u-alice:u-bob', callerId: 'u-alice', targetUserIds: ['u-bob'] }));
        expect(String((await refused).message)).toMatch(/Not authorized/);
        // Nested envelopes are guarded too.
        const refused2 = nextFrame(alice, (f) => f.type === 'error');
        alice.send(JSON.stringify({ service: 'call', action: 'status', data: { lobbyName: 'globex:dm:x:y' } }));
        expect(String((await refused2).message)).toMatch(/Not authorized/);
        alice.close();
        bob.close();
    });
});
