// attachRealtime: a frame's sender fields are advisory once the connection is
// authenticated (aws-agentcore report against 0.98.4).
//
// Chat trusted `metadata.displayName` / `metadata.avatarUrl` from the frame
// ("sender-provided metadata wins"), so any socket could post, edit or react
// under somebody else's name while the gateway's WsAuthContext already knew
// `{ userId, displayName, org }` for the connection. Presence carried the
// frame's metadata verbatim, and reactions' metadata likewise.
//
// Everything here runs over real sockets. A connection with NO auth context
// (attachRealtime without `auth`) keeps the old behaviour.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, chat, presence, reactions, type RealtimeHandle } from '../../src/server';
import { InMemoryChatStore } from '../../src/chat/ChatStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const chan = () => `room-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

type Conn = { ws: WebSocket; frames: any[] };

function harness(opts: {
    withAuth: boolean;
    chatOpts?: Parameters<typeof chat>[0];
    presenceOpts?: Parameters<typeof presence>[0];
    reactionOpts?: Parameters<typeof reactions>[0];
}) {
    const h = {
        server: null as unknown as http.Server,
        handle: null as unknown as RealtimeHandle,
        port: 0,
        store: new InMemoryChatStore(),
        open: [] as WebSocket[],
    };
    beforeAll(async () => {
        h.server = http.createServer();
        h.handle = attachRealtime(h.server, {
            features: [
                chat({ chatStore: h.store, ...(opts.chatOpts ?? {}) }),
                presence({ heartbeatIntervalMs: 60_000, cleanupIntervalMs: 60_000, ...(opts.presenceOpts ?? {}) }),
                reactions(opts.reactionOpts ?? {}),
            ],
            path: '/realtime',
            ...(opts.withAuth
                ? {
                    auth: async (req: http.IncomingMessage) => {
                        const q = new URL(req.url ?? '', 'http://x').searchParams;
                        return { userId: q.get('sub') ?? '', displayName: q.get('name') ?? undefined, org: 'acme' };
                    },
                }
                : {}),
        } as any);
        await new Promise<void>((r) => h.server.listen(0, '127.0.0.1', () => r()));
        h.port = (h.server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const ws of h.open) try { ws.terminate(); } catch { /* */ }
        await h.handle.dispose();
        await new Promise<void>((r) => h.server.close(() => r()));
    });
    const connect = (sub = '', name = '') => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/realtime?sub=${sub}&name=${encodeURIComponent(name)}`);
        const conn: Conn = { ws, frames: [] };
        ws.on('message', (raw) => { try { conn.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', () => { h.open.push(ws); resolve(conn); });
        ws.on('error', reject);
    });
    const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify(frame));
    const waitFrame = async (c: Conn, match: (f: any) => boolean, timeoutMs = 2000) => {
        const start = Date.now();
        for (;;) {
            const f = c.frames.find(match);
            if (f) return f;
            if (Date.now() - start > timeoutMs) throw new Error('frame timeout');
            await sleep(10);
        }
    };
    const joinChat = async (c: Conn, channel: string) => {
        send(c, { service: 'chat', action: 'join', channel });
        await waitFrame(c, (f) => f.type === 'chat' && f.action === 'joined' && f.channel === channel);
    };
    const post = async (c: Conn, channel: string, extra: Record<string, unknown>) => {
        send(c, { service: 'chat', action: 'send', channel, message: 'hello', ...extra });
        return waitFrame(c, (f) => f.type === 'chat' && f.action === 'message' && f.channel === channel);
    };
    return { h, connect, send, waitFrame, joinChat, post };
}

describe('authenticated connections: the auth context names the sender, not the frame', () => {
    const t = harness({ withAuth: true });

    test('chat send: persisted and broadcast message carry the auth identity', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const bob = await t.connect('bob', 'Bob Real');
        await t.joinChat(alice, channel);
        await t.joinChat(bob, channel);

        const echo = await t.post(alice, channel, {
            userId: 'bob',
            displayName: 'Bob Real',
            metadata: { displayName: 'Bob Real', userId: 'bob', avatarUrl: 'https://evil/x.png', mentions: ['m'] },
        });
        const atBob = await t.waitFrame(bob, (f) => f.type === 'chat' && f.action === 'message' && f.channel === channel);

        for (const frame of [echo, atBob]) {
            expect(frame.message.userId).toBe('alice');
            expect(frame.message.metadata.displayName).toBe('Alice Real');
            expect(frame.message.metadata.userId).toBeUndefined();
            expect(frame.message.metadata.avatarUrl).toBeUndefined();
            expect(frame.message.metadata.mentions).toEqual(['m']); // non-identity metadata untouched
        }
        const [stored] = await t.h.store.listMessages(channel, 10);
        expect(stored.userId).toBe('alice');
        expect(stored.metadata?.displayName).toBe('Alice Real');
        expect(stored.metadata?.userId).toBeUndefined();
    });

    test('chat edit: only the auth userId may edit its own, and the edit cannot rename the author', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const mallory = await t.connect('mallory', 'Mallory');
        await t.joinChat(alice, channel);
        await t.joinChat(mallory, channel);
        const sent = await t.post(alice, channel, {});
        const messageId = sent.message.id;

        // Mallory claims to be alice in the frame: refused.
        t.send(mallory, { service: 'chat', action: 'edit', channel, messageId, message: 'pwned', userId: 'alice', metadata: { userId: 'alice' } });
        const refusal = await t.waitFrame(mallory, (f) => f.type === 'error' || f.error);
        expect(JSON.stringify(refusal)).toMatch(/forbidden|Only the author/);

        // Alice's own edit tries to rename her: the name stays the auth one.
        t.send(alice, { service: 'chat', action: 'edit', channel, messageId, message: 'edited', metadata: { displayName: 'CEO', avatarUrl: 'https://evil/y.png' } });
        const upd = await t.waitFrame(alice, (f) => f.type === 'chat' && f.action === 'messageUpdated');
        expect(upd.message.message).toBe('edited');
        expect(upd.message.userId).toBe('alice');
        expect(upd.message.metadata.displayName).toBe('Alice Real');
        expect(upd.message.metadata.avatarUrl).toBeUndefined();
        const [stored] = await t.h.store.listMessages(channel, 10);
        expect(stored.message).toBe('edited');
        expect(stored.metadata?.displayName).toBe('Alice Real');
    });

    test('chat delete: another user cannot delete by naming the author in the frame', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const mallory = await t.connect('mallory', 'Mallory');
        await t.joinChat(alice, channel);
        await t.joinChat(mallory, channel);
        const sent = await t.post(alice, channel, {});
        t.send(mallory, { service: 'chat', action: 'delete', channel, messageId: sent.message.id, userId: 'alice' });
        await t.waitFrame(mallory, (f) => f.type === 'error' || f.error);
        await sleep(50);
        expect(alice.frames.some((f) => f.action === 'messageDeleted')).toBe(false);
        const [stored] = await t.h.store.listMessages(channel, 10);
        expect(stored.deletedAt).toBeUndefined();

        t.send(alice, { service: 'chat', action: 'delete', channel, messageId: sent.message.id });
        await t.waitFrame(mallory, (f) => f.action === 'messageDeleted');
    });

    test('chat typing: relayed with the auth identity, frame fields ignored', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const bob = await t.connect('bob', 'Bob Real');
        await t.joinChat(alice, channel);
        await t.joinChat(bob, channel);
        t.send(alice, { service: 'chat', action: 'typing', channel, typing: true, userId: 'bob', displayName: 'Bob Real' });
        const typing = await t.waitFrame(bob, (f) => f.type === 'chat' && f.action === 'typing');
        expect(typing.userId).toBe('alice');
        expect(typing.displayName).toBe('Alice Real');
    });

    test('presence set: metadata identity comes from the auth context', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const bob = await t.connect('bob', 'Bob Real');
        t.send(bob, { service: 'presence', action: 'subscribe', channel });
        await t.waitFrame(bob, (f) => f.type === 'presence' && f.action === 'subscribed');
        t.send(alice, { service: 'presence', action: 'set', status: 'online', channels: [channel], metadata: { displayName: 'Bob Real', userId: 'bob', avatarUrl: 'https://evil/z.png', mood: 'ok' } });
        // (the connect-time `set` ack carries no channels; wait for ours)
        const ack = await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'set' && f.presence.channels.includes(channel));
        expect(ack.presence.userId).toBe('alice');
        expect(ack.presence.metadata.userId).toBe('alice');
        expect(ack.presence.metadata.displayName).toBe('Alice Real');
        expect(ack.presence.metadata.avatarUrl).toBeUndefined();
        expect(ack.presence.metadata.mood).toBe('ok');
        const seen = await t.waitFrame(bob, (f) => f.type === 'presence' && f.action !== 'subscribed' && JSON.stringify(f).includes('Alice Real'));
        expect(JSON.stringify(seen)).not.toContain('Bob Real');
    });

    test('reactions: the reaction names the auth sender, frame metadata identity dropped', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        const bob = await t.connect('bob', 'Bob Real');
        for (const c of [alice, bob]) {
            t.send(c, { service: 'reaction', action: 'subscribe', channel });
            await t.waitFrame(c, (f) => f.type === 'reaction' && f.action === 'reaction_subscribed');
        }
        t.send(alice, { service: 'reaction', action: 'send', channel, emoji: '❤️', userId: 'bob', displayName: 'Bob Real', metadata: { displayName: 'Bob Real', userId: 'bob', x: 1 } });
        const got = await t.waitFrame(bob, (f) => f.type === 'reaction' && f.action === 'reaction_received');
        expect(got.data.userId).toBe('alice');
        expect(got.data.displayName).toBe('Alice Real');
        expect(got.data.metadata.displayName).toBe('Alice Real');
        expect(got.data.metadata.userId).toBeUndefined();
        expect(got.data.metadata.x).toBe(1);
    });
});

describe('chat({ resolveSender }) maps the auth context', () => {
    const t = harness({
        withAuth: true,
        chatOpts: { resolveSender: (ctx) => ({ userId: `acme/${String(ctx.userId)}`, displayName: `${String(ctx.displayName)} (acme)` }) },
    });
    test('the resolver decides, the frame does not', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        await t.joinChat(alice, channel);
        const echo = await t.post(alice, channel, { metadata: { displayName: 'Nope' } });
        expect(echo.message.userId).toBe('acme/alice');
        expect(echo.message.metadata.displayName).toBe('Alice Real (acme)');
    });
});

describe('chat({ trustFrameSender: true }) keeps the old frame-wins behaviour', () => {
    const t = harness({ withAuth: true, chatOpts: { trustFrameSender: true } });
    test('frame displayName wins, userId still from auth', async () => {
        const channel = chan();
        const alice = await t.connect('alice', 'Alice Real');
        await t.joinChat(alice, channel);
        const echo = await t.post(alice, channel, { metadata: { displayName: 'Custom Name' } });
        expect(echo.message.userId).toBe('alice');
        expect(echo.message.metadata.displayName).toBe('Custom Name');
    });
});

describe('no auth context (attachRealtime without auth): today’s behaviour', () => {
    const t = harness({ withAuth: false });
    test('chat send keeps the frame metadata and stamps no userId', async () => {
        const channel = chan();
        const anon = await t.connect();
        await t.joinChat(anon, channel);
        const echo = await t.post(anon, channel, { metadata: { displayName: 'Guest 7', avatarUrl: 'a.png' } });
        expect(echo.message.userId).toBeUndefined();
        expect(echo.message.metadata.displayName).toBe('Guest 7');
        expect(echo.message.metadata.avatarUrl).toBe('a.png');
    });
    test('presence metadata passes through', async () => {
        const anon = await t.connect();
        const channel = chan();
        t.send(anon, { service: 'presence', action: 'set', status: 'online', channels: [channel], metadata: { displayName: 'Guest 7' } });
        const ack = await t.waitFrame(anon, (f) => f.type === 'presence' && f.action === 'set' && f.presence.channels.includes(channel));
        expect(ack.presence.metadata.displayName).toBe('Guest 7');
        expect(ack.presence.userId).toBeUndefined();
    });
    test('reaction metadata passes through', async () => {
        const channel = chan();
        const anon = await t.connect();
        t.send(anon, { service: 'reaction', action: 'subscribe', channel });
        await t.waitFrame(anon, (f) => f.action === 'reaction_subscribed');
        t.send(anon, { service: 'reaction', action: 'send', channel, emoji: '❤️', metadata: { displayName: 'Guest 7' } });
        const got = await t.waitFrame(anon, (f) => f.action === 'reaction_received');
        expect(got.data.metadata.displayName).toBe('Guest 7');
        expect(got.data.userId).toBeUndefined();
    });
});
