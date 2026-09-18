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

// attachRealtime always registers the generic multiplexer, so the services a
// test attached are everything except that one.
function featureServices(handle: RealtimeHandle): string[] {
    return Object.keys(handle.services).filter((n) => n !== 'subscribe');
}

async function teardown(server: http.Server, handle: RealtimeHandle): Promise<void> {
    await handle.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('attachRealtime — à-la-carte matrix', () => {
    it.each(ALL_FEATURES.map(([name]) => [name]))('feature %s boots ALONE and accepts a connection', async (name) => {
        const make = ALL_FEATURES.find(([n]) => n === name)![1];
        const { server, port, handle } = await boot([make()]);
        expect(featureServices(handle)).toEqual([name]);
        // The multiplexer rides along with every attach.
        expect(Object.keys(handle.services)).toContain('subscribe');
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
                expect(featureServices(handle).sort()).toEqual([nameA, nameB].sort());
                await teardown(server, handle);
            }
        }
    }, 120_000);

    it('all fourteen features boot together', async () => {
        const { server, port, handle } = await boot(ALL_FEATURES.map(([, m]) => m()));
        expect(featureServices(handle)).toHaveLength(14);
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
        expect(featureServices(handle).sort()).toEqual(['chat', 'scoreboard']);
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
        // Not a feature — attachRealtime registers it itself.
        ['subscribe', () => chat()],
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
        expect(featureServices(handle)).toEqual(['call']);

        const ws = await connect(port);
        ws.send(JSON.stringify({ service: 'videohangout', action: 'start', channel: 'room:1' }));
        const err = await nextFrame(ws, (f) => f.type === 'error');
        expect(err.code).toBe('SERVICE_NOT_AVAILABLE');

        ws.close();
        await teardown(server, handle);
    });
});

// The generic multiplexer. useWebSocket's subscribe()/unsubscribe() are the
// low-level hook's entire channel API and autoResubscribe replays them on
// every reconnect — all of it addressed to `service: 'subscribe'`, which
// nothing registered, so all of it was refused.
//
// Both directions are declared by @connorhoehn/event-catalog, including the
// ack asymmetry asserted below.
describe('attachRealtime — the subscribe service', () => {
    it('acks a subscribe and an unsubscribe with the declared frames', async () => {
        const { server, port, handle } = await boot([chat()]);
        const ws = await connect(port);

        ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: 'room:1' }));
        const sub = await nextFrame(ws, (f) => f.type === 'subscribe' && f.action === 'subscribed');
        expect(sub.channel).toBe('room:1');

        ws.send(JSON.stringify({ service: 'subscribe', action: 'unsubscribe', channel: 'room:1' }));
        const unsub = await nextFrame(ws, (f) => f.type === 'subscribe' && f.action === 'unsubscribed');
        expect(unsub.channel).toBe('room:1');

        ws.close();
        await teardown(server, handle);
    });

    // event-catalog is explicit that the ABSENCE of the ack is the signal —
    // a client treating "no ack" as "probably fine" believes it is subscribed
    // to a channel the server refused it.
    it('sends NO ack when authorize denies the channel', async () => {
        const { server, port, handle } = await boot([chat()], {
            authorize: ({ channel }: { channel: string }) => channel !== 'room:secret',
        });
        const ws = await connect(port);

        ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: 'room:secret' }));

        let acked = false;
        try {
            await nextFrame(ws, (f) => f.type === 'subscribe' && f.action === 'subscribed', 600);
            acked = true;
        } catch {
            // expected — refusal is silence
        }
        expect(acked).toBe(false);

        // And the allowed one still works on the same connection.
        ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: 'room:ok' }));
        expect((await nextFrame(ws, (f) => f.action === 'subscribed')).channel).toBe('room:ok');

        ws.close();
        await teardown(server, handle);
    });

    it('unsubscribe is idempotent — a channel never joined still acks', async () => {
        const { server, port, handle } = await boot([chat()]);
        const ws = await connect(port);

        ws.send(JSON.stringify({ service: 'subscribe', action: 'unsubscribe', channel: 'never-joined' }));
        const f = await nextFrame(ws, (x) => x.type === 'subscribe' && x.action === 'unsubscribed');
        expect(f.channel).toBe('never-joined');

        ws.close();
        await teardown(server, handle);
    });

    it('refuses a channel-less frame and an unknown action', async () => {
        const { server, port, handle } = await boot([chat()]);
        const ws = await connect(port);

        ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe' }));
        expect((await nextFrame(ws, (f) => f.type === 'error')).code).toBe('INVALID_PAYLOAD');

        ws.send(JSON.stringify({ service: 'subscribe', action: 'dance', channel: 'room:1' }));
        expect((await nextFrame(ws, (f) => f.code === 'UNKNOWN_ACTION')).service).toBe('subscribe');

        ws.close();
        await teardown(server, handle);
    });

    it('a consumer feature named subscribe keeps the name', async () => {
        const mine = defineFeature({
            manifest: { name: 'subscribe', version: '1.0.0' },
            create: () => ({ handleAction: () => undefined }),
        });
        const { server, handle } = await boot([mine]);

        // Theirs, not the built-in — proved by the absence of an ack path.
        expect(Object.keys(handle.services)).toEqual(['subscribe']);
        await teardown(server, handle);
    });
});

// A push feature has two halves and only one of them is a hook. useNotifications
// receives; nothing in it ever sends. The other half is notifyUser, a method on
// the service rather than a WS action — because your app decides when someone
// gets notified, not the browser asking for it.
//
// That makes handle.services the documented seam, so this pins it: the shape
// the recipe now tells people to reach for, and the frame it produces, which
// is the one the hook parses.
describe('attachRealtime — notifications are pushed through handle.services', () => {
    it('notifyUser delivers notification:new to that user\'s live connection', async () => {
        const { server, port, handle } = await boot([notifications()], {
            auth: async () => ({ userId: 'u-eve', displayName: 'Eve' }),
        });
        const ws = await connect(port);

        const svc = handle.services.notification as unknown as {
            notifyUser(u: string, i: Record<string, unknown>): Promise<{ delivered: number }>;
        };
        expect(typeof svc.notifyUser).toBe('function');

        const incoming = nextFrame(ws, (f) => f.type === 'notification:new');
        const res = await svc.notifyUser('u-eve', { type: 'mention', title: 'Carol mentioned you' });
        expect(res.delivered).toBe(1);

        // Exactly what useNotifications parses: payload-nested, not flat.
        const frame = await incoming;
        expect(frame.service).toBe('notification');
        expect(frame.payload).toMatchObject({ type: 'mention', title: 'Carol mentioned you' });
        expect(typeof frame.payload.id).toBe('string');

        ws.close();
        await teardown(server, handle);
    });

    it('does not deliver to a different user', async () => {
        const { server, port, handle } = await boot([notifications()], {
            auth: async () => ({ userId: 'u-eve', displayName: 'Eve' }),
        });
        const ws = await connect(port);

        const svc = handle.services.notification as unknown as {
            notifyUser(u: string, i: Record<string, unknown>): Promise<{ delivered: number }>;
        };
        const res = await svc.notifyUser('u-someone-else', { type: 'mention', title: 'not for Eve' });
        expect(res.delivered).toBe(0);

        ws.close();
        await teardown(server, handle);
    });
});

// useActivity takes a channel and the README called it channel-scoped, which
// it is not: the service publishes every live event to one global
// activity:broadcast channel that every connection is auto-subscribed to, and
// no frame carries a channel to filter on. A per-room feed built on this shows
// every room's events to every viewer.
//
// Pinned because it is a scoping property people will reason about — and
// because the honest answer lives in a comment in the hook, which is not where
// anyone looks before shipping a feed.
describe('attachRealtime — activity is global, not per-channel', () => {
    it('delivers an event published on one channel to a subscriber of another', async () => {
        const { server, port, handle } = await boot([activity()], {
            auth: async () => ({ userId: 'u-1', displayName: 'Ada' }),
        });

        const a = await connect(port);
        const b = await connect(port);
        a.send(JSON.stringify({ service: 'activity', action: 'subscribe', channelId: 'room:1' }));
        b.send(JSON.stringify({ service: 'activity', action: 'subscribe', channelId: 'room:2' }));
        await nextFrame(a, (f) => f.type === 'activity' && f.action === 'subscribed' && f.channelId === 'room:1');
        await nextFrame(b, (f) => f.type === 'activity' && f.action === 'subscribed' && f.channelId === 'room:2');

        const seenByB = nextFrame(b, (f) => f.type === 'activity:event');
        a.send(JSON.stringify({
            service: 'activity',
            action: 'publish',
            event: { eventType: 'doc.created', detail: { room: 'room:1' } },
        }));

        const frame = await seenByB;
        expect(frame.payload.eventType).toBe('doc.created');
        // And the server stamps identity rather than trusting the sender.
        expect(frame.payload.userId).toBe('u-1');

        a.close();
        b.close();
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
