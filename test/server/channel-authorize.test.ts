// attachRealtime `authorize` (ChannelAuthorize) is enforced by every service,
// not just by the router's fan-out (aws-agentcore report against 0.98.5).
//
// With a tenant-scoping `authorize`, an outsider's presence subscribe was
// refused by the router, yet PresenceService still sent it the channel's
// roster; its presence `set` wrote it into the other tenant's roster and fanned
// out, because the broadcast never named a publisher. Reactions and cursor had
// the same shape under their own prefixes, and chat's read paths (history,
// members) never asked the router at all.
//
// Everything here runs over real sockets.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
    attachRealtime,
    chat,
    cursor,
    presence,
    reactions,
    splitServiceChannel,
    type ChannelAuthorize,
    type RealtimeHandle,
} from '../../src/server';
import type { ReactionStore, StoredReaction } from '../../src/reactions/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
/** A channel owned by tenant `acme`. */
const acmeChan = () => `acme:r${++seq}${Math.random().toString(36).slice(2, 6)}`;

type Conn = { ws: WebSocket; frames: any[]; clientId?: string };

class MemReactionStore implements ReactionStore {
    rows: StoredReaction[] = [];
    async add(r: StoredReaction) { this.rows.push(r); }
    async remove(k: { channel: string; targetId: string; emoji: string; userId: string }) {
        this.rows = this.rows.filter((r) => !(r.channel === k.channel && r.targetId === k.targetId && r.emoji === k.emoji && r.userId === k.userId));
    }
    async list(channel: string) { return this.rows.filter((r) => r.channel === channel); }
}

// The tenant rule every consumer writes: strip the service prefix, then
// compare the tenant prefix with the connection's org.
const tenantRule: ChannelAuthorize = ({ channel, ctx }) => {
    const base = splitServiceChannel(channel).channel;
    return !!ctx && typeof ctx.org === 'string' && base.startsWith(`${ctx.org}:`);
};

function harness(opts: { presenceOpts?: Parameters<typeof presence>[0]; authorize?: ChannelAuthorize } = {}) {
    const calls: Array<{ kind: string; channel: string; userId?: unknown }> = [];
    const h = {
        server: null as unknown as http.Server,
        handle: null as unknown as RealtimeHandle,
        port: 0,
        reactionStore: new MemReactionStore(),
        calls,
        open: [] as WebSocket[],
    };
    beforeAll(async () => {
        h.server = http.createServer();
        const rule = opts.authorize ?? tenantRule;
        h.handle = attachRealtime(h.server, {
            features: [
                chat(),
                presence({ heartbeatIntervalMs: 60_000, cleanupIntervalMs: 60_000, ...(opts.presenceOpts ?? {}) }),
                reactions({ store: h.reactionStore }),
                cursor({ throttleInterval: 0 }),
            ],
            path: '/realtime',
            auth: async (req: http.IncomingMessage) => {
                const q = new URL(req.url ?? '', 'http://x').searchParams;
                return { userId: q.get('sub') ?? '', org: q.get('org') ?? '' };
            },
            authorize: (args) => {
                calls.push({ kind: args.kind, channel: args.channel, userId: args.ctx?.userId });
                return rule(args);
            },
        });
        await new Promise<void>((r) => h.server.listen(0, '127.0.0.1', () => r()));
        h.port = (h.server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const ws of h.open) try { ws.terminate(); } catch { /* */ }
        await h.handle.dispose();
        await new Promise<void>((r) => h.server.close(() => r()));
    });
    const connect = (sub: string, org: string) => new Promise<Conn>((resolve, reject) => {
        const before = new Set(h.handle.listClients());
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/realtime?sub=${sub}&org=${org}`);
        const conn: Conn = { ws, frames: [] };
        ws.on('message', (raw) => { try { conn.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', async () => {
            h.open.push(ws);
            for (let i = 0; i < 50 && !conn.clientId; i++) {
                conn.clientId = h.handle.listClients().find((id) => !before.has(id));
                if (!conn.clientId) await sleep(5);
            }
            resolve(conn);
        });
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
    /** Resolves after a quiet period; the caller then asserts absence. */
    const settle = () => sleep(250);
    const denied = (service: string, channel: string, kind: 'subscribe' | 'publish') => (f: any) =>
        f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED' && f.service === service && f.channel === channel && f.kind === kind;
    const members = (routerChannel: string): Set<string> =>
        ((h.handle.router as any).channelMembers.get(routerChannel) as Set<string> | undefined) ?? new Set();
    return { h, connect, send, waitFrame, settle, denied, members };
}

describe('authorize: presence', () => {
    const t = harness();

    test('an outsider subscribe is refused: error frame, no roster, no membership, no later updates', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const bob = await t.connect('bob', 'evil');

        t.send(alice, { service: 'presence', action: 'subscribe', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === X);
        t.send(alice, { service: 'presence', action: 'set', status: 'online', channels: [X] });
        await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'set');

        t.send(bob, { service: 'presence', action: 'subscribe', channel: X });
        const err = await t.waitFrame(bob, t.denied('presence', X, 'subscribe'));
        expect(err.error).toMatchObject({ code: 'AUTHZ_CHANNEL_DENIED' });
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'presence' && f.action === 'subscribed')).toBeUndefined();
        expect(t.members(`presence:${X}`).has(bob.clientId!)).toBe(false);
        expect(t.members(`presence:${X}`).has(alice.clientId!)).toBe(true);

        // A later roster change never reaches the refused socket.
        t.send(alice, { service: 'presence', action: 'set', status: 'away', channels: [X] });
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'presence' && f.action === 'update')).toBeUndefined();

        // Nor does `get` hand the roster over.
        t.send(bob, { service: 'presence', action: 'get', channel: X });
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'presence' && f.action === 'presence')).toBeUndefined();
        expect(bob.frames.filter(t.denied('presence', X, 'subscribe')).length).toBe(2);
    });

    test('an outsider set/leave never enters the roster or reaches subscribers', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const bob = await t.connect('bob', 'evil');
        t.send(alice, { service: 'presence', action: 'subscribe', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === X);

        t.send(bob, { service: 'presence', action: 'set', status: 'busy', channels: [X] });
        await t.waitFrame(bob, t.denied('presence', X, 'publish'));
        // The set itself still applies to Bob's own status, minus the channel.
        const ack = await t.waitFrame(bob, (f) => f.type === 'presence' && f.action === 'set' && f.presence.status === 'busy');
        expect(ack.presence.channels).toEqual([]);

        // leave (set without the channel) and disconnect
        t.send(bob, { service: 'presence', action: 'set', status: 'online', channels: [] });
        await t.settle();
        bob.ws.close();
        await t.settle();

        const fromBob = alice.frames.filter((f) => f.type === 'presence' && (f.presence?.clientId === bob.clientId || f.clientId === bob.clientId));
        expect(fromBob).toEqual([]);
        const svc: any = t.h.handle.services.presence;
        expect(svc.getChannelPresence(X).map((e: any) => e.clientId)).not.toContain(bob.clientId);

        // Alice's roster, fetched fresh, does not name Bob.
        t.send(alice, { service: 'presence', action: 'get', channel: X });
        const roster = await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'presence');
        expect(roster.data.map((e: any) => e.userId)).not.toContain('bob');
    });

    test('a permitted user is unaffected and every check names the service channel', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const carol = await t.connect('carol', 'acme');
        t.send(alice, { service: 'presence', action: 'subscribe', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === X);
        t.send(carol, { service: 'presence', action: 'set', status: 'online', channels: [X] });
        const upd = await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'update' && f.presence.userId === 'carol');
        expect(upd.presence.channels).toEqual([X]);
        expect(carol.frames.find((f) => f.type === 'error')).toBeUndefined();
        expect(t.h.calls).toEqual(expect.arrayContaining([
            { kind: 'subscribe', channel: `presence:${X}`, userId: 'alice' },
            { kind: 'publish', channel: `presence:${X}`, userId: 'carol' },
        ]));
    });
});

describe('authorize: presence({ authorizeChannel }) composes with authorize', () => {
    const seen: string[] = [];
    const t = harness({
        presenceOpts: {
            authorizeChannel: (_clientId, channel) => { seen.push(channel); return !channel.endsWith(':vip'); },
        },
    });

    test('both must pass, on subscribe and on set', async () => {
        const alice = await t.connect('alice', 'acme');
        // authorize allows, authorizeChannel refuses
        t.send(alice, { service: 'presence', action: 'subscribe', channel: 'acme:vip' });
        t.send(alice, { service: 'presence', action: 'set', status: 'busy', channels: ['acme:vip', 'acme:lobby'] });
        const ack = await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'set' && f.presence.status === 'busy');
        expect(ack.presence.channels).toEqual(['acme:lobby']);
        // authorizeChannel allows, authorize refuses
        t.send(alice, { service: 'presence', action: 'subscribe', channel: 'evil:lobby' });
        await t.waitFrame(alice, t.denied('presence', 'evil:lobby', 'subscribe'));
        // both allow
        t.send(alice, { service: 'presence', action: 'subscribe', channel: 'acme:lobby' });
        await t.waitFrame(alice, (f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === 'acme:lobby');
        await t.settle();
        expect(alice.frames.find((f) => f.type === 'presence' && f.action === 'subscribed' && f.channel === 'acme:vip')).toBeUndefined();
        expect(t.members('presence:acme:vip').size).toBe(0);
        expect(seen).toEqual(expect.arrayContaining(['acme:vip', 'acme:lobby']));
    });
});

describe('authorize: reactions', () => {
    const t = harness();

    test('outsider subscribe refused; add/remove never fan out or touch the store; insiders unaffected', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const bob = await t.connect('bob', 'evil');
        t.h.reactionStore.rows.push({ channel: X, targetId: 'm1', emoji: '👍', userId: 'alice', timestamp: new Date().toISOString() });

        t.send(alice, { service: 'reaction', action: 'subscribe', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'reaction' && f.action === 'reaction_subscribed');

        t.send(bob, { service: 'reaction', action: 'subscribe', channel: X });
        await t.waitFrame(bob, t.denied('reaction', X, 'subscribe'));
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'reaction' && (f.action === 'reaction_subscribed' || f.action === 'reaction_history'))).toBeUndefined();
        expect(t.members(`reactions:${X}`).has(bob.clientId!)).toBe(false);
        expect((t.h.handle.services.reaction as any).clientChannels.clientsSubscribedTo(X)).not.toContain(bob.clientId);

        t.send(bob, { service: 'reaction', action: 'send', channel: X, emoji: '👍', targetId: 'm1' });
        await t.waitFrame(bob, t.denied('reaction', X, 'publish'));
        t.send(bob, { service: 'reaction', action: 'remove', channel: X, emoji: '👍', targetId: 'm1' });
        await t.settle();
        expect(bob.frames.filter(t.denied('reaction', X, 'publish')).length).toBe(2);
        expect(alice.frames.find((f) => f.action === 'reaction_received' || f.action === 'reaction_removed')).toBeUndefined();
        expect(t.h.reactionStore.rows.filter((r) => r.userId === 'bob')).toEqual([]);
        expect(bob.frames.find((f) => f.action === 'reaction_sent')).toBeUndefined();

        // insider
        t.send(alice, { service: 'reaction', action: 'send', channel: X, emoji: '🎉' });
        await t.waitFrame(alice, (f) => f.action === 'reaction_received' && f.data.emoji === '🎉');
    });
});

describe('authorize: cursor', () => {
    const t = harness();

    test('outsider subscribe refused; update never fans out; get refused; insiders unaffected', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const carol = await t.connect('carol', 'acme');
        const bob = await t.connect('bob', 'evil');
        t.send(alice, { service: 'cursor', action: 'subscribe', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'cursor' && f.action === 'subscribed');
        t.send(carol, { service: 'cursor', action: 'update', channel: X, position: { x: 1, y: 2 } });
        await t.waitFrame(alice, (f) => f.type === 'cursor' && f.action === 'update' && f.cursor.clientId === carol.clientId);

        t.send(bob, { service: 'cursor', action: 'subscribe', channel: X });
        await t.waitFrame(bob, t.denied('cursor', X, 'subscribe'));
        t.send(bob, { service: 'cursor', action: 'get', channel: X });
        t.send(bob, { service: 'cursor', action: 'update', channel: X, position: { x: 9, y: 9 } });
        await t.waitFrame(bob, t.denied('cursor', X, 'publish'));
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'cursor' && (f.action === 'subscribed' || f.action === 'cursors'))).toBeUndefined();
        expect(t.members(`cursor:${X}`).has(bob.clientId!)).toBe(false);
        expect(alice.frames.find((f) => f.type === 'cursor' && f.cursor?.clientId === bob.clientId)).toBeUndefined();
        const svc: any = t.h.handle.services.cursor;
        expect(svc.getLocalChannelCursors(X).map((c: any) => c.clientId)).not.toContain(bob.clientId);
    });
});

describe('authorize: chat', () => {
    const t = harness();

    test('outsider join refused with the error frame; send, history and members refused; insiders unaffected', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const bob = await t.connect('bob', 'evil');
        t.send(alice, { service: 'chat', action: 'join', channel: X });
        await t.waitFrame(alice, (f) => f.type === 'chat' && f.action === 'joined');
        t.send(alice, { service: 'chat', action: 'send', channel: X, message: 'secret plans' });
        await t.waitFrame(alice, (f) => f.type === 'chat' && f.action === 'message');

        t.send(bob, { service: 'chat', action: 'join', channel: X });
        await t.waitFrame(bob, t.denied('chat', X, 'subscribe'));
        t.send(bob, { service: 'chat', action: 'history', channel: X });
        t.send(bob, { service: 'chat', action: 'members', channel: X });
        t.send(bob, { service: 'chat', action: 'send', channel: X, message: 'hi' });
        await t.settle();
        expect(bob.frames.find((f) => f.type === 'chat' && ['joined', 'history', 'members', 'message'].includes(f.action))).toBeUndefined();
        expect(JSON.stringify(bob.frames)).not.toContain('secret plans');
        expect(alice.frames.filter((f) => f.type === 'chat' && f.action === 'message').length).toBe(1);
        expect(t.h.calls).toEqual(expect.arrayContaining([{ kind: 'subscribe', channel: X, userId: 'alice' }]));
    });
});

describe('authorize: publish-only refusal', () => {
    // Announcement channels: every tenant member subscribes, only `alice` publishes.
    const t = harness({
        authorize: (args) => tenantRule(args) && (args.kind === 'subscribe' || args.ctx?.userId === 'alice'),
    });

    test('chat send by a subscriber without publish rights is refused before it is stored', async () => {
        const X = acmeChan();
        const alice = await t.connect('alice', 'acme');
        const dave = await t.connect('dave', 'acme');
        for (const c of [alice, dave]) {
            t.send(c, { service: 'chat', action: 'join', channel: X });
            await t.waitFrame(c, (f) => f.type === 'chat' && f.action === 'joined');
        }
        t.send(dave, { service: 'chat', action: 'send', channel: X, message: 'not allowed' });
        await t.waitFrame(dave, t.denied('chat', X, 'publish'));
        t.send(dave, { service: 'chat', action: 'history', channel: X });
        const hist = await t.waitFrame(dave, (f) => f.type === 'chat' && f.action === 'history');
        expect(hist.messages).toEqual([]);
        expect(dave.frames.find((f) => f.type === 'chat' && f.action === 'sent')).toBeUndefined();

        t.send(alice, { service: 'chat', action: 'send', channel: X, message: 'announcement' });
        await t.waitFrame(dave, (f) => f.type === 'chat' && f.action === 'message' && f.message.message === 'announcement');
    });
});

describe('splitServiceChannel', () => {
    test('strips a known service prefix and leaves anything else alone', () => {
        expect(splitServiceChannel('presence:acme:room')).toEqual({ service: 'presence', channel: 'acme:room' });
        expect(splitServiceChannel('reactions:acme:room')).toEqual({ service: 'reactions', channel: 'acme:room' });
        expect(splitServiceChannel('cursor:acme:room')).toEqual({ service: 'cursor', channel: 'acme:room' });
        expect(splitServiceChannel('acme:room')).toEqual({ service: null, channel: 'acme:room' });
        expect(splitServiceChannel('presence')).toEqual({ service: null, channel: 'presence' });
    });
});
