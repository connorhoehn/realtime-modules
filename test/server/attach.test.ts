// attachRealtime — the à-la-carte composition matrix.
//
// The defining property of the pluggable layer: every feature works ALONE,
// in ANY PAIR, attached to an EXISTING http server that keeps serving its
// own routes. A whole-stack boot test cannot catch a coupling between two
// features or a feature that only works when its sibling initialised the
// router first — this matrix can.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
    attachRealtime,
    defineFeature,
    chat,
    presence,
    cursor,
    reactions,
    activity,
    social,
    calls,
    ingest,
    pipeline,
    typedDocuments,
    rooms,
    notifications,
    fileUploads,
    type RealtimeFeature,
    type RealtimeHandle,
} from '../../src/server';

const ALL_FEATURES: Array<[string, () => RealtimeFeature]> = [
    ['chat', () => chat()],
    ['presence', () => presence()],
    ['cursor', () => cursor()],
    ['reactions', () => reactions()],
    ['activity', () => activity()],
    ['social', () => social()],
    ['call', () => calls()],
    ['ingest', () => ingest()],
    ['pipeline-ws', () => pipeline()],
    ['typed-documents', () => typedDocuments()],
    ['room', () => rooms()],
    ['notification', () => notifications()],
    ['fileupload', () => fileUploads()],
];

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
}

function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function nextFrame(ws: WebSocket, match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        const onMsg = (raw: WebSocket.RawData) => {
            try {
                const frame = JSON.parse(String(raw));
                if (match(frame)) {
                    clearTimeout(timer);
                    ws.off('message', onMsg);
                    resolve(frame);
                }
            } catch { /* non-JSON frame — ignore */ }
        };
        ws.on('message', onMsg);
    });
}

async function boot(features: RealtimeFeature[], opts: Record<string, unknown> = {}): Promise<{
    server: http.Server; port: number; handle: RealtimeHandle;
}> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('existing-app-route');
    });
    const handle = attachRealtime(server, { features, path: '/realtime', ...opts } as any);
    const port = await listen(server);
    return { server, port, handle };
}

async function teardown(server: http.Server, handle: RealtimeHandle): Promise<void> {
    await handle.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('attachRealtime — à-la-carte matrix', () => {
    it.each(ALL_FEATURES.map(([name]) => [name]))('feature %s boots ALONE and accepts a connection', async (name) => {
        const make = ALL_FEATURES.find(([n]) => n === name)![1];
        const { server, port, handle } = await boot([make()]);
        expect(Object.keys(handle.services)).toEqual([name]);
        const ws = await connect(port);
        expect(handle.listClients()).toHaveLength(1);
        ws.close();
        await teardown(server, handle);
    });

    it('every PAIR of features composes without interference (78 pairs)', async () => {
        for (let i = 0; i < ALL_FEATURES.length; i++) {
            for (let j = i + 1; j < ALL_FEATURES.length; j++) {
                const [nameA, makeA] = ALL_FEATURES[i]!;
                const [nameB, makeB] = ALL_FEATURES[j]!;
                const { server, handle } = await boot([makeA(), makeB()]);
                expect(Object.keys(handle.services).sort()).toEqual([nameA, nameB].sort());
                await teardown(server, handle);
            }
        }
    }, 120_000);

    it('all thirteen features boot together', async () => {
        const { server, port, handle } = await boot(ALL_FEATURES.map(([, m]) => m()));
        expect(Object.keys(handle.services)).toHaveLength(13);
        const ws = await connect(port);
        ws.close();
        await teardown(server, handle);
    });

    it('attaching does not interfere with the host app\'s HTTP routes', async () => {
        const { server, port, handle } = await boot([chat()]);
        const body = await new Promise<string>((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/anything`, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
        expect(body).toBe('existing-app-route');
        await teardown(server, handle);
    });

    it('duplicate features are rejected loudly', async () => {
        const server = http.createServer();
        expect(() => attachRealtime(server, { features: [chat(), chat()] })).toThrow(/duplicate feature 'chat'/);
        server.close();
    });

    it('a defineFeature() third-party feature plugs in identically to built-ins', async () => {
        const seen: string[] = [];
        const scoreboard = defineFeature({
            manifest: { name: 'scoreboard', version: '1.0.0', envVars: {}, channels: ['score:*'] },
            create: ({ router }) => ({
                handleAction: async (clientId: string, action: string) => {
                    seen.push(action);
                    router.sendToClient(clientId, { type: 'scoreboard', action: 'ack' });
                },
            }),
        });
        const { server, port, handle } = await boot([chat(), scoreboard]);
        expect(Object.keys(handle.services).sort()).toEqual(['chat', 'scoreboard']);
        const ws = await connect(port);
        ws.send(JSON.stringify({ service: 'scoreboard', action: 'bump' }));
        const ack = await nextFrame(ws, (f) => f.type === 'scoreboard' && f.action === 'ack');
        expect(ack).toBeTruthy();
        expect(seen).toEqual(['bump']);
        ws.close();
        await teardown(server, handle);
    });
});

describe('attachRealtime — end-to-end behaviour on the local router', () => {
    it('chat: join + send round-trips with sender echo', async () => {
        const { server, port, handle } = await boot([chat()]);
        const a = await connect(port);
        const b = await connect(port);

        a.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:general' }));
        await nextFrame(a, (f) => f.type === 'chat' && f.action === 'joined');
        b.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:general' }));
        await nextFrame(b, (f) => f.type === 'chat' && f.action === 'joined');

        const gotOnB = nextFrame(b, (f) => f.type === 'chat' && f.action === 'message');
        const echoOnA = nextFrame(a, (f) => f.type === 'chat' && f.action === 'message');
        a.send(JSON.stringify({ service: 'chat', action: 'send', channel: 'chat:general', text: 'hello', message: 'hello' }));

        const [onB, onA] = await Promise.all([gotOnB, echoOnA]);
        expect(onB.message).toBeTruthy();
        expect(onA).toBeTruthy(); // sender echo — the M3 invariant
        a.close(); b.close();
        await teardown(server, handle);
    });

    it('authorize hook: denied subscribe produces NO joined ack (M3 gap #10)', async () => {
        const { server, port, handle } = await boot([chat()], {
            authorize: ({ kind, channel }: any) => !(kind === 'subscribe' && channel === 'chat:forbidden'),
        });
        const ws = await connect(port);

        // Allowed channel acks…
        ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:ok' }));
        await nextFrame(ws, (f) => f.type === 'chat' && f.action === 'joined');

        // …forbidden channel must NOT ack joined.
        let joinedForbidden = false;
        const watcher = nextFrame(ws, (f) => f.action === 'joined' && f.channel === 'chat:forbidden', 700)
            .then(() => { joinedForbidden = true; })
            .catch(() => undefined);
        ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:forbidden' }));
        await watcher;
        expect(joinedForbidden).toBe(false);

        ws.close();
        await teardown(server, handle);
    });

    it('identity flows from the auth callback into the router accessors', async () => {
        const { server, port, handle } = await boot([presence()], {
            auth: async () => ({ userId: 'user-42', displayName: 'Ada' }),
        });
        const ws = await connect(port);
        const [clientId] = handle.listClients();
        expect(clientId).toBeTruthy();
        const router: any = handle.router;
        expect(router.getUserIdForClient(clientId!)).toBe('user-42');
        expect(router.getClientData(clientId!)).toEqual({ userContext: { userId: 'user-42', displayName: 'Ada' } });
        expect(router.getClientsByUserId(['user-42'])).toEqual([{ clientId, userId: 'user-42' }]);
        ws.close();
        await teardown(server, handle);
    });

    it('dispose() detaches cleanly: HTTP keeps working, WS upgrades stop', async () => {
        const { server, port, handle } = await boot([chat()]);
        await handle.dispose();
        // HTTP path still alive after dispose.
        const body = await new Promise<string>((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/still-here`, (res) => {
                let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(data));
            }).on('error', reject);
        });
        expect(body).toBe('existing-app-route');
        // New WS upgrade must fail.
        await expect(connect(port)).rejects.toBeTruthy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
});
