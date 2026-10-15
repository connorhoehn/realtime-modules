// RedisRealtimeRouter on distributed-core's fenced lease (0.117). These run on
// an in-memory Redis by default; test/server/redis-router.integration.test.ts
// holds the native-Redis acceptance (REAL_ROUTER_REDIS=1).
import { LeaseGroup, ReadinessGate, BoundedRedis, type FenceEvent } from 'distributed-core/cluster/leases';
import { RedisRealtimeRouter, type RedisRealtimeRouterOptions, type RealtimeMembershipInvalidation, type RealtimeClusterRedis } from '../../src/server';
import type { WsAuthContext } from '../../src/server-ws/types';
import { FakeClusterRedis, isRenew, isAcquire } from './helpers/fakeClusterRedis';

const LEASE = 600; // renews every 200 ms
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean | Promise<boolean>, ms = 2000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await predicate()) return; await delay(10); }
    throw new Error('condition did not become true');
}

type Node = { router: RedisRealtimeRouter; port: ReturnType<FakeClusterRedis['port']>; clients: Map<string, WsAuthContext>;
    inbox: Array<{ clientId: string; frame: any }> };
let routers: RedisRealtimeRouter[] = [];
afterEach(async () => { for (const router of routers.splice(0)) await router.shutdown(); });

function node(redis: FakeClusterRedis, nodeId: string, extra: Partial<RedisRealtimeRouterOptions> = {}, port = redis.port()): Node {
    const clients = new Map<string, WsAuthContext>();
    const inbox: Node['inbox'] = [];
    const router = new RedisRealtimeRouter({ redis: port, namespace: 'ns', nodeId, leaseMs: LEASE, requestTimeoutMs: 150, ...extra });
    router._setHandle({ wss: null, dispose: async () => undefined, listClients: () => [...clients.keys()],
        getClientContext: id => clients.get(id) ?? null,
        sendToClient: (clientId, frame) => { if (!clients.has(clientId)) return false; inbox.push({ clientId, frame }); return true; } });
    routers.push(router);
    return { router, port, clients, inbox };
}
async function connect(n: Node, clientId: string, userId: string) {
    const ctx = { userId } as WsAuthContext;
    n.clients.set(clientId, ctx);
    await n.router.onClientConnect(clientId, ctx);
    return ctx;
}
const key = (kind: string, id: string) => `realtime:ns:${kind}:${id}`;

describe('RedisRealtimeRouter — ownership lease (distributed-core FencedLease)', () => {
    it('claims the node key for its boot instance with a monotonic fencing token, and refuses a second live owner', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a');
        await a.router.start();
        expect(redis.get(key('node', 'a'))).toBe(a.router.instance);
        expect(a.router.fencingToken).toBe(1);
        expect(a.router.isReady()).toBe(true);
        const duplicate = node(redis, 'a');
        await expect(duplicate.router.start()).rejects.toThrow('Cluster nodeId already has a live owner');
        expect(redis.get(key('node', 'a'))).toBe(a.router.instance);
        await a.router.shutdown();
        expect(redis.get(key('node', 'a'))).toBeNull();
        const restarted = node(redis, 'a');
        await restarted.router.start();
        // One never-expiring counter per namespace, strictly increasing.
        expect(restarted.router.fencingToken).toBe(2);
        expect(redis.pttl('realtime:ns:lease-fence')).toBe(-1);
    });

    it('renews client registrations and their user index as attached keys, only while each still holds its registration', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a'), b = node(redis, 'b');
        await a.router.start(); await b.router.start();
        await connect(b, 'c1', 'bob');
        await connect(b, 'c2', 'bob');
        // Another writer replaced c2's registration value: it must not be renewed.
        await redis.command('SET', key('client', 'c2'), 'foreign', 'PX', String(LEASE));
        await delay(LEASE * 2);
        expect(redis.get(key('client', 'c1'))).not.toBeNull();
        expect(redis.pttl(key('client', 'c1'))).toBeGreaterThan(LEASE / 3);
        expect(redis.pttl(key('user', 'bob'))).toBeGreaterThan(LEASE);
        expect(redis.get(key('client', 'c2'))).toBeNull();
        expect(await a.router.isClientAlive('c1')).toBe(true);
        expect(await a.router.sendToClient('c1', { id: 'after-renewals' })).toBe(true);
        expect(b.inbox.map(entry => entry.frame.id)).toEqual(['after-renewals']);
    });

    it('stops renewing a registration whose socket context was replaced', async () => {
        const redis = new FakeClusterRedis();
        const b = node(redis, 'b');
        await b.router.start();
        await connect(b, 'c1', 'bob');
        b.clients.set('c1', { userId: 'bob' } as WsAuthContext); // new context object, same id
        await delay(LEASE * 1.5);
        expect(redis.get(key('client', 'c1'))).toBeNull();
    });

    it('keeps an expired lease fenced after a late successful renewal reply', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a');
        const events: FenceEvent[] = [];
        a.router.onFence(event => events.push(event));
        await a.router.start();
        await connect(a, 'c1', 'alice');
        const held = redis.hold(isRenew); // Redis commits the renewal; the reply is held
        await held.reached;
        await eventually(() => !a.router.isReady());
        expect(events.map(event => event.reason)).toEqual(['expired']);
        held.release();
        await delay(LEASE);
        expect(a.router.isReady()).toBe(false);
        expect(a.router.isClientLive('c1')).toBe(false);
        expect(await a.router.sendToClient('c1', { id: 'late' })).toBe(false);
        expect(a.inbox).toEqual([]);
    });

    it('fences permanently on connection loss even while command renewals still succeed', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a'), b = node(redis, 'b');
        await a.router.start(); await b.router.start();
        await connect(b, 'c1', 'bob');
        const reasons: string[] = [];
        b.router.onFence(event => reasons.push(event.reason));
        b.port.lose();
        expect(b.router.isReady()).toBe(false);
        expect(reasons).toEqual(['unavailable']);
        expect(await b.router.sendToClient('c1', { id: 'retired-transport' })).toBe(false);
        await delay(LEASE * 1.5);
        expect(b.router.isReady()).toBe(false);
        // No longer renewed: peers stop treating its connections as alive.
        expect(await a.router.isClientAlive('c1')).toBe(false);
        expect(b.inbox).toEqual([]);
    });

    it('checks a peer owner with FencedLease.isHeldBy: a lost or replaced owner key refuses its connections', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a'), b = node(redis, 'b');
        await a.router.start(); await b.router.start();
        await connect(b, 'c1', 'bob');
        expect(await a.router.isClientAlive('c1')).toBe(true);
        redis.del(key('node', 'b'));
        expect(await a.router.isClientAlive('c1')).toBe(false);
        // The owner itself fences on its next renewal (refused), never revives.
        await eventually(() => !b.router.isReady());
        expect(b.router.lease.isFenced()).toBe(true);
    });

    it('keeps register/remove guarded by the lease owner after a fence', async () => {
        const redis = new FakeClusterRedis();
        const b = node(redis, 'b');
        await b.router.start();
        b.port.lose();
        b.clients.set('c9', { userId: 'bob' } as WsAuthContext);
        await expect(b.router.onClientConnect('c9', b.clients.get('c9')!)).rejects.toThrow(/not ready/);
        expect(redis.get(key('client', 'c9'))).toBeNull();
    });

    it('renews during a slow startup, but fails start (and owns nothing) when the lease lapses before it is ready', async () => {
        const redis = new FakeClusterRedis();
        const slowPort = () => {
            const base = redis.port();
            return { ...base, subscribe: async (topic: string, receive: (payload: string) => void) => {
                await delay(LEASE / 2); return base.subscribe(topic, receive);
            } };
        };
        // 5 subscriptions x LEASE/2: longer than one lease, kept alive by renewals.
        const slow = node(redis, 'slow', {}, slowPort() as never);
        await slow.router.start();
        expect(slow.router.isReady()).toBe(true);
        // Same startup with renewal replies withheld: the lease lapses first.
        const stalled = node(redis, 'stalled', {}, slowPort() as never);
        const held = redis.hold(args => isRenew(args) && args.includes(key('node', 'stalled')));
        await expect(stalled.router.start()).rejects.toThrow(/lease/);
        expect(stalled.router.isReady()).toBe(false);
        held.release();
    });
});

describe('RedisRealtimeRouter — LeaseGroup and ReadinessGate', () => {
    it('one router fencing retires its sibling: the sibling fences (sibling) and its node key is released at once', async () => {
        const redis = new FakeClusterRedis();
        const group = new LeaseGroup();
        const ws = node(redis, 'ws', { leaseGroup: group, namespace: 'ns' });
        const cookie = node(redis, 'cookie', { leaseGroup: group, namespace: 'ns' });
        const peer = node(redis, 'peer');
        await ws.router.start(); await cookie.router.start(); await peer.router.start();
        await connect(cookie, 'c1', 'bob');
        expect(group.isLive()).toBe(true);
        const reasons: string[] = [];
        cookie.router.onFence(event => reasons.push(event.reason));
        ws.port.lose();
        expect(ws.router.isReady()).toBe(false);
        expect(cookie.router.isReady()).toBe(false);
        expect(reasons).toEqual(['sibling']);
        expect(group.isLive()).toBe(false);
        await group.retired;
        // The sibling handed its key back (compare-and-delete); the first to fence lets its own expire.
        expect(redis.get(key('node', 'cookie'))).toBeNull();
        expect(redis.get(key('node', 'ws'))).toBe(ws.router.instance);
        expect(await peer.router.isClientAlive('c1')).toBe(false);
        expect(await cookie.router.sendToClient('c1', { id: 'half-fenced' })).toBe(false);
        expect(cookie.inbox).toEqual([]);
    });

    it('a router joining a retired group fails start and leaves no owner key', async () => {
        const redis = new FakeClusterRedis();
        const group = new LeaseGroup();
        const first = node(redis, 'first', { leaseGroup: group });
        await first.router.start();
        first.router.lease.fence('manual', 'host fenced');
        const late = node(redis, 'late', { leaseGroup: group });
        await expect(late.router.start()).rejects.toThrow(/not live/);
        expect(late.router.isReady()).toBe(false);
        await eventually(() => redis.get(key('node', 'late')) === null);
    });

    it('a deliberate shutdown leaves the group without retiring its sibling', async () => {
        const redis = new FakeClusterRedis();
        const group = new LeaseGroup();
        const a = node(redis, 'a', { leaseGroup: group }), b = node(redis, 'b', { leaseGroup: group });
        await a.router.start(); await b.router.start();
        await a.router.shutdown();
        expect(b.router.isReady()).toBe(true);
        expect(group.isLive()).toBe(true);
        expect(redis.get(key('node', 'a'))).toBeNull();
        b.port.lose(); // a later fence still retires what remains
        expect(group.isLive()).toBe(false);
    });

    it('feeds a ReadinessGate: ready only after every router is live and the listener is up; 503 the moment one fences', async () => {
        const redis = new FakeClusterRedis();
        const group = new LeaseGroup();
        const ws = node(redis, 'ws', { leaseGroup: group }), cookie = node(redis, 'cookie', { leaseGroup: group });
        const gate = new ReadinessGate();
        gate.addOwner('ws', ws.router); gate.addOwner('realtime', cookie.router);
        expect(gate.isReady()).toBe(false);
        await ws.router.start();
        gate.setListening(true);
        expect(gate.snapshot()).toMatchObject({ ready: false, notLive: ['realtime'] });
        await cookie.router.start();
        expect(gate.isReady()).toBe(true);
        const stall = redis.hold(args => isRenew(args) && args.includes(key('node', 'cookie')));
        await stall.reached;
        await eventually(() => !gate.isReady());
        expect(gate.snapshot().fenced).toMatchObject({ owner: 'realtime', reason: 'expired' });
        expect(ws.router.isReady()).toBe(false); // retired with it, not half-fenced
        stall.release();
        await delay(LEASE);
        expect(gate.isReady()).toBe(false); // latched: late recovery does not revive
    });
});

describe('RedisRealtimeRouter — over distributed-core BoundedRedis', () => {
    function bounded(redis: FakeClusterRedis, stall: { command?: (args: string[]) => boolean; publish?: boolean }) {
        const made: Array<ReturnType<FakeClusterRedis['rawConnection']>> = [];
        const port = new BoundedRedis(null, { timeoutMs: 150, createConnection: role => {
            const conn = redis.rawConnection(role === 'command' ? { command: stall.command } : role === 'publisher' ? { publish: stall.publish } : {});
            made.push(conn); return conn;
        } });
        return { port, made };
    }

    it('a stalled renewal reply is bounded: the command connection is destroyed and the router fences for good', async () => {
        const redis = new FakeClusterRedis();
        let stallRenew = false;
        const { port, made } = bounded(redis, { command: args => stallRenew && isRenew(args) });
        await port.open();
        const a = node(redis, 'a', {}, port as unknown as ReturnType<FakeClusterRedis['port']>);
        const typed: RealtimeClusterRedis = port; void typed; // BoundedRedis satisfies the port as-is
        await a.router.start();
        stallRenew = true;
        await eventually(() => !a.router.isReady());
        expect(made[0].destroyed).toBe(true);
        expect(a.router.lease.isFenced()).toBe(true);
        await port.quit();
    });

    it('a stalled publish reply is bounded independently of renewals and fences the owner', async () => {
        const redis = new FakeClusterRedis();
        const { port, made } = bounded(redis, { publish: true });
        await port.open();
        const a = node(redis, 'a', {}, port as unknown as ReturnType<FakeClusterRedis['port']>), b = node(redis, 'b');
        await a.router.start(); await b.router.start();
        await connect(b, 'c1', 'bob');
        const started = Date.now();
        expect(await a.router.sendToClient('c1', { id: 'stalled' })).toBe(false);
        expect(Date.now() - started).toBeLessThan(LEASE);
        await eventually(() => !a.router.isReady());
        expect(made[1].destroyed).toBe(true);
        expect(b.inbox).toEqual([]);
        await port.quit();
    });

    it('acquire goes through the lease script (SET NX PX plus a fencing token)', async () => {
        const redis = new FakeClusterRedis();
        const a = node(redis, 'a');
        await a.router.start();
        expect(redis.sent.filter(isAcquire)).toHaveLength(1);
        expect(redis.pttl(key('node', 'a'))).toBeGreaterThan(0);
    });
});

describe('RedisRealtimeRouter — membershipStore invalidation', () => {
    function store() {
        const observers = new Set<(channel: string) => void>();
        const invalidated: string[] = [];
        const s: RealtimeMembershipInvalidation & { commit(channel: string): void; invalidated: string[]; observers(): number } = {
            invalidate: channel => { invalidated.push(channel); },
            onCommittedWrite: observer => { observers.add(observer); return () => { observers.delete(observer); }; },
            commit: channel => { for (const o of observers) o(channel); },
            invalidated, observers: () => observers.size,
        };
        return s;
    }

    it('publishes a committed write to peers, which invalidate; the writer does not echo to itself', async () => {
        const redis = new FakeClusterRedis();
        const sa = store(), sb = store();
        const a = node(redis, 'a', { membershipStore: sa }), b = node(redis, 'b', { membershipStore: sb });
        await a.router.start(); await b.router.start();
        sa.commit('social:room-1');
        await eventually(() => sb.invalidated.length === 1);
        expect(sb.invalidated).toEqual(['social:room-1']);
        expect(sa.invalidated).toEqual([]);
    });

    it('refuses malformed, oversized or unaccepted channels and stops on shutdown', async () => {
        const redis = new FakeClusterRedis();
        const sa = store(), sb = store();
        const a = node(redis, 'a', { membershipStore: sa, membershipEventTopic: 'social:membership' });
        const b = node(redis, 'b', { membershipStore: sb, membershipEventTopic: 'social:membership',
            acceptMembershipChannel: channel => channel.startsWith('social:') });
        await a.router.start(); await b.router.start();
        await a.router.peerEvents.publish('social:membership', '{not json');
        await a.router.peerEvents.publish('social:membership', JSON.stringify({ channel: 'social:x' }));
        await a.router.peerEvents.publish('social:membership', JSON.stringify('orgiq:other'));
        sa.commit('social:' + 'x'.repeat(600));
        sa.commit('social:ok');
        await eventually(() => sb.invalidated.length === 1);
        await delay(30);
        expect(sb.invalidated).toEqual(['social:ok']);
        await b.router.shutdown();
        expect(sb.observers()).toBe(0);
    });

    it('a fenced writer publishes nothing', async () => {
        const redis = new FakeClusterRedis();
        const sa = store(), sb = store();
        const a = node(redis, 'a', { membershipStore: sa }), b = node(redis, 'b', { membershipStore: sb });
        await a.router.start(); await b.router.start();
        a.port.lose();
        sa.commit('social:after-fence');
        await delay(50);
        expect(sb.invalidated).toEqual([]);
    });

    it('rejects an invalid membership topic at construction', () => {
        const redis = new FakeClusterRedis();
        expect(() => node(redis, 'a', { membershipStore: store(), membershipEventTopic: 'Bad Topic' })).toThrow(/topic/);
    });
});
