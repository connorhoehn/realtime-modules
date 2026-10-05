// Native WebSockets and dedicated Redis, with explicit fixture authority.
// This accepts peer transport; it does not accept an application's directory,
// CRDT/presence replication, multi-replica deployment or capacity.
import http from 'http';
import { randomUUID } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import WebSocket from 'ws';
import { attachRealtime, defineFeature, calls, notifications, presence, splitServiceChannel, RedisRealtimeRouter, type RealtimeClusterRedis, type RealtimeHandle } from '../../src/server';
import { RedisPresenceStore } from '../../src/presence';
import { RedisCallStateStore, type CallStateRedis } from '../../src/call';
import type { NotificationService } from '../../src/notification';

const enabled = process.env.REAL_ROUTER_REDIS === '1';
const redisUrl = process.env.REAL_ROUTER_REDIS_URL;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
async function eventually(predicate: () => boolean | Promise<boolean>) {
    for (let n = 0; n < 100; n++) { if (await predicate()) return; await delay(10); }
    throw new Error('Peer condition did not become true');
}
type Client = { ws: WebSocket; id: string; frames: any[] };
type Authority = { epoch: number; org: string };
type VoidDeferred = ReturnType<typeof deferred<void>>;
type NativeNode = { router: RedisRealtimeRouter; handle: RealtimeHandle; server: http.Server;
    command: RedisClientType; subscriber: RedisClientType; published: Array<{ topic: string; payload: string; frame: any }>;
    port: RealtimeClusterRedis; calls: RedisCallStateStore; url: string; unavailable: () => void };

(enabled ? describe : describe.skip)('RedisRealtimeRouter / native peer transport', () => {
    let namespace: string;
    let clients: Client[];
    let nodes: NativeNode[];
    let authorities: Map<string, Authority>;
    let members: Set<string>;
    let held: { id: string; entered: VoidDeferred; release: VoidDeferred; calls: number } | null;

    async function boot(nodeId: string, ns = namespace, options: { fixedClientId?: string; dropReceipts?: boolean;
        registerGate?: VoidDeferred; disconnectGate?: VoidDeferred; disconnected?: VoidDeferred;
        rejoinGraceMs?: number; renewGate?: VoidDeferred; renewing?: VoidDeferred; ended?: string[] } = {}): Promise<NativeNode> {
        if (!redisUrl) throw new Error('REAL_ROUTER_REDIS_URL is required for real Redis acceptance');
        const command = createClient({ url: redisUrl, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
        command.on('error', () => undefined);
        const subscriber = command.duplicate(); subscriber.on('error', () => undefined);
        await Promise.all([command.connect(), subscriber.connect()]);
        const published: Array<{ topic: string; payload: string; frame: any }> = [];
        let unavailable: () => void = () => {};
        const port: RealtimeClusterRedis & { onUnavailable(handler: () => void): () => void } = {
            onUnavailable: handler => { unavailable = handler; return () => { unavailable = () => {}; }; },
            command: async (...args) => {
                if (options.registerGate && args[0] === 'EVAL' && args[1]?.includes("redis.call('EXISTS',KEYS[2])")) {
                    await options.registerGate.promise;
                }
                if (options.renewGate && args[0] === 'EVAL' && args[1]?.includes('for i=2,#KEYS,2')) {
                    // Redis committed the renewal but the response is held.
                    // A late success cannot resurrect local lease ownership.
                    const result = await command.sendCommand(args);
                    options.renewing?.resolve(); await options.renewGate.promise;
                    return result;
                }
                return command.sendCommand(args);
            },
            publish: async (topic, payload) => {
                const frame = JSON.parse(payload); published.push({ topic, payload, frame });
                if (options.dropReceipts && frame.kind === 'receipt') return 0;
                return command.publish(topic, payload);
            },
            subscribe: async (topic, receive) => {
                await subscriber.subscribe(topic, receive);
                return async () => { await subscriber.unsubscribe(topic); };
            },
        };
        const authorize = async ({ ctx, channel }: { ctx: any; channel: string }) => {
            const current = authorities.get(ctx?.userId);
            return !!current && current.epoch === ctx.epoch && current.org === ctx.org
                && splitServiceChannel(channel).channel.startsWith(`${ctx.org}:`) && members.has(ctx.userId);
        };
        const router = new RedisRealtimeRouter({ redis: port, namespace: ns, nodeId, leaseMs: 900, requestTimeoutMs: 200,
            authorize, filterClientMessage: async ({ ctx, message }) => {
                const frame = message as any;
                if (held && frame.id === held.id && ctx?.userId === 'bob') {
                    held.calls++; held.entered.resolve(); await held.release.promise;
                }
                const authority = authorities.get(String(ctx?.userId));
                if (frame.type === 'call' && typeof frame.data?.lobbyName === 'string'
                    && !frame.data.lobbyName.startsWith(`${ctx?.org}:`)) return null;
                return authority && authority.epoch === ctx?.epoch && authority.org === ctx?.org ? message : null;
            } });
        await router.start();
        const callRedis: CallStateRedis & { get(key: string): Promise<string | null> } = {
            sendCommand: args => command.sendCommand(args),
            hsetnx: (key, field, value) => command.hSetNX(key, field, value),
            get: key => command.get(key),
            hset: (key, field, value) => command.hSet(key, field, value),
            hgetall: key => command.hGetAll(key), hdel: (key, ...fields) => command.hDel(key, fields),
            sadd: (key, ...values) => command.sAdd(key, values), srem: (key, ...values) => command.sRem(key, values),
            smembers: key => command.sMembers(key), del: (...keys) => command.del(keys), expire: (key, seconds) => command.expire(key, seconds),
            setNX: async (key, value) => (await command.set(key, value, { NX: true })) === 'OK',
        };
        const state = new RedisCallStateStore(callRedis);
        const server = http.createServer((_req, res) => res.end('existing route'));
        const handle: RealtimeHandle = attachRealtime(server, { router, path: '/realtime', pingIntervalMs: 0,
            logger: process.env.REAL_ROUTER_TEST_DEBUG === '1' ? console : undefined,
            generateClientId: () => options.fixedClientId ?? `${nodeId}-${randomUUID()}`,
            onDisconnect: async () => { options.disconnected?.resolve(); await options.disconnectGate?.promise; },
            auth: req => {
                // The fixture's trusted auth source. An unknown credential
                // rejects upgrade; payload fields cannot select this identity.
                const userId = String(req.headers['x-test-credential'] ?? '');
                const current = authorities.get(userId);
                if (!current) throw new Error('Unauthenticated');
                return { userId, org: current.org, epoch: current.epoch, role: 'member' };
            },
            features: [presence({ store: new RedisPresenceStore(port, ns), disconnectDelayMs: 50 }), calls({ stateStore: state, crossNodePubSub: router.crossNodePubSub, rejoinGraceMs: options.rejoinGraceMs ?? 200,
                lobbyGuard: (ctx, lobby) => !!ctx && lobby.startsWith(`${ctx.org}:`),
                config: { onCallEnded: summary => { options.ended?.push(summary.callId); }, authorize: async clientId => {
                    const ctx = router.getClientData(clientId)?.userContext;
                    return !!ctx && authorities.get(String(ctx.userId))?.epoch === ctx.epoch;
                } } }), notifications(), defineFeature({ manifest: { name: 'peer-test' } as any,
                create: () => ({ handleAction: async (clientId, action, data) => {
                    if (action === 'publish') await router.sendToChannel(String(data.channel),
                        { type: 'test', id: data.id }, null, { publisherClientId: clientId });
                } }) })],
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
        const node = { router, handle, server, command, subscriber, published, port, calls: state, url: `ws://127.0.0.1:${address.port}/realtime`, unavailable: () => unavailable() };
        nodes.push(node);
        return node;
    }
    async function connect(node: NativeNode, userId: string): Promise<Client> {
        const ws = new WebSocket(node.url, { headers: { 'x-test-credential': userId } });
        const frames: any[] = [];
        const ready = deferred<string>();
        ws.on('message', raw => {
            const frame = JSON.parse(String(raw)); frames.push(frame);
            if (frame.type === 'session') ready.resolve(frame.clientId);
        });
        ws.on('error', () => undefined);
        const id = await ready.promise;
        const client = { ws, id, frames }; clients.push(client);
        return client;
    }
    beforeEach(() => {
        namespace = `acceptance-${randomUUID()}`;
        clients = []; nodes = []; held = null;
        authorities = new Map([['alice', { epoch: 0, org: 'orgiq' }], ['bob', { epoch: 0, org: 'orgiq' }],
            ['charlie', { epoch: 0, org: 'assessment' }]]);
        members = new Set(['alice', 'bob', 'charlie']);
    });
    afterEach(async () => {
        held?.release.resolve();
        for (const client of clients) client.ws.terminate();
        for (const node of nodes) {
            await node.handle.dispose();
            await new Promise<void>(resolve => node.server.close(() => resolve()));
            if (node.command.isOpen) node.command.destroy();
            if (node.subscriber.isOpen) node.subscriber.destroy();
        }
    });

    it('resolves authenticated peers across nodes and confirms actual remote writes', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        expect(await a.router.getClientsByUserId(['bob'])).toEqual([{ clientId: bob.id, userId: 'bob' }]);
        expect(await a.router.resolveClientData(bob.id)).toEqual({ userContext: { userId: 'bob', org: 'orgiq', epoch: 0, role: 'member' } });
        expect(await a.router.sendToClient(bob.id, { type: 'test', id: 'remote' })).toBe(true);
        await eventually(() => bob.frames.some(frame => frame.id === 'remote'));
        expect(alice.frames.some(frame => frame.id === 'remote')).toBe(false);
        expect(await a.router.sendToClient('missing', { type: 'test' })).toBe(false);
    });

    it('checks actual readable peer subscriptions and refuses unsubscribed, retired and lost owners', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        const channel = 'orgiq:room';
        expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(false);
        expect(await b.router.subscribeToChannel(bob.id, channel)).toBe(true);
        expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(true);
        b.router.unsubscribeFromChannel(bob.id, channel);
        expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(false);
        await b.router.subscribeToChannel(bob.id, channel);
        members.delete('bob'); expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(false);
        members.add('bob'); authorities.set('bob', { epoch: 1, org: 'orgiq' });
        expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(false);
        authorities.set('bob', { epoch: 0, org: 'orgiq' });
        b.unavailable(); expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(false);
        expect(bob.frames.some(frame => frame.code === 'AUTHZ_CHANNEL_DENIED')).toBe(false);
    });

    it('bounds missing peer subscription receipts and cannot turn a stale reply into a positive query', async () => {
        const a = await boot('a'), b = await boot('b', namespace, { dropReceipts: true });
        const bob = await connect(b, 'bob'); await b.router.subscribeToChannel(bob.id, 'orgiq:room');
        expect(await a.router.isClientSubscribed(bob.id, 'orgiq:room')).toBe(false);
        const receipt = b.published.find(entry => entry.frame.kind === 'receipt')!;
        expect(receipt.frame.delivered).toBe(true);
        await b.command.publish(receipt.topic, receipt.payload);
        expect(await a.router.isClientSubscribed('missing', 'orgiq:room')).toBe(false);
    });

    it('fences a pending peer subscription query across unsubscribe and resubscribe', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        const channel = 'orgiq:room'; await b.router.subscribeToChannel(bob.id, channel);
        const gate = deferred(), entered = deferred();
        const local = (b.router as any).local;
        const original = local.checkChannel.bind(local);
        const check = jest.spyOn(local, 'checkChannel').mockImplementationOnce(async (...args: any[]) => {
            const allowed = await original(...args); entered.resolve(); await gate.promise; return allowed;
        });
        try {
            const pending = a.router.isClientSubscribed(bob.id, channel); await entered.promise;
            b.router.unsubscribeFromChannel(bob.id, channel); await b.router.subscribeToChannel(bob.id, channel);
            gate.resolve(); expect(await pending).toBe(false);
            expect(await a.router.isClientSubscribed(bob.id, channel)).toBe(true);
        } finally { gate.resolve(); check.mockRestore(); }
    });

    it('rechecks remote recipient epoch/policy and keeps the inbox delivery count honest', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        authorities.set('bob', { epoch: 1, org: 'orgiq' });
        expect(await a.router.sendToClient(bob.id, { type: 'test', id: 'revoked' })).toBe(false);
        expect(bob.frames.some(frame => frame.id === 'revoked')).toBe(false);
    });

    it('shares channels with source publish checks and destination membership checks', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        expect(await b.router.subscribeToChannel(bob.id, 'orgiq:room')).toBe(true);
        alice.ws.send(JSON.stringify({ service: 'peer-test', action: 'publish', channel: 'orgiq:room', id: 'channel' }));
        await eventually(() => bob.frames.some(frame => frame.id === 'channel'));
        expect(await b.router.subscribeToChannel(bob.id, 'assessment:room')).toBe(false);
        members.delete('bob');
        await a.router.sendToChannel('orgiq:room', { type: 'test', id: 'removed' });
        await delay(30);
        expect(bob.frames.some(frame => frame.id === 'removed')).toBe(false);
        members.delete('alice');
        await a.router.sendToChannel('orgiq:room', { type: 'test', id: 'publisher-denied' }, null, { publisherClientId: alice.id });
        expect(a.published.some(entry => entry.frame.message?.id === 'publisher-denied')).toBe(false);
    });

    it('drops a held delivery after disconnect and suppresses in-flight duplicate frames', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        held = { id: 'held', entered: deferred(), release: deferred(), calls: 0 };
        const sending = a.router.sendToClient(bob.id, { type: 'test', id: 'held' });
        await held.entered.promise;
        const request = a.published.find(entry => entry.frame.kind === 'direct')!;
        await a.command.publish(request.topic, request.payload);
        bob.ws.terminate();
        await eventually(() => b.handle.getClientContext(bob.id) === null);
        held.release.resolve();
        expect(await sending).toBe(false);
        expect(held.calls).toBe(1);
        expect(bob.frames.some(frame => frame.id === 'held')).toBe(false);
    });

    it('fences an awaited channel filter across unsubscribe and resubscribe', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        await b.router.subscribeToChannel(bob.id, 'orgiq:room');
        held = { id: 'old-subscription', entered: deferred(), release: deferred(), calls: 0 };
        await a.router.sendToChannel('orgiq:room', { type: 'test', id: held.id });
        await held.entered.promise;
        b.router.unsubscribeFromChannel(bob.id, 'orgiq:room');
        await b.router.subscribeToChannel(bob.id, 'orgiq:room');
        held.release.resolve(); await delay(30);
        expect(bob.frames.some(frame => frame.id === 'old-subscription')).toBe(false);
        await a.router.sendToChannel('orgiq:room', { type: 'test', id: 'new-subscription' });
        await eventually(() => bob.frames.some(frame => frame.id === 'new-subscription'));
    });

    it('keeps live directory entries through renewals and rejects another live node owner', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        const duplicate = new RedisRealtimeRouter({ redis: a.port, namespace, nodeId: 'b' });
        await expect(duplicate.start()).rejects.toThrow('live owner');
        await delay(1200);
        expect(await a.router.isClientAlive(bob.id)).toBe(true);
        expect(await a.router.sendToClient(bob.id, { type: 'test', id: 'after-renewal' })).toBe(true);
    });

    it('fences a lost node lease and rejects stale connection generations after restart', async () => {
        const a = await boot('a'), b = await boot('b', namespace, { fixedClientId: 'fixed' });
        const bob = await connect(b, 'bob');
        await a.router.resolveClientData(bob.id);
        await b.handle.dispose();
        const replacement = await boot('b', namespace, { fixedClientId: 'fixed' });
        const charlie = await connect(replacement, 'charlie');
        expect(await a.router.sendToClient('fixed', { type: 'test', id: 'old-audience' })).toBe(false);
        expect(await a.router.sendToClient('fixed', { type: 'test', id: 'old-audience-retry' })).toBe(false);
        expect(charlie.frames.some(frame => frame.id === 'old-audience')).toBe(false);
        expect((await a.router.resolveClientData('fixed'))?.userContext?.userId).toBe('charlie');
        expect(await a.router.sendToClient('fixed', { type: 'test', id: 'new-audience' })).toBe(true);
        await a.command.del(`realtime:${encodeURIComponent(namespace)}:node:b`);
        expect(await a.router.isClientAlive('fixed')).toBe(false);
        await eventually(() => replacement.router.isClientLive('fixed') === false);
    });

    it('keeps an expired local lease fenced after a late successful renewal response', async () => {
        const gate = deferred(), renewing = deferred();
        const a = await boot('a', namespace, { renewGate: gate, renewing });
        const alice = await connect(a, 'alice');
        await renewing.promise;
        await eventually(() => a.router.isClientLive(alice.id) === false);
        gate.resolve(); await delay(350);
        expect(a.router.isClientLive(alice.id)).toBe(false);
        expect(await a.router.sendToClient(alice.id, { type: 'test', id: 'late-renewal' })).toBe(false);
        expect(alice.frames.some(frame => frame.id === 'late-renewal')).toBe(false);
    });

    it('prunes expired peer entries while preserving a live user connection index', async () => {
        const a = await boot('a'), b = await boot('b'), c = await boot('c');
        const old = await connect(b, 'bob'), current = await connect(c, 'bob');
        const prefix = `realtime:${encodeURIComponent(namespace)}:`;
        await a.command.del(`${prefix}node:b`);
        await a.command.pExpire(`${prefix}client:${encodeURIComponent(old.id)}`, 1);
        await eventually(async () => await a.command.get(`${prefix}client:${encodeURIComponent(old.id)}`) === null);
        expect(await a.router.getClientsByUserId(['bob'])).toEqual([{ clientId: current.id, userId: 'bob' }]);
        expect(await a.command.sMembers(`${prefix}user:bob`)).toEqual([current.id]);
        expect(await a.router.sendToClient(current.id, { type: 'test', id: 'retained-live-peer' })).toBe(true);
    });

    it('isolates cluster namespaces and ignores forged peer origins', async () => {
        const a = await boot('a'), b = await boot('b'), c = await boot('a', `${namespace}-other`);
        const bob = await connect(b, 'bob');
        expect(await c.router.getClientsByUserId(['bob'])).toEqual([]);
        await a.router.sendToClient(bob.id, { type: 'test', id: 'known' });
        const request = a.published.find(entry => entry.frame.kind === 'direct')!;
        const forged = { ...request.frame, id: randomUUID(), source: { nodeId: 'unknown', instance: randomUUID() }, message: { id: 'forged' } };
        await a.command.publish(request.topic, JSON.stringify(forged)); await delay(30);
        expect(bob.frames.some(frame => frame.id === 'forged')).toBe(false);
    });

    it('returns an unconfirmed receipt on lost acknowledgement without duplicating the write', async () => {
        const a = await boot('a'), b = await boot('b', namespace, { dropReceipts: true }), bob = await connect(b, 'bob');
        expect(await a.router.sendToClient(bob.id, { type: 'test', id: 'receipt-lost' })).toBe(false);
        expect(bob.frames.filter(frame => frame.id === 'receipt-lost')).toHaveLength(1);
    });

    it('does not announce readiness or leave a registry entry when registration outlives its socket', async () => {
        const gate = deferred();
        const a = await boot('a', namespace, { registerGate: gate });
        const ws = new WebSocket(a.url, { headers: { 'x-test-credential': 'alice' } });
        const frames: any[] = []; ws.on('message', raw => frames.push(JSON.parse(String(raw)))); ws.on('error', () => undefined);
        await new Promise<void>(resolve => ws.once('open', resolve));
        ws.terminate(); gate.resolve();
        await eventually(async () => (await a.router.getClientsByUserId(['alice'])).length === 0 && a.handle.listClients().length === 0);
        expect(frames.some(frame => frame.type === 'session')).toBe(false);
    });

    it('retains bounded early client frames and dispatches them once after registration', async () => {
        const gate = deferred(), a = await boot('a', namespace, { registerGate: gate }), b = await boot('b');
        const bob = await connect(b, 'bob'); await b.router.subscribeToChannel(bob.id, 'orgiq:room');
        const ws = new WebSocket(a.url, { headers: { 'x-test-credential': 'alice' } });
        ws.on('error', () => undefined);
        await new Promise<void>(resolve => ws.once('open', resolve));
        for (const id of ['early-1', 'early-2']) ws.send(JSON.stringify({ service: 'peer-test', action: 'publish', channel: 'orgiq:room', id }));
        await delay(20); expect(bob.frames.some(frame => frame.id === 'early-1')).toBe(false);
        gate.resolve();
        await eventually(() => bob.frames.filter(frame => /^early-/.test(frame.id ?? '')).length === 2);
        expect(a.published.filter(entry => /^early-/.test(entry.frame.message?.id ?? '')).map(entry => entry.frame.message.id)).toEqual(['early-1', 'early-2']);
        ws.terminate();
    });

    it('closes an overfull startup queue without dispatching unauthorised early work', async () => {
        const gate = deferred(), a = await boot('a', namespace, { registerGate: gate });
        const ws = new WebSocket(a.url, { headers: { 'x-test-credential': 'alice' } });
        ws.on('error', () => undefined);
        const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
        await new Promise<void>(resolve => ws.once('open', resolve));
        for (let n = 0; n < 33; n++) ws.send(JSON.stringify({ service: 'peer-test', action: 'publish', channel: 'orgiq:room', id: `early-${n}` }));
        expect(await closed).toBe(1009); gate.resolve();
        await eventually(async () => (await a.router.getClientsByUserId(['alice'])).length === 0);
        expect(a.published).toEqual([]);
    });

    it('carries native call invite/accept and named departures with shared Redis call state', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = 'orgiq:dm:alice:bob';
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName,
            callerId: 'alice', targetUserIds: ['bob'] }));
        try { await eventually(() => bob.frames.some(frame => frame.action === 'invite' && (frame.callId ?? frame.data?.callId) === callId)); }
        catch (error) { throw new Error(`Call invite failed: ${JSON.stringify({ alice: alice.frames, bob: bob.frames,
            published: a.published, state: await a.calls.getCall(callId), audience: await a.router.getClientsByUserId(['bob']),
            source: a.router.getClientData(alice.id) })}`, { cause: error }); }
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName,
            callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(() => alice.frames.some(frame => frame.action === 'accepted' && (frame.callId ?? frame.data?.callId) === callId));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 2);
        expect((await a.calls.getCall(callId))?.participantClientIds.sort()).toEqual([alice.id, bob.id].sort());
        bob.ws.terminate();
        await eventually(() => alice.frames.some(frame => frame.action === 'user-status' && frame.data?.status === 'left' && frame.data?.userId === 'bob'));
        await delay(30);
        expect(alice.frames.filter(frame => frame.action === 'user-status' && frame.data?.status === 'left' && frame.data?.userId === 'bob')).toHaveLength(1);
    });

    it('admits exactly one of two same-user accepts that race across nodes', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), first = await connect(a, 'bob'), second = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = `orgiq:dm:${randomUUID()}`;
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName,
            callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => [first, second].every(client => client.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId)));
        // Force both replicas to inspect the same pre-accept roster. A
        // getCall-then-register check must lose to an atomic shared claim.
        const bothRead = deferred(); let reads = 0;
        const spies = [a, b].map(node => {
            const original = node.calls.getCall.bind(node.calls);
            return jest.spyOn(node.calls, 'getCall').mockImplementation(async id => {
                const snapshot = await original(id);
                if (id === callId && reads < 2) { if (++reads === 2) bothRead.resolve(); await bothRead.promise; }
                return snapshot;
            });
        });
        try {
            for (const client of [first, second]) client.ws.send(JSON.stringify({ service: 'call', action: 'accepted',
                callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
            await eventually(() => alice.frames.some(frame => frame.action === 'accepted' && frame.data?.callId === callId));
            await eventually(() => [first, second].some(client => client.frames.some(frame => frame.action === 'ended'
                && frame.data?.callId === callId && frame.data?.reason === 'answered-elsewhere')));
            await delay(30);
            expect(alice.frames.filter(frame => frame.action === 'accepted' && frame.data?.callId === callId)).toHaveLength(1);
            const ids = (await a.calls.getCall(callId))!.participantClientIds;
            expect(ids).toHaveLength(2);
            expect(ids).toContain(alice.id);
            expect(ids.filter(id => [first.id, second.id].includes(id))).toHaveLength(1);
            const loser = [first, second].find(client => !ids.includes(client.id))!;
            loser.ws.send(JSON.stringify({ service: 'call', action: 'participant-state', callId, lobbyName,
                callerId: 'bob', userId: 'bob', status: 'in-call', targetUserIds: ['alice'] }));
            await delay(60);
            expect((await a.calls.getCall(callId))!.participantClientIds.sort()).toEqual(ids.sort());
        } finally { bothRead.resolve(); for (const spy of spies) spy.mockRestore(); }
    });

    it('drains async disconnect cleanup before disposing the peer transport', async () => {
        const gate = deferred(), disconnected = deferred();
        const a = await boot('a', namespace, { disconnectGate: gate, disconnected });
        const alice = await connect(a, 'alice');
        let disposed = false;
        const dispose = a.handle.dispose().then(() => { disposed = true; });
        await disconnected.promise;
        expect(disposed).toBe(false);
        gate.resolve(); await dispose;
        expect(await a.command.get(`realtime:${encodeURIComponent(namespace)}:client:${encodeURIComponent(alice.id)}`)).toBeNull();
    });

    it('restores an accepted call seat when the user reconnects on another node', async () => {
        const a = await boot('a', namespace, { rejoinGraceMs: 1200 }), b = await boot('b', namespace, { rejoinGraceMs: 1200 });
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = `orgiq:dm:${randomUUID()}`;
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName,
            callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName,
            callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 2);
        bob.ws.terminate();
        await eventually(() => alice.frames.some(frame => frame.action === 'user-status' && frame.data?.callId === callId
            && frame.data?.userId === 'bob' && frame.data?.status === 'left'));
        const returned = await connect(a, 'bob');
        returned.ws.send(JSON.stringify({ service: 'call', action: 'status', lobbyName }));
        returned.ws.send(JSON.stringify({ service: 'call', action: 'participant-state', callId, lobbyName,
            callerId: 'bob', userId: 'bob', status: 'in-call', targetUserIds: ['alice'] }));
        await eventually(() => alice.frames.some(frame => frame.action === 'participant-state' && frame.data?.callId === callId
            && frame.data?.userId === 'bob'));
        await eventually(async () => {
            const ids = (await a.calls.getCall(callId))?.participantClientIds;
            return !!ids && ids.length === 2 && ids.includes(returned.id) && !ids.includes(bob.id);
        });
        await delay(1400);
        expect(alice.frames.filter(frame => frame.action === 'ended' && frame.data?.callId === callId)).toEqual([]);
        expect(returned.frames.filter(frame => frame.action === 'ended' && frame.data?.callId === callId)).toEqual([]);
    });

    it('applies the destination tenant policy to a cross-node call invite', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), outsider = await connect(b, 'charlie');
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId: randomUUID(), lobbyName: 'orgiq:dm:private',
            callerId: 'alice', targetUserIds: ['charlie'] }));
        await eventually(() => b.published.some(({ frame }) => frame.kind === 'receipt'));
        expect(b.published.find(({ frame }) => frame.kind === 'receipt')?.frame.delivered).toBe(false);
        expect(outsider.frames.filter(frame => frame.action === 'invite')).toEqual([]);
    });

    it('keeps a group call alive when the last local participant leaves but a peer remains', async () => {
        const endedA: string[] = [], endedB: string[] = [];
        const a = await boot('a', namespace, { ended: endedA }), b = await boot('b', namespace, { ended: endedB });
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = `orgiq:initiative:${randomUUID()}`;
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 2);
        bob.ws.send(JSON.stringify({ service: 'call', action: 'ended', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 1);
        expect((await a.calls.getCall(callId))?.participantClientIds).toEqual([alice.id]);
        expect(endedA).not.toContain(callId); expect(endedB).not.toContain(callId);
        alice.ws.send(JSON.stringify({ service: 'call', action: 'status', lobbyName }));
        await eventually(() => alice.frames.some(frame => frame.action === 'active-call' && frame.data?.callId === callId && frame.data?.active));
    });

    it('ends an accepted DM when its last local participant leaves a peer on another node', async () => {
        const endedA: string[] = [], endedB: string[] = [];
        const a = await boot('a', namespace, { ended: endedA }), b = await boot('b', namespace, { ended: endedB });
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = 'orgiq:dm:alice:bob';
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 2);
        bob.ws.send(JSON.stringify({ service: 'call', action: 'ended', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => await a.calls.getCall(callId) === null);
        await eventually(() => endedA.includes(callId) || endedB.includes(callId));
        expect([...endedA, ...endedB].filter(id => id === callId)).toHaveLength(1);
        alice.ws.send(JSON.stringify({ service: 'call', action: 'status', lobbyName }));
        await eventually(() => alice.frames.some(frame => frame.action === 'active-call' && frame.data?.lobbyName === lobbyName && !frame.data?.active));
    });

    it('preserves the original caller when an accepted peer invites another participant', async () => {
        authorities.set('charlie', { epoch: 0, org: 'orgiq' });
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob'), charlie = await connect(a, 'charlie');
        const callId = randomUUID(), lobbyName = `orgiq:initiative:${randomUUID()}`;
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.length === 2);
        const original = await a.calls.getCall(callId);
        bob.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'bob', targetUserIds: ['charlie'] }));
        await eventually(() => charlie.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        const current = await a.calls.getCall(callId);
        expect(current?.callerId).toBe('alice');
        expect(current?.lobbyName).toBe(lobbyName);
        expect(current?.invitedAt).toBe(original?.invitedAt);
        expect(current?.targetUserIds).toEqual(['bob']);
        expect(current?.participantClientIds.sort()).toEqual([alice.id, bob.id].sort());
        expect(await a.calls.isAccepted(callId)).toBe(true);
    });

    it('delivers namespace-scoped peer invalidations once and refuses an expired source owner', async () => {
        const a = await boot('a'), b = await boot('b'), isolated = await boot('c', `${namespace}-isolated`);
        const received: string[] = [], others: string[] = [];
        const unsubscribe = b.router.peerEvents.subscribe('social:membership', async payload => { received.push(payload); });
        isolated.router.peerEvents.subscribe('social:membership', payload => { others.push(payload); });
        expect(a.router.isReady()).toBe(true);
        await a.router.peerEvents.publish('social:membership', 'channel-one');
        await eventually(() => received.length === 1);
        const published = a.published.find(frame => frame.frame.kind === 'peer-event')!;
        await a.command.publish(published.topic, published.payload);
        await delay(30);
        expect(received).toEqual(['channel-one']); expect(others).toEqual([]);
        unsubscribe();
        await a.router.peerEvents.publish('social:membership', 'unsubscribed');
        await delay(30); expect(received).toHaveLength(1);
        await expect(a.router.peerEvents.publish('bad topic', 'value')).rejects.toThrow('Invalid peer event topic');
        await a.router.shutdown();
        expect(a.router.isReady()).toBe(false);
        b.router.peerEvents.subscribe('social:membership', payload => { received.push(payload); });
        await a.command.publish(published.topic, JSON.stringify({ ...published.frame, id: randomUUID() }));
        await delay(30); expect(received).toHaveLength(1);
        await expect(a.router.peerEvents.publish('social:membership', 'retired')).rejects.toThrow();
    });

    it('reads a fresh shared presence roster and excludes revoked, foreign and departed owners', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob'), charlie = await connect(b, 'charlie');
        const channel = 'orgiq:shared-presence';
        alice.ws.send(JSON.stringify({ service: 'presence', action: 'set', status: 'busy', channels: [channel], metadata: { userId: 'forged', displayName: 'Forged' } }));
        bob.ws.send(JSON.stringify({ service: 'presence', action: 'set', status: 'away', channels: [channel] }));
        await eventually(() => alice.frames.some(f => f.type === 'presence' && f.action === 'set' && f.presence?.channels.includes(channel))
            && bob.frames.some(f => f.type === 'presence' && f.action === 'set' && f.presence?.channels.includes(channel)));
        const query = async () => {
            const start = bob.frames.length;
            bob.ws.send(JSON.stringify({ service: 'presence', action: 'get', channel }));
            await eventually(() => bob.frames.slice(start).some(f => f.type === 'presence' && f.action === 'presence'));
            return bob.frames.slice(start).find(f => f.type === 'presence' && f.action === 'presence').data;
        };
        const roster = await query();
        expect(roster.map((row: any) => row.userId).sort()).toEqual(['alice', 'bob']);
        expect(roster.find((row: any) => row.userId === 'alice').metadata.userId).toBe('alice');
        charlie.ws.send(JSON.stringify({ service: 'presence', action: 'get', channel }));
        await eventually(() => charlie.frames.some(f => f.code === 'AUTHZ_CHANNEL_DENIED'));
        expect(charlie.frames.some(f => f.type === 'presence' && f.action === 'presence')).toBe(false);
        authorities.set('alice', { epoch: 1, org: 'orgiq' });
        expect((await query()).map((row: any) => row.userId)).toEqual(['bob']);
        authorities.set('alice', { epoch: 0, org: 'orgiq' });
        alice.ws.terminate();
        await eventually(async () => !await a.router.isClientAlive(alice.id));
        expect((await query()).map((row: any) => row.userId)).toEqual(['bob']);
    });

    it('does not lose surviving shared presence entries when another owner shuts down', async () => {
        const a = await boot('a'), b = await boot('b');
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const channel = 'orgiq:presence-survivor';
        for (const client of [alice, bob]) client.ws.send(JSON.stringify({ service: 'presence', action: 'set', status: 'online', channels: [channel] }));
        const store = new RedisPresenceStore(a.port, namespace);
        await eventually(async () => (await store.list(channel)).length === 2);
        await b.handle.dispose();
        await eventually(async () => (await store.list(channel)).length === 1);
        expect((await store.list(channel))[0].clientId).toBe(alice.id);
    });

    it('retires a fenced node without changing shared accepted seats, then recovers the user on a peer', async () => {
        const ended: string[] = [];
        const a = await boot('a', namespace, { ended }), b = await boot('b', namespace, { ended });
        const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
        const callId = randomUUID(), lobbyName = 'orgiq:dm:alice:bob';
        alice.ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: ['bob'] }));
        await eventually(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId));
        bob.ws.send(JSON.stringify({ service: 'call', action: 'accepted', callId, lobbyName, callerId: 'bob', targetUserIds: ['alice'] }));
        await eventually(async () => await a.calls.isAccepted(callId));
        await a.command.del(`realtime:${encodeURIComponent(namespace)}:node:b`);
        await eventually(() => !b.router.isReady());
        await b.handle.dispose();
        expect((await a.calls.getCall(callId))?.participantClientIds.sort()).toEqual([alice.id, bob.id].sort());
        expect(await a.calls.isAccepted(callId)).toBe(true); expect(ended).toEqual([]);
        const c = await boot('c'), returned = await connect(c, 'bob');
        returned.ws.send(JSON.stringify({ service: 'call', action: 'participant-state', callId, lobbyName,
            callerId: 'bob', userId: 'bob', status: 'in-call', targetUserIds: ['alice'] }));
        await eventually(async () => (await a.calls.getCall(callId))?.participantClientIds.includes(returned.id) === true);
        expect((await a.calls.getCall(callId))?.participantClientIds.sort()).toEqual([alice.id, returned.id].sort());
        expect(ended).toEqual([]);
    });

    it('fences a disconnected peer transport permanently even while command leases remain available', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        expect(b.router.isReady()).toBe(true);
        b.unavailable();
        expect(b.router.isReady()).toBe(false);
        expect(await b.router.sendToClient(bob.id, { type: 'test', id: 'retired-transport' })).toBe(false);
        expect(await a.router.sendToClient(bob.id, { type: 'test', id: 'retired-destination' })).toBe(false);
        await delay(350);
        expect(b.router.isReady()).toBe(false);
        expect(bob.frames.some(frame => /^retired-/.test(frame.id ?? ''))).toBe(false);
    });

    it('routes a server-originated notification across nodes and excludes revoked recipients from its receipt count', async () => {
        const a = await boot('a'), b = await boot('b'), bob = await connect(b, 'bob');
        const service = a.handle.services.notification as unknown as NotificationService;
        const delivered = await service.notifyUser('bob', { type: 'message', title: 'Peer notification' });
        expect(delivered.delivered).toBe(1);
        await eventually(() => bob.frames.some(frame => frame.type === 'notification:new'));
        authorities.set('bob', { epoch: 1, org: 'orgiq' });
        const refused = await service.notifyUser('bob', { type: 'message', title: 'Revoked notification' });
        expect(refused.delivered).toBe(0);
    });
});
