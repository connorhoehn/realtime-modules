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
    collabDocs,
    type RealtimeFeature,
    type RealtimeHandle,
} from '../../src/server';

const ALL_FEATURES: Array<[string, () => RealtimeFeature]> = [
    ['chat', () => chat()],
    ['presence', () => presence()],
    ['cursor', () => cursor()],
    ['reaction', () => reactions()],   // wire key 'reaction'; manifest identity 'reactions'
    ['activity', () => activity()],
    ['social', () => social()],
    ['call', () => calls()],
    ['ingest', () => ingest()],
    ['pipeline', () => pipeline()],    // wire key 'pipeline'; manifest identity 'pipeline-ws'
    ['typed-documents', () => typedDocuments()],
    ['room', () => rooms()],
    ['notification', () => notifications()],
    ['fileupload', () => fileUploads()],
    ['crdt', () => collabDocs()],   // wire key 'crdt'; manifest identity 'document-sharing'
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

    it('every PAIR of features composes without interference (91 pairs)', async () => {
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

    it('all fourteen features boot together', async () => {
        const { server, port, handle } = await boot(ALL_FEATURES.map(([, m]) => m()));
        expect(Object.keys(handle.services)).toHaveLength(14);
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

// Five presets used to take no arguments at all, so every tunable on the
// service behind them was unreachable through attachRealtime — the path the
// README and every recipe tell you to use. Cursor was the worst of them: its
// manifest advertises CURSOR_THROTTLE_INTERVAL_MS, CURSOR_TTL_MS and
// CURSOR_CLEANUP_INTERVAL_MS, nothing in src/cursor reads process.env, and the
// preset had no options either — so all three were settable by neither route.
// The wire name a client addresses and the manifest name a feature carries are
// not the same string, and where they differed nothing connected: useReactions
// sends `service: 'reaction'` while reactions() registered 'reactions', so
// every frame came back SERVICE_NOT_AVAILABLE. The end-to-end test above did
// not catch it because it sent 'reactions' too — the server validated against
// itself.
//
// This asserts the client's side of the contract instead. Each name below is
// what a hook in ./client actually puts on the wire; 'reaction', 'chat',
// 'presence', 'activity', 'crdt', 'fileupload' and 'subscribe' are also
// declared by @connorhoehn/event-catalog as canonical client frames.
describe('attachRealtime — every service a client addresses resolves', () => {
    const WIRE_NAMES: Array<[string, () => RealtimeFeature]> = [
        ['chat', () => chat()],
        ['presence', () => presence()],
        ['reaction', () => reactions()],
        ['activity', () => activity()],
        ['cursor', () => cursor()],
        ['fileupload', () => fileUploads()],
        ['notification', () => notifications()],
        ['crdt', () => collabDocs()],
        ['pipeline', () => pipeline()],
    ];

    it.each(WIRE_NAMES.map(([n]) => [n]))('a frame addressed to %s is routed, not refused', async (name) => {
        const make = WIRE_NAMES.find(([n]) => n === name)![1];
        const { server, port, handle } = await boot([make()]);
        const ws = await connect(port);

        ws.send(JSON.stringify({ service: name, action: '__no_such_action__', channel: 'probe' }));

        // The service must be REACHED. What it does with a nonsense action is
        // its own business — only SERVICE_NOT_AVAILABLE means the name missed.
        let refused = false;
        try {
            await nextFrame(
                ws,
                (f) => f.type === 'error' && f.code === 'SERVICE_NOT_AVAILABLE',
                600,
            );
            refused = true;
        } catch {
            // no such frame — the name resolved
        }
        expect(refused).toBe(false);

        ws.close();
        await teardown(server, handle);
    });

    // useVideoHangout sends `service: 'videohangout'`, event-catalog declares
    // it, and this package ships no such service — CallService speaks
    // `{ type: 'call', action: 'invite' | ... }`, a different vocabulary
    // entirely. Pinned so the day one appears, the docs that currently say
    // "none yet" get revisited.
    it('videohangout has no server half here, and calls() is not it', async () => {
        const { server, port, handle } = await boot([calls()]);
        expect(Object.keys(handle.services)).toEqual(['call']);

        const ws = await connect(port);
        ws.send(JSON.stringify({ service: 'videohangout', action: 'start', channel: 'room:1' }));
        const err = await nextFrame(ws, (f) => f.type === 'error');
        expect(err.code).toBe('SERVICE_NOT_AVAILABLE');

        ws.close();
        await teardown(server, handle);
    });
});

describe('attachRealtime — presets forward their service config', () => {
    it('cursor() passes throttle, TTL, sweep and custom modes through', async () => {
        const modes = {
            hex: { name: 'Hex grid', description: 'q/r axial', requiredFields: ['q', 'r'], optionalFields: [] },
        };
        const { server, handle } = await boot([
            cursor({ throttleInterval: 40, cursorTTL: 1234, cleanupInterval: 567, supportedModes: modes }),
        ]);

        const svc = handle.services.cursor as any;
        expect(svc.throttleInterval).toBe(40);
        expect(svc.cursorTTL).toBe(1234);
        expect(svc.cleanupInterval).toBe(567);
        // Replaces the built-in catalog rather than merging, per CursorConfig.
        expect(Object.keys(svc.supportedModes)).toEqual(['hex']);

        await teardown(server, handle);
    });

    it('cursor() with no argument keeps the documented defaults', async () => {
        const { server, handle } = await boot([cursor()]);
        const svc = handle.services.cursor as any;

        expect(svc.throttleInterval).toBe(250);
        expect(svc.cursorTTL).toBe(30_000);
        expect(svc.cleanupInterval).toBe(10_000);
        expect(Object.keys(svc.supportedModes).sort()).toEqual(['canvas', 'freeform', 'table', 'text']);

        await teardown(server, handle);
    });

    it('cursor() can refuse a channel at the service, not only at the router', async () => {
        const seen: string[] = [];
        const { server, handle } = await boot([
            cursor({ authorizeChannel: (_clientId, channel) => { seen.push(channel); return false; } }),
        ]);
        const svc = handle.services.cursor as any;

        await svc.handleAction('c-1', 'subscribe', { channel: 'room:secret' });

        expect(seen).toEqual(['room:secret']);
        await teardown(server, handle);
    });

    it.each([
        ['social', () => social({ maxChannelIdLength: 11 }), 'maxChannelIdLength', 11],
        ['ingest', () => ingest({ maxChannelLength: 12 }), 'maxChannelLength', 12],
        ['pipeline', () => pipeline({ maxChannelLength: 13 }), 'maxChannelLength', 13],
        ['typed-documents', () => typedDocuments({ maxDocumentIdLength: 14 }), 'maxDocumentIdLength', 14],
    ])('%s() forwards its config', async (name, make, field, value) => {
        const { server, handle } = await boot([(make as () => RealtimeFeature)()]);
        const svc = handle.services[name as string] as any;
        expect(svc[field as string]).toBe(value);
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

    it('chat: sent message carries userId end-to-end through attachRealtime (identityResolver defaults to router identity)', async () => {
        const { server, port, handle } = await boot([chat()], {
            auth: async () => ({ userId: 'user-42', displayName: 'Ada' }),
        });
        const a = await connect(port);

        a.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:general' }));
        await nextFrame(a, (f) => f.type === 'chat' && f.action === 'joined');

        const echoOnA = nextFrame(a, (f) => f.type === 'chat' && f.action === 'message');
        a.send(JSON.stringify({ service: 'chat', action: 'send', channel: 'chat:general', text: 'hello', message: 'hello' }));

        const onA = await echoOnA;
        expect(onA.message.userId).toBe('user-42');

        a.close();
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

    it('reactions: sent reaction carries userId end-to-end through attachRealtime (identityResolver defaults to router identity)', async () => {
        const { server, port, handle } = await boot([reactions()], {
            auth: async () => ({ userId: 'user-42', displayName: 'Ada' }),
        });
        const a = await connect(port);

        a.send(JSON.stringify({ service: 'reaction', action: 'subscribe', channel: 'general' }));
        await nextFrame(a, (f) => f.type === 'reaction' && f.action === 'reaction_subscribed');

        const received = nextFrame(a, (f) => f.type === 'reaction' && f.action === 'reaction_received');
        a.send(JSON.stringify({ service: 'reaction', action: 'send', channel: 'general', emoji: '❤️' }));

        const frame = await received;
        expect(frame.data.userId).toBe('user-42');

        a.close();
        await teardown(server, handle);
    });

    it('presence: authorizeChannel reaches PresenceService through attachRealtime', async () => {
        const { server, port, handle } = await boot([
            presence({
                authorizeChannel: (_clientId: string, channel: string) => channel !== 'forbidden',
            }),
        ]);
        const ws = await connect(port);

        // Allowed channel subscribes normally.
        ws.send(JSON.stringify({ service: 'presence', action: 'subscribe', channel: 'ok' }));
        await nextFrame(ws, (f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === 'ok');

        // Forbidden channel must NOT produce a subscribed ack.
        let subscribedForbidden = false;
        const watcher = nextFrame(ws, (f) => f.action === 'subscribed' && f.channel === 'forbidden', 700)
            .then(() => { subscribedForbidden = true; })
            .catch(() => undefined);
        ws.send(JSON.stringify({ service: 'presence', action: 'subscribe', channel: 'forbidden' }));
        await watcher;
        expect(subscribedForbidden).toBe(false);

        ws.close();
        await teardown(server, handle);
    });

    it('collab-docs: join a doc channel, receive sync frames, shutdown flushes on dispose', async () => {
        const { server, port, handle } = await boot([collabDocs()]);
        const ws = await connect(port);
        const sync = nextFrame(ws, (f) => f.type === 'crdt');
        ws.send(JSON.stringify({ service: 'crdt', action: 'subscribe', channel: 'doc:matrix-test' }));
        const first = await sync; // any crdt-typed frame proves routing via the 'crdt' wire key
        expect(first).toBeTruthy();
        ws.close();
        await teardown(server, handle); // exercises the shutdown() path (snapshot flush)
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
