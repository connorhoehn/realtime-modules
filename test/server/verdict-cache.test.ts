// 0.119 (lane R6) — the authority verdict cache (verdictCache.ts V1–V7) and
// batched recipient authorization. The cache is only safe because revocation
// still takes effect on the very next check: these contracts prove that for
// an epoch change, a membership event, a principal refusal, a replaced
// context and a disconnect — and that a refusal is never cached.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
    attachRealtime, chat, withAuthorityCache, withPrincipalRevalidation, RedisRealtimeRouter,
    type ChannelAuthorize, type ChannelAuthorizeBatch, type RealtimeHandle, type RealtimeMembershipInvalidation,
} from '../../src/server';
import type { WsAuthContext } from '../../src/server-ws/types';
import { createAuthorityScope } from '../../src/server-ws/authorityScope';
import { FakeClusterRedis } from './helpers/fakeClusterRedis';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function eventually(predicate: () => boolean, ms = 2000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (predicate()) return; await delay(10); }
    throw new Error('condition did not become true');
}

describe('withAuthorityCache — unit contract', () => {
    function host(initial: boolean | (() => boolean | Promise<boolean>) = true) {
        const calls: string[] = [];
        let answer = initial;
        const authorize: ChannelAuthorize = async ({ kind, channel }) => {
            calls.push(`${kind}:${channel}`);
            return typeof answer === 'function' ? answer() : answer;
        };
        return { calls, authorize, set: (a: typeof answer) => { answer = a; } };
    }
    const ctx = (userId = 'u1', epoch: number = 1): WsAuthContext => ({ userId, epoch });
    const epochOf = (c: WsAuthContext) => c.epoch as number;

    it('V1/V2: caches a positive per (connection, kind, channel); asks again for another kind or channel', async () => {
        const h = host();
        const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: epochOf });
        const c = ctx();
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(await authorize({ kind: 'subscribe', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:2', ctx: c })).toBe(true);
        expect(await authorize({ kind: 'publish', clientId: 'c2', channel: 'dm:1', ctx: ctx('u2') })).toBe(true);
        expect(h.calls).toEqual(['publish:dm:1', 'subscribe:dm:1', 'publish:dm:2', 'publish:dm:1']);
        expect(cache.stats()).toMatchObject({ hits: 1, misses: 4, stores: 4, entries: 4 });
    });

    it('V2: a refusal is never cached, and drops the positive it replaces', async () => {
        const h = host(false);
        const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: epochOf });
        const c = ctx();
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(false);
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(false);
        expect(h.calls).toHaveLength(2);
        h.set(() => { throw new Error('policy down'); });
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(false);
        expect(cache.stats().entries).toBe(0);
        h.set(true);
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(cache.stats().entries).toBe(1);
    });

    it('V1: an epoch change is a miss and fences every verdict of that connection', async () => {
        const h = host();
        let epoch = 1;
        const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: () => epoch });
        const c = ctx();
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c });
        await authorize({ kind: 'subscribe', clientId: 'c1', channel: 'dm:2', ctx: c });
        epoch = 2;
        h.set(false);
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(false);
        // The other channel's verdict went with the epoch, too.
        expect(await authorize({ kind: 'subscribe', clientId: 'c1', channel: 'dm:2', ctx: c })).toBe(false);
        expect(cache.stats().entries).toBe(0);
        expect(cache.stats().fenced).toBeGreaterThanOrEqual(2);
    });

    it('V1: a replaced auth context (same connection id) is a miss', async () => {
        const h = host();
        const { authorize } = withAuthorityCache(h.authorize, { epoch: epochOf });
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() });
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() });
        expect(h.calls).toHaveLength(2);
    });

    it('V1: no epoch (null, undefined, throw) means no caching', async () => {
        for (const epoch of [() => null, () => undefined, () => { throw new Error('x'); }, () => NaN]) {
            const h = host();
            const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: epoch as any });
            await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() });
            await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() });
            expect(h.calls).toHaveLength(2);
            expect(cache.stats().entries).toBe(0);
        }
    });

    it('V3: invalidateChannel drops every service prefix of the base channel; invalidateUser and invalidateConnection too', async () => {
        const h = host();
        const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: epochOf });
        const c1 = ctx('u1'), c2 = ctx('u2');
        const ask = (clientId: string, c: WsAuthContext, channel: string) => authorize({ kind: 'subscribe', clientId, channel, ctx: c });
        await ask('c1', c1, 'dm:1'); await ask('c1', c1, 'presence:dm:1'); await ask('c2', c2, 'dm:1'); await ask('c1', c1, 'dm:9');
        expect(cache.stats().entries).toBe(4);
        cache.invalidateChannel('dm:1');
        expect(cache.stats().entries).toBe(1);
        await ask('c2', c2, 'dm:1'); await ask('c2', c2, 'dm:2');
        cache.invalidateUser('u2');
        expect(cache.stats().entries).toBe(1);
        cache.invalidateConnection('c1');
        expect(cache.stats().entries).toBe(0);
        await ask('c1', c1, 'dm:1');
        cache.clear();
        expect(cache.stats().entries).toBe(0);
    });

    it('V3: a verdict whose host call was in flight during a matching invalidation is answered but not stored', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let calls = 0;
        const { authorize, cache } = withAuthorityCache(async () => { calls++; await gate; return true; }, { epoch: epochOf });
        const pending = authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() });
        cache.invalidateChannel('dm:1');
        release();
        expect(await pending).toBe(true);
        expect(cache.stats().entries).toBe(0);
        const c = ctx();
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c });
        expect(calls).toBe(2);
    });

    it('V1: an epoch that moved while the host call ran is not stored', async () => {
        let epoch = 1;
        const { authorize, cache } = withAuthorityCache(async () => { epoch = 2; return true; }, { epoch: () => epoch });
        expect(await authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: ctx() })).toBe(true);
        expect(cache.stats().entries).toBe(0);
    });

    it('V5/V6: entries expire after maxAgeMs and the oldest is evicted past maxEntries', async () => {
        let now = 1000;
        const h = host();
        const { authorize, cache } = withAuthorityCache(h.authorize, { epoch: epochOf, maxAgeMs: 100, maxEntries: 2, now: () => now });
        const c = ctx();
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'a', ctx: c });
        now += 100;
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'a', ctx: c });
        expect(h.calls).toHaveLength(2);
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'b', ctx: c });
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'c', ctx: c });
        expect(cache.stats().entries).toBe(2);
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'a', ctx: c });
        expect(h.calls).toHaveLength(5);
    });

    it('kinds limits what is cached; bad options throw', async () => {
        const h = host();
        const { authorize } = withAuthorityCache(h.authorize, { epoch: epochOf, kinds: ['subscribe'] });
        const c = ctx();
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'a', ctx: c });
        await authorize({ kind: 'publish', clientId: 'c1', channel: 'a', ctx: c });
        expect(h.calls).toHaveLength(2);
        expect(() => withAuthorityCache(h.authorize, {} as any)).toThrow(/epoch/);
        expect(() => withAuthorityCache(h.authorize, { epoch: epochOf, maxAgeMs: 0 })).toThrow(/maxAgeMs/);
        expect(() => withAuthorityCache(h.authorize, { epoch: epochOf, maxEntries: 0 })).toThrow(/maxEntries/);
    });

    it('V4: principal revalidation runs on every check (hits included) and a refusal drops the connection', async () => {
        const h = host();
        const cached = withAuthorityCache(h.authorize, { epoch: epochOf });
        let current = true;
        let revalidations = 0;
        const hooks = withPrincipalRevalidation({ authorize: cached.authorize }, {
            revalidate: () => { revalidations++; return current; },
        }, { onStale: id => cached.cache.invalidateConnection(id) });
        const c = ctx();
        expect(await hooks.authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(await hooks.authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(revalidations).toBe(4); // before and after, on the miss AND the hit
        current = false;
        expect(await hooks.authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c })).toBe(false);
        expect(cached.cache.stats().entries).toBe(0);
        current = true;
        await hooks.authorize({ kind: 'publish', clientId: 'c1', channel: 'dm:1', ctx: c });
        expect(h.calls).toHaveLength(2);
    });

    it('batch: hits are answered from the cache, misses go to ONE host call, positives are stored', async () => {
        const batches: string[][] = [];
        let deny = new Set<string>();
        const batch: ChannelAuthorizeBatch = async ({ recipients }) => {
            batches.push(recipients.map(r => r.clientId));
            return recipients.map(r => !deny.has(r.clientId));
        };
        const cached = withAuthorityCache(async () => true, { epoch: epochOf }, batch);
        const rs = ['a', 'b', 'c'].map(id => ({ clientId: id, ctx: ctx(id) }));
        expect(await cached.authorizeBatch!({ kind: 'subscribe', channel: 'dm:1', recipients: rs })).toEqual([true, true, true]);
        expect(await cached.authorizeBatch!({ kind: 'subscribe', channel: 'dm:1', recipients: rs })).toEqual([true, true, true]);
        expect(batches).toEqual([['a', 'b', 'c']]);
        cached.cache.invalidateUser('b');
        deny = new Set(['b']);
        expect(await cached.authorizeBatch!({ kind: 'subscribe', channel: 'dm:1', recipients: rs })).toEqual([true, false, true]);
        expect(batches[1]).toEqual(['b']);
        // A malformed answer refuses the misses, never the cached hits' neighbours by accident.
        const bad = withAuthorityCache(async () => true, { epoch: epochOf }, async () => [true]);
        expect(await bad.authorizeBatch!({ kind: 'subscribe', channel: 'dm:1', recipients: rs })).toEqual([false, false, false]);
        expect(bad.cache.stats().entries).toBe(0);
    });

    it('batch through the principal fence: stale recipients are refused before and after the host call', async () => {
        const seen: string[][] = [];
        const batch: ChannelAuthorizeBatch = ({ recipients }) => { seen.push(recipients.map(r => r.clientId)); return recipients.map(() => true); };
        const stale = new Set(['b']);
        const dropped: string[] = [];
        const hooks = withPrincipalRevalidation({ authorize: async () => true, authorizeBatch: batch },
            { revalidate: c => !stale.has(c.userId as string) }, { onStale: id => dropped.push(id) });
        const rs = ['a', 'b', 'c'].map(id => ({ clientId: id, ctx: ctx(id) }));
        expect(await hooks.authorizeBatch!({ kind: 'subscribe', channel: 'x', recipients: rs, scope: createAuthorityScope('t') })).toEqual([true, false, true]);
        expect(seen).toEqual([['a', 'c']]);
        expect(dropped).toEqual(['b']);
    });
});

// ── Over real sockets ─────────────────────────────────────────────────────────

type Conn = { ws: WebSocket; frames: any[] };

function rig(opts: { batch?: boolean; cache?: boolean } = {}) {
    const members = new Map<string, Set<string>>();
    const epochs = new Map<string, number>();
    const revoked = new Set<string>();
    const counters = { authorize: 0, batch: 0, batchSizes: [] as number[] };
    const authorize: ChannelAuthorize = ({ channel, ctx }) => {
        counters.authorize++;
        return !!ctx && !!members.get(channel)?.has(ctx.userId as string);
    };
    const authorizeBatch: ChannelAuthorizeBatch = ({ channel, recipients }) => {
        counters.batch++; counters.batchSizes.push(recipients.length);
        return recipients.map(r => !!members.get(channel)?.has(r.ctx.userId as string));
    };
    const r = {
        members, epochs, revoked, counters,
        server: null as unknown as http.Server, handle: null as unknown as RealtimeHandle, port: 0, open: [] as WebSocket[],
        async start() {
            r.server = http.createServer();
            r.handle = attachRealtime(r.server, {
                features: [chat()], path: '/rt', pingIntervalMs: 0,
                auth: req => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('u') ?? '' }),
                authorize,
                ...(opts.batch ? { authorizeBatch } : {}),
                ...(opts.cache !== false ? { authorityCache: { epoch: (c: WsAuthContext) => epochs.get(c.userId as string) ?? 1 } } : {}),
                principal: { revalidate: c => !revoked.has(c.userId as string) },
            });
            await new Promise<void>(res => r.server.listen(0, '127.0.0.1', () => res()));
            r.port = (r.server.address() as AddressInfo).port;
        },
        async stop() {
            for (const ws of r.open) ws.close();
            await r.handle.dispose();
            await new Promise<void>(res => r.server.close(() => res()));
        },
        connect(u: string): Promise<Conn> {
            return new Promise((res, rej) => {
                const ws = new WebSocket(`ws://127.0.0.1:${r.port}/rt?u=${u}`);
                r.open.push(ws);
                const c: Conn = { ws, frames: [] };
                ws.on('message', raw => {
                    const f = JSON.parse(raw.toString());
                    c.frames.push(f);
                    if (f.type === 'session') res(c);
                });
                ws.on('error', rej);
            });
        },
    };
    return r;
}
const send = (c: Conn, f: Record<string, unknown>) => c.ws.send(JSON.stringify(f));
const got = (c: Conn, text: string) => c.frames.some(f => f.type === 'chat' && f.action === 'message' && f.message?.message === text);

describe('attachRealtime({ authorityCache }) — revocation takes effect immediately', () => {
    let r: ReturnType<typeof rig>;
    let a: Conn, b: Conn;
    beforeEach(async () => {
        r = rig();
        await r.start();
        r.members.set('dm:ab', new Set(['ua', 'ub']));
        a = await r.connect('ua'); b = await r.connect('ub');
        send(a, { service: 'chat', action: 'join', channel: 'dm:ab' });
        send(b, { service: 'chat', action: 'join', channel: 'dm:ab' });
        await eventually(() => [a, b].every(c => c.frames.some(f => f.type === 'chat' && f.action === 'joined')));
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'warm-1' });
        await eventually(() => got(b, 'warm-1'));
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'warm-2' });
        await eventually(() => got(b, 'warm-2'));
    });
    afterEach(async () => { await r.stop(); });

    it('serves repeat sends from the cache (fewer host calls per send)', async () => {
        const before = r.counters.authorize;
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'hot' });
        await eventually(() => got(b, 'hot'));
        expect(r.counters.authorize - before).toBe(0);
        const s = r.handle.stats();
        expect(s.authorityCache!.hits).toBeGreaterThan(0);
        expect(s.connections).toBe(2);
        expect(typeof s.queueDepth).toBe('number');
    });

    it('a membership event (invalidateChannel) refuses the removed member on the next send', async () => {
        r.members.get('dm:ab')!.delete('ub');
        r.handle.authorityCache!.invalidateChannel('dm:ab');
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'after-removal' });
        await eventually(() => got(a, 'after-removal'));
        await delay(50);
        expect(got(b, 'after-removal')).toBe(false);
    });

    it('a membership change WITHOUT an event is still served from the cache (why events are mandatory)', async () => {
        r.members.get('dm:ab')!.delete('ub');
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'no-event' });
        await eventually(() => got(b, 'no-event'));
    });

    it('an epoch bump refuses on the next check, with no invalidation call', async () => {
        r.members.get('dm:ab')!.delete('ub');
        r.epochs.set('ub', 2);
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'after-epoch' });
        await eventually(() => got(a, 'after-epoch'));
        await delay(50);
        expect(got(b, 'after-epoch')).toBe(false);
    });

    it('a sender whose epoch moved is refused at once', async () => {
        r.members.get('dm:ab')!.delete('ua');
        r.epochs.set('ua', 7);
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'sender-epoch' });
        await eventually(() => a.frames.some(f => f.code === 'AUTHZ_CHANNEL_DENIED'));
        expect(got(b, 'sender-epoch')).toBe(false);
    });

    it('a principal revalidation failure refuses at once and drops the connection\'s verdicts', async () => {
        r.revoked.add('ub');
        send(a, { service: 'chat', action: 'send', channel: 'dm:ab', message: 'after-revoke' });
        await eventually(() => got(a, 'after-revoke'));
        await delay(50);
        expect(got(b, 'after-revoke')).toBe(false);
        expect(r.handle.authorityCache!.stats().entries).toBeLessThanOrEqual(2); // only ua's remain
    });

    it('a disconnect drops the connection\'s verdicts', async () => {
        const before = r.handle.authorityCache!.stats().entries;
        b.ws.close();
        await eventually(() => r.handle.authorityCache!.stats().entries < before);
    });
});

describe('attachRealtime({ authorizeBatch }) — one host call per fan-out', () => {
    it('asks once for every recipient, honours a per-recipient refusal, and falls back to per-recipient without it', async () => {
        for (const batch of [true, false]) {
            const r = rig({ batch, cache: false });
            await r.start();
            try {
                r.members.set('dm:g', new Set(['u0', 'u1', 'u2', 'u3']));
                const cs = await Promise.all(['u0', 'u1', 'u2', 'u3'].map(u => r.connect(u)));
                for (const c of cs) send(c, { service: 'chat', action: 'join', channel: 'dm:g' });
                await eventually(() => cs.every(c => c.frames.some(f => f.type === 'chat' && f.action === 'joined')));
                const before = { ...r.counters, batchSizes: [...r.counters.batchSizes] };
                r.members.get('dm:g')!.delete('u3');
                send(cs[0], { service: 'chat', action: 'send', channel: 'dm:g', message: 'g1' });
                await eventually(() => got(cs[1], 'g1') && got(cs[2], 'g1') && got(cs[0], 'g1'));
                await delay(50);
                expect(got(cs[3], 'g1')).toBe(false);
                if (batch) {
                    expect(r.counters.batch - before.batch).toBe(1);
                    expect(r.counters.batchSizes.slice(before.batchSizes.length)).toEqual([4]);
                } else {
                    expect(r.counters.batch).toBe(0);
                }
            } finally { await r.stop(); }
        }
    });

    it('a malformed batch answer refuses every recipient (fail closed)', async () => {
        const server = http.createServer();
        const handle = attachRealtime(server, {
            features: [chat()], path: '/rt', pingIntervalMs: 0,
            auth: req => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('u') ?? '' }),
            authorize: () => true,
            authorizeBatch: () => [true],
        });
        await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
        const port = (server.address() as AddressInfo).port;
        const open = (u: string) => new Promise<Conn>(res => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/rt?u=${u}`);
            const c: Conn = { ws, frames: [] };
            ws.on('message', raw => { const f = JSON.parse(raw.toString()); c.frames.push(f); if (f.type === 'session') res(c); });
        });
        try {
            const [x, y, z] = await Promise.all([open('x'), open('y'), open('z')]);
            for (const c of [x, y, z]) send(c, { service: 'chat', action: 'join', channel: 'room' });
            await eventually(() => [x, y, z].every(c => c.frames.some(f => f.type === 'chat' && f.action === 'joined')));
            send(x, { service: 'chat', action: 'send', channel: 'room', message: 'm' });
            await eventually(() => x.frames.some(f => f.type === 'chat' && f.action === 'sent'));
            await delay(50);
            expect([x, y, z].some(c => got(c, 'm'))).toBe(false);
            for (const c of [x, y, z]) c.ws.close();
        } finally {
            await handle.dispose();
            await new Promise<void>(res => server.close(() => res()));
        }
    });
});

describe('RedisRealtimeRouter({ authorityCache }) — membership events drop verdicts', () => {
    const routers: RedisRealtimeRouter[] = [];
    afterEach(async () => { for (const router of routers.splice(0)) await router.shutdown(); });
    function store() {
        const observers = new Set<(channel: string) => void>();
        const s: RealtimeMembershipInvalidation & { commit(channel: string): void } = {
            invalidate: () => undefined,
            onCommittedWrite: o => { observers.add(o); return () => { observers.delete(o); }; },
            commit: channel => { for (const o of observers) o(channel); },
        };
        return s;
    }
    it('local committed writes and peer events both invalidate the channel', async () => {
        const redis = new FakeClusterRedis();
        const sa = store(), sb = store();
        const ia: string[] = [], ib: string[] = [];
        const mk = (nodeId: string, s: ReturnType<typeof store>, seen: string[]) => {
            const router = new RedisRealtimeRouter({ redis: redis.port(), namespace: 'ns', nodeId, leaseMs: 600, requestTimeoutMs: 150,
                membershipStore: s, authorityCache: { invalidateChannel: c => { seen.push(c); } } });
            router._setHandle({ wss: null, dispose: async () => undefined, listClients: () => [], getClientContext: () => null, sendToClient: () => false });
            routers.push(router);
            return router;
        };
        const a = mk('a', sa, ia), b = mk('b', sb, ib);
        await a.start(); await b.start();
        sa.commit('social:room-1');
        await eventually(() => ib.length === 1);
        expect(ia).toEqual(['social:room-1']);
        expect(ib).toEqual(['social:room-1']);
        expect(a.stats()).toMatchObject({ pendingRequests: 0, activeDeliveries: expect.any(Number) });
    });
});
