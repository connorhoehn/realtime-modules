// realtime-modules/test/activity/ActivityService.test.ts
//
// Adapted from gateway/test/activity-service{,-errors,-edge-branches}.test.js.
// The gateway tests use a positional ctor (router, logger, metrics, redis,
// dynamo); this file targets the options-bag ctor and the new
// ActivityHistoryStore abstraction. Behaviour-level assertions are
// preserved verbatim — what changed is the wiring (and the event-catalog +
// inline-Redis branches that LEFT the lifted module entirely).
//
// Goal: pin the lifted handler logic — subscribe/unsubscribe validation,
// publish enrichment + history persistence + local-fallback broadcast,
// getHistory with and without a populated store, onClientConnect
// auto-subscribe, handleDisconnect cleanup, edge-branch error paths,
// getStats.

import {
    ActivityService,
    InMemoryActivityHistoryStore,
    type ActivityHistoryStore,
    type ActivityLogger,
    type ActivityMessageRouter,
    type ActivityEvent,
} from '../../src/activity';
import { ActivityManifest } from '../../src/activity/manifest';

// ---- Fixtures -----------------------------------------------------------

class NoopLogger implements ActivityLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

class SpyLogger implements ActivityLogger {
    debugs: any[][] = [];
    infos: any[][] = [];
    warns: any[][] = [];
    errors: any[][] = [];
    debug(...a: any[]): void { this.debugs.push(a); }
    info(...a: any[]): void { this.infos.push(a); }
    warn(...a: any[]): void { this.warns.push(a); }
    error(...a: any[]): void { this.errors.push(a); }
}

class MockRouter implements ActivityMessageRouter {
    sent: Array<{ clientId: string; message: any }> = [];
    subscribed: Array<{ clientId: string; channel: string }> = [];
    unsubscribed: Array<{ clientId: string; channel: string }> = [];
    channelSends: Array<{ channel: string; message: any }> = [];
    clientData: Record<string, any> = {};

    sendToClient(clientId: string, message: any): void {
        this.sent.push({ clientId, message });
    }
    async subscribeToChannel(clientId: string, channel: string): Promise<void> {
        this.subscribed.push({ clientId, channel });
    }
    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        this.unsubscribed.push({ clientId, channel });
    }
    async sendToChannel(channel: string, message: any): Promise<void> {
        this.channelSends.push({ channel, message });
    }
    getClientData(clientId: string): any {
        return this.clientData[clientId] || null;
    }
}

function findSent(router: MockRouter, predicate: (m: any) => boolean): any {
    return router.sent.find((s) => predicate(s.message))?.message;
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

interface MakeOpts {
    router?: MockRouter | null;
    logger?: ActivityLogger;
    historyStore?: ActivityHistoryStore;
}

function makeService(opts: MakeOpts = {}) {
    const router = opts.router === null ? null : (opts.router ?? new MockRouter());
    const logger = opts.logger ?? new NoopLogger();
    const svc = new ActivityService({
        messageRouter: router,
        logger,
        historyStore: opts.historyStore,
    });
    return { svc, router, logger };
}

// ---- Constructor --------------------------------------------------------

describe('ActivityService — constructor', () => {
    test('throws without logger', () => {
        expect(() => new ActivityService({ messageRouter: new MockRouter(), logger: undefined as any }))
            .toThrow(/logger is required/);
    });

    test('defaults historyStore to InMemoryActivityHistoryStore', () => {
        const { svc } = makeService();
        expect(svc.historyStore).toBeInstanceOf(InMemoryActivityHistoryStore);
    });

    test('uses provided historyStore when supplied', () => {
        const store = new InMemoryActivityHistoryStore();
        const { svc } = makeService({ historyStore: store });
        expect(svc.historyStore).toBe(store);
    });

    test('accepts null messageRouter (local-only mode)', () => {
        const svc = new ActivityService({ messageRouter: null, logger: new NoopLogger() });
        expect(svc.messageRouter).toBeNull();
    });

    test('defaults metricsCollector to null', () => {
        const { svc } = makeService();
        expect(svc.metricsCollector).toBeNull();
    });
});

// ---- subscribe ----------------------------------------------------------

describe('ActivityService — subscribe', () => {
    test('missing channelId returns error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'subscribe', {});
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/channelId is required/i);
    });

    test('channelId over 100 chars returns error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'subscribe', { channelId: 'x'.repeat(101) });
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/channelId is required/i);
    });

    test('valid channelId sends subscribed ack and registers with router', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'subscribe', { channelId: 'activity:u1' });
        expect(router!.subscribed.find((s) => s.channel === 'activity:u1')).toBeDefined();
        const ack = findSent(router!, (m) => m.type === 'activity' && m.action === 'subscribed');
        expect(ack).toBeDefined();
        expect(ack.channelId).toBe('activity:u1');
    });

    test('valid subscribe tracks channel in clientChannels', async () => {
        const { svc } = makeService();
        await svc.handleAction('c1', 'subscribe', { channelId: 'activity:u1' });
        expect(svc.clientChannels.get('c1')?.has('activity:u1')).toBe(true);
    });
});

// ---- unsubscribe --------------------------------------------------------

describe('ActivityService — unsubscribe', () => {
    test('missing channelId returns error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'unsubscribe', {});
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/channelId is required/i);
    });

    test('valid unsubscribe removes tracking and sends ack', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'subscribe', { channelId: 'activity:u1' });
        router!.sent = [];
        await svc.handleAction('c1', 'unsubscribe', { channelId: 'activity:u1' });
        expect(svc.clientChannels.has('c1')).toBe(false);
        const ack = findSent(router!, (m) => m.type === 'activity' && m.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(ack.channelId).toBe('activity:u1');
        expect(router!.unsubscribed.find((s) => s.channel === 'activity:u1')).toBeDefined();
    });

    test('handles unsubscribe gracefully when client was never tracked locally', async () => {
        const { svc, router } = makeService();
        await svc.handleUnsubscribe('never-tracked', { channelId: 'ch' });
        const ack = findSent(router!, (m) => m.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(svc.clientChannels.has('never-tracked')).toBe(false);
    });

    test('keeps client entry when other channel subscriptions remain', async () => {
        const { svc } = makeService();
        await svc.handleSubscribe('c1', { channelId: 'ch-a' });
        await svc.handleSubscribe('c1', { channelId: 'ch-b' });
        await svc.handleUnsubscribe('c1', { channelId: 'ch-a' });
        expect(svc.clientChannels.has('c1')).toBe(true);
        const remaining = svc.clientChannels.get('c1');
        expect(remaining!.size).toBe(1);
        expect(remaining!.has('ch-b')).toBe(true);
    });
});

// ---- publish ------------------------------------------------------------

describe('ActivityService — publish', () => {
    test('missing event returns error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'publish', {});
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/event object is required/i);
    });

    test('missing event.eventType returns error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'publish', { event: {} });
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/event\.eventType is required/i);
    });

    test('valid publish broadcasts to activity:broadcast and sends published ack', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'publish', {
            event: { eventType: 'user.joined', detail: { roomId: 'r1' } },
        });

        expect(router!.channelSends).toHaveLength(1);
        expect(router!.channelSends[0].channel).toBe('activity:broadcast');
        expect(router!.channelSends[0].message.type).toBe('activity:event');
        expect(router!.channelSends[0].message.payload.eventType).toBe('user.joined');

        const ack = findSent(router!, (m) => m.type === 'activity' && m.action === 'published');
        expect(ack).toBeDefined();
        expect(ack.eventType).toBe('user.joined');
    });

    test('publish enriches payload with userId from client data', async () => {
        const { svc, router } = makeService();
        router!.clientData['c1'] = { userContext: { userId: 'u-42', displayName: 'Alice' } };
        await svc.handleAction('c1', 'publish', { event: { eventType: 'ping' } });
        const payload = router!.channelSends[0].message.payload;
        expect(payload.userId).toBe('u-42');
        expect(payload.displayName).toBe('Alice');
    });

    test('publish enriches displayName via metadata fallback chain', async () => {
        const { svc, router } = makeService();
        router!.clientData['c1'] = {
            metadata: { displayName: 'MetaName' },
            userContext: { userId: 'u-1', displayName: 'UserCtxName' },
        };
        await svc.handleAction('c1', 'publish', { event: { eventType: 'ping' } });
        expect(router!.channelSends[0].message.payload.displayName).toBe('MetaName');
    });

    test('publish falls back to userId then anonymous when no displayName present', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'publish', { event: { eventType: 'ping' } });
        expect(router!.channelSends[0].message.payload.displayName).toBe('anonymous');
        expect(router!.channelSends[0].message.payload.userId).toBeNull();
    });

    test('publish persists to historyStore', async () => {
        const store = new InMemoryActivityHistoryStore();
        const { svc } = makeService({ historyStore: store });
        await svc.handleAction('c1', 'publish', { event: { eventType: 'ping' } });
        await new Promise((r) => setTimeout(r, 10));
        const items = await store.list(ActivityService.BROADCAST_CHANNEL, 10);
        expect(items).toHaveLength(1);
        expect(items[0].eventType).toBe('ping');
    });

    test('publish swallows historyStore append failure and still acks client', async () => {
        const throwingStore: ActivityHistoryStore = {
            append: jest.fn().mockRejectedValue(new Error('store-down')),
            list: jest.fn().mockResolvedValue([]),
        };
        const logger = new SpyLogger();
        const { svc, router } = makeService({ historyStore: throwingStore, logger });
        await svc.handleAction('c1', 'publish', { event: { eventType: 'ping' } });
        await new Promise((r) => setImmediate(r));
        const ack = findSent(router!, (m) => m.action === 'published');
        expect(ack).toBeDefined();
        const errs = sentTo(router!, 'c1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(0);
        // Logger captured the failure.
        const log = logger.errors.find((args) => args[0] === 'Failed to persist activity event');
        expect(log).toBeTruthy();
    });

    test('falls through to local-broadcast path when messageRouter is null', async () => {
        const logger = new SpyLogger();
        const svc = new ActivityService({ messageRouter: null, logger });
        // Pre-register a local subscriber so _broadcastToLocalSubscribers has work to do.
        svc.clientChannels.set('listener-1', new Set([ActivityService.BROADCAST_CHANNEL]));
        await svc.handlePublish('publisher-1', { event: { eventType: 'demo' } });
        expect(
            logger.infos.some((args) => args[0] === 'Client published activity event'),
        ).toBe(true);
    });
});

// ---- getHistory ---------------------------------------------------------

describe('ActivityService — getHistory', () => {
    test('empty store returns empty events array', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'getHistory', {});
        const frame = findSent(router!, (m) => m.type === 'activity' && m.action === 'history');
        expect(frame).toBeDefined();
        expect(frame.events).toEqual([]);
    });

    test('returns persisted events from store on broadcast channel', async () => {
        const store = new InMemoryActivityHistoryStore();
        const event: ActivityEvent = {
            eventType: 'user.joined',
            detail: {},
            timestamp: new Date().toISOString(),
            userId: null,
            displayName: 'anon',
        };
        await store.append(ActivityService.BROADCAST_CHANNEL, event);
        const { svc, router } = makeService({ historyStore: store });
        await svc.handleAction('c1', 'getHistory', {});
        const frame = findSent(router!, (m) => m.type === 'activity' && m.action === 'history');
        expect(frame.events).toHaveLength(1);
        expect(frame.events[0].eventType).toBe('user.joined');
    });

    test('returns events for a specific channelId', async () => {
        const store = new InMemoryActivityHistoryStore();
        const event: ActivityEvent = {
            eventType: 'test',
            detail: {},
            timestamp: new Date().toISOString(),
            userId: null,
            displayName: 'anon',
        };
        await store.append('activity:u1', event);
        const { svc, router } = makeService({ historyStore: store });
        await svc.handleAction('c1', 'getHistory', { channelId: 'activity:u1' });
        const frame = findSent(router!, (m) => m.action === 'history');
        expect(frame.channelId).toBe('activity:u1');
        expect(frame.events[0].eventType).toBe('test');
    });

    test('sends empty history when historyStore.list throws', async () => {
        const throwingStore: ActivityHistoryStore = {
            append: jest.fn().mockResolvedValue(undefined),
            list: jest.fn().mockRejectedValue(new Error('store-error')),
        };
        const logger = new SpyLogger();
        const { svc, router } = makeService({ historyStore: throwingStore, logger });
        await svc.handleGetHistory('c1', {});
        const frame = sentTo(router!, 'c1').find((m) => m.action === 'history');
        expect(frame).toBeTruthy();
        expect(frame.events).toEqual([]);
        expect(logger.errors.length).toBeGreaterThan(0);
    });
});

// ---- onClientConnect / handleDisconnect ---------------------------------

describe('ActivityService — connect and disconnect', () => {
    test('onClientConnect auto-subscribes to activity:broadcast', async () => {
        const { svc, router } = makeService();
        await svc.onClientConnect('c1');
        expect(router!.subscribed.find((s) => s.channel === 'activity:broadcast')).toBeDefined();
        expect(svc.clientChannels.get('c1')?.has('activity:broadcast')).toBe(true);
    });

    test('onClientConnect logs errorMessage when subscribe throws Error', async () => {
        const router = new MockRouter();
        router.subscribeToChannel = async () => { throw new Error('subscribe-fail'); };
        const logger = new SpyLogger();
        const { svc } = makeService({ router, logger });
        await svc.onClientConnect('c1');
        const log = logger.errors.find(
            (args) => args[0] === 'Failed to auto-subscribe client to broadcast channel',
        );
        expect(log).toBeTruthy();
        expect(log![1].errorMessage).toBe('subscribe-fail');
    });

    test('onClientConnect tolerates falsy thrown values', async () => {
        const router = new MockRouter();
        router.subscribeToChannel = async () => { throw null; };
        const logger = new SpyLogger();
        const { svc } = makeService({ router, logger });
        await svc.onClientConnect('c1');
        const log = logger.errors.find(
            (args) => args[0] === 'Failed to auto-subscribe client to broadcast channel',
        );
        expect(log).toBeTruthy();
        expect(log![1].errorMessage).toBeFalsy();
    });

    test('handleDisconnect unsubscribes all channels and removes tracking', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'subscribe', { channelId: 'activity:u1' });
        await svc.handleAction('c1', 'subscribe', { channelId: 'activity:broadcast' });
        await svc.handleDisconnect('c1');
        expect(svc.clientChannels.has('c1')).toBe(false);
        expect(router!.unsubscribed).toHaveLength(2);
    });

    test('handleDisconnect tolerates client never tracked locally', async () => {
        const { svc, router } = makeService();
        await svc.handleDisconnect('never-tracked');
        expect(router!.unsubscribed).toHaveLength(0);
    });

    test('handleDisconnect logs errorMessage when unsubscribe throws Error', async () => {
        const router = new MockRouter();
        const logger = new SpyLogger();
        const { svc } = makeService({ router, logger });
        await svc.handleSubscribe('c1', { channelId: 'ch' });
        router.unsubscribeFromChannel = async () => { throw new Error('unsub-fail'); };
        await svc.handleDisconnect('c1');
        const log = logger.errors.find(
            (args) => args[0] === 'Error unsubscribing client from activity channel',
        );
        expect(log).toBeTruthy();
        expect(log![1].errorMessage).toBe('unsub-fail');
        expect(svc.clientChannels.has('c1')).toBe(false);
    });
});

// ---- _broadcastToLocalSubscribers --------------------------------------

describe('ActivityService — _broadcastToLocalSubscribers', () => {
    test('delivers to subscribers of channel and skips others', () => {
        const { svc, router } = makeService();
        svc.clientChannels.set('with-ch', new Set(['target']));
        svc.clientChannels.set('without-ch', new Set(['other']));
        svc._broadcastToLocalSubscribers('target', { type: 'x' });
        expect(router!.sent.map((s) => s.clientId)).toEqual(['with-ch']);
    });
});

// ---- handleAction outer catch ------------------------------------------

describe('ActivityService — handleAction outer catch', () => {
    test('logs error with errorMessage when handler throws an Error', async () => {
        const router = new MockRouter();
        router.subscribeToChannel = async () => { throw new Error('boom'); };
        const logger = new SpyLogger();
        const { svc } = makeService({ router, logger });
        await svc.handleAction('c1', 'subscribe', { channelId: 'ch' });
        const log = logger.errors.find((args) => args[0] === 'Error handling activity action');
        expect(log).toBeTruthy();
        expect(log![1].errorMessage).toBe('boom');
        const errorFrame = router.sent.find((s) => s.message.type === 'error');
        expect(errorFrame).toBeTruthy();
    });

    test('logs error with no errorMessage when handler throws a falsy value', async () => {
        const router = new MockRouter();
        router.subscribeToChannel = async () => { throw null; };
        const logger = new SpyLogger();
        const { svc } = makeService({ router, logger });
        await svc.handleAction('c1', 'subscribe', { channelId: 'ch' });
        const log = logger.errors.find((args) => args[0] === 'Error handling activity action');
        expect(log).toBeTruthy();
        expect(log![1].errorMessage).toBeFalsy();
    });
});

// ---- unknown action ----------------------------------------------------

describe('ActivityService — unknown action', () => {
    test('returns error for unrecognised action', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'explode', {});
        const err = findSent(router!, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toMatch(/unknown activity action.*explode/i);
    });
});

// ---- sendToClient null-router fallback ---------------------------------

describe('ActivityService — sendToClient with null messageRouter', () => {
    test('is a no-op when messageRouter is null', () => {
        const svc = new ActivityService({ messageRouter: null, logger: new NoopLogger() });
        expect(() => svc.sendToClient('c1', { type: 'noop' })).not.toThrow();
    });
});

// ---- getStats ----------------------------------------------------------

describe('ActivityService — getStats', () => {
    test('returns zero counts when no clients have subscribed', () => {
        const { svc } = makeService();
        const stats = svc.getStats();
        expect(stats.subscribedClients).toBe(0);
        expect(stats.totalSubscriptions).toBe(0);
    });

    test('subscribedClients counts distinct clients after subscribe', async () => {
        const { svc } = makeService();
        await svc.handleSubscribe('c1', { channelId: 'ch-1' });
        await svc.handleSubscribe('c2', { channelId: 'ch-1' });
        expect(svc.getStats().subscribedClients).toBe(2);
    });

    test('totalSubscriptions sums all subscriptions across clients', async () => {
        const { svc } = makeService();
        await svc.handleSubscribe('c1', { channelId: 'ch-a' });
        await svc.handleSubscribe('c1', { channelId: 'ch-b' });
        await svc.handleSubscribe('c2', { channelId: 'ch-a' });
        expect(svc.getStats().totalSubscriptions).toBe(3);
    });

    test('counts drop to zero after all clients disconnect', async () => {
        const { svc } = makeService();
        await svc.handleSubscribe('c1', { channelId: 'ch-a' });
        await svc.handleDisconnect('c1');
        expect(svc.getStats().subscribedClients).toBe(0);
        expect(svc.getStats().totalSubscriptions).toBe(0);
    });
});

// ---- InMemoryActivityHistoryStore --------------------------------------

describe('InMemoryActivityHistoryStore', () => {
    test('list returns empty for unknown channel', async () => {
        const store = new InMemoryActivityHistoryStore();
        expect(await store.list('nope', 10)).toEqual([]);
    });

    test('appended events are returned newest-first', async () => {
        const store = new InMemoryActivityHistoryStore();
        const e1: ActivityEvent = { eventType: 'a', detail: {}, timestamp: 't1', userId: null, displayName: 'x' };
        const e2: ActivityEvent = { eventType: 'b', detail: {}, timestamp: 't2', userId: null, displayName: 'x' };
        await store.append('ch', e1);
        await store.append('ch', e2);
        const items = await store.list('ch', 10);
        expect(items.map((e) => e.eventType)).toEqual(['b', 'a']);
    });

    test('caps to maxItems', async () => {
        const store = new InMemoryActivityHistoryStore(2);
        for (let i = 0; i < 5; i++) {
            await store.append('ch', {
                eventType: `e${i}`, detail: {}, timestamp: String(i), userId: null, displayName: 'x',
            });
        }
        const items = await store.list('ch', 10);
        expect(items).toHaveLength(2);
        expect(items.map((e) => e.eventType)).toEqual(['e4', 'e3']);
    });

    test('list respects limit', async () => {
        const store = new InMemoryActivityHistoryStore();
        for (let i = 0; i < 3; i++) {
            await store.append('ch', {
                eventType: `e${i}`, detail: {}, timestamp: String(i), userId: null, displayName: 'x',
            });
        }
        expect(await store.list('ch', 2)).toHaveLength(2);
    });

    test('detail is defensively copied on append+list', async () => {
        const store = new InMemoryActivityHistoryStore();
        const detail = { mutable: 'original' };
        await store.append('ch', { eventType: 'a', detail, timestamp: 't', userId: null, displayName: 'x' });
        detail.mutable = 'changed-after-append';
        const items = await store.list('ch', 1);
        expect((items[0].detail as any).mutable).toBe('original');
        (items[0].detail as any).mutable = 'changed-by-caller';
        const second = await store.list('ch', 1);
        expect((second[0].detail as any).mutable).toBe('original');
    });

    test('_reset clears everything', async () => {
        const store = new InMemoryActivityHistoryStore();
        await store.append('ch', { eventType: 'a', detail: {}, timestamp: 't', userId: null, displayName: 'x' });
        store._reset();
        expect(await store.list('ch', 10)).toEqual([]);
    });
});

// ---- Manifest ----------------------------------------------------------

describe('ActivityManifest', () => {
    test('declares name + channels', () => {
        expect(ActivityManifest.name).toBe('activity');
        expect(ActivityManifest.channels).toEqual(['activity:*']);
    });
});
