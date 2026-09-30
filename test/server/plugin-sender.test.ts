// 0.99.0: FeaturePlugin.onMessage / onConnect carry `userId` — the
// authenticated user behind the publishing connection, from its auth context
// — so a plugin does not read a chat-shaped `metadata.userId` out of the
// payload, and presence / reaction publishes name their sender too. A
// server-originated publish (a system message) and an unauthenticated socket
// get `undefined`.
//
// Also 0.99.0: ReactionService's `onReaction` tap receives the sender's
// auth-context `org` (the gateway's call:reaction.recorded files by it); the
// broadcast reaction does not carry it.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, chat, presence, reactions, type FeaturePlugin, type RealtimeHandle } from '../../src/server';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const chan = () => `room-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

type Conn = { ws: WebSocket; frames: any[] };

const seen: Array<{ hook: string; clientId: string; channelId: string; userId?: string; message?: any }> = [];
const tapped: any[] = [];
const plugin: FeaturePlugin = {
    name: 'observer',
    onConnect: (info) => { seen.push({ hook: 'connect', ...info }); },
    onMessage: (info) => { seen.push({ hook: 'message', ...info }); },
};

let server: http.Server;
let handle: RealtimeHandle;
let port = 0;
const open: WebSocket[] = [];

beforeAll(async () => {
    server = http.createServer();
    handle = attachRealtime(server, {
        features: [
            chat(),
            presence({ heartbeatIntervalMs: 60_000, cleanupIntervalMs: 60_000 }),
            reactions({ onReaction: (r) => { tapped.push(r); } }),
        ],
        plugins: [plugin],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => {
            const sub = new URL(req.url ?? '', 'http://x').searchParams.get('sub');
            // No sub: an authenticated-but-anonymous connection (no userId).
            return sub ? { userId: sub, displayName: sub.toUpperCase(), org: 'acme' } : {};
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

const connect = (sub = '') => new Promise<Conn>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime${sub ? `?sub=${sub}` : ''}`);
    const conn: Conn = { ws, frames: [] };
    ws.on('message', (raw) => { try { conn.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
    ws.on('open', () => { open.push(ws); resolve(conn); });
    ws.on('error', reject);
});
const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify(frame));
const waitFor = async <T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> => {
    const start = Date.now();
    for (;;) {
        const v = fn();
        if (v !== undefined) return v;
        if (Date.now() - start > timeoutMs) throw new Error('timeout');
        await sleep(10);
    }
};
const messageOn = (channelId: string, pred: (m: any) => boolean = () => true) =>
    waitFor(() => seen.find((s) => s.hook === 'message' && s.channelId === channelId && pred(s.message)));

describe('FeaturePlugin sees the authenticated sender', () => {
    test('chat send: onMessage.userId is the auth user; onConnect carries it too', async () => {
        const channel = chan();
        const alice = await connect('alice');
        send(alice, { service: 'chat', action: 'join', channel });
        const connected = await waitFor(() => seen.find((s) => s.hook === 'connect' && s.channelId === channel));
        expect(connected.userId).toBe('alice');
        // A forged frame identity changes nothing: the router asks the auth context.
        send(alice, { service: 'chat', action: 'send', channel, message: 'hi', userId: 'mallory', metadata: { userId: 'mallory' } });
        const got = await messageOn(channel, (m) => m?.action === 'message');
        expect(got.userId).toBe('alice');
        expect(got.clientId).not.toBe('server');
    });

    test('presence set: onMessage.userId is the auth user', async () => {
        const channel = chan();
        const bob = await connect('bob');
        send(bob, { service: 'presence', action: 'set', status: 'online', channels: [channel] });
        const got = await messageOn(`presence:${channel}`, (m) => m?.type === 'presence' && m?.action === 'update');
        expect(got.userId).toBe('bob');
    });

    test('reaction send: onMessage.userId is the auth user, and onReaction gets the org the broadcast does not', async () => {
        const channel = chan();
        const carol = await connect('carol');
        send(carol, { service: 'reaction', action: 'subscribe', channel });
        await waitFor(() => carol.frames.find((f) => f.type === 'reaction' && f.action === 'reaction_subscribed'));
        send(carol, { service: 'reaction', action: 'send', channel, emoji: '❤️' });
        const got = await messageOn(`reactions:${channel}`, (m) => m?.action === 'reaction_received');
        expect(got.userId).toBe('carol');
        expect(got.message.data.org).toBeUndefined();
        const received = await waitFor(() => carol.frames.find((f) => f.type === 'reaction' && f.action === 'reaction_received'));
        expect(received.data.org).toBeUndefined();
        const tap = await waitFor(() => tapped.find((r) => r.channel === channel));
        expect(tap).toMatchObject({ userId: 'carol', org: 'acme', emoji: '❤️' });
    });

    test('a server post: onMessage.userId is undefined and clientId is "server"', async () => {
        const channel = chan();
        const svc: any = handle.services.chat;
        await svc.postSystemMessage(channel, 'Dave created Plan', { kind: 'document' });
        const got = await messageOn(channel, (m) => m?.message?.clientId === 'system');
        expect(got.clientId).toBe('server');
        expect(got.userId).toBeUndefined();
    });

    test('an unauthenticated socket: onMessage.userId is undefined', async () => {
        const channel = chan();
        const anon = await connect();
        send(anon, { service: 'presence', action: 'set', status: 'online', channels: [channel] });
        const got = await messageOn(`presence:${channel}`, (m) => m?.type === 'presence');
        expect(got.userId).toBeUndefined();
        expect(got.clientId).not.toBe('server');
    });
});
