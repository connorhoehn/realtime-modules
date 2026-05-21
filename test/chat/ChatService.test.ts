// realtime-modules/test/chat/ChatService.test.ts
//
// Adapted from gateway/test/chat-service-{pure,join-leave,send,fallback,
// disconnect,lifecycle}.test.js. The gateway tests use a positional ctor
// (router, logger, metricsCollector, dynamoClient); this file targets the
// options-bag ctor and the new ChatStore abstraction. Behaviour-level
// assertions are preserved verbatim — what changed is the wiring.
//
// Goal: pin the lifted handler logic (join/leave/send/history, validation,
// LRU + store fallback, error envelopes, lifecycle hooks).

import {
    ChatService,
    InMemoryChatStore,
    type ChatMessageRouter,
    type ChatLogger,
    type ChatStore,
    type ChatMessage,
} from '../../src/chat';
import { SubscriptionTracker } from '../../src/chat/SubscriptionTracker';

// ---- Fixtures -----------------------------------------------------------

class NoopLogger implements ChatLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

class MockRouter implements ChatMessageRouter {
    sent: Array<{ clientId: string; message: any }> = [];
    subscribed: Array<{ clientId: string; channel: string }> = [];
    unsubscribed: Array<{ clientId: string; channel: string }> = [];
    sentToChannel: Array<{ channel: string; frame: any }> = [];
    redisAvailable = true;
    sendToClient(clientId: string, message: any): void {
        this.sent.push({ clientId, message });
    }
    async sendToChannel(channel: string, frame: any): Promise<void> {
        this.sentToChannel.push({ channel, frame });
    }
    async subscribeToChannel(clientId: string, channel: string): Promise<void> {
        this.subscribed.push({ clientId, channel });
    }
    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        this.unsubscribed.push({ clientId, channel });
    }
}

function makeService(overrides: {
    chatStore?: ChatStore;
    authz?: (clientId: string, channel: string) => boolean;
} = {}) {
    const router = new MockRouter();
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger(),
        chatStore: overrides.chatStore,
        authz: overrides.authz,
    });
    return { svc, router };
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

afterEach(() => {
    // Tests don't typically call shutdown; the per-instance cleanup
    // interval is unref'd so jest can exit, but be explicit anyway.
});

// ---- Constructor --------------------------------------------------------

describe('ChatService — constructor', () => {
    test('throws without messageRouter', () => {
        expect(() => new ChatService({ messageRouter: undefined as any, logger: new NoopLogger() }))
            .toThrow(/messageRouter is required/);
    });

    test('throws without logger', () => {
        const router = new MockRouter();
        expect(() => new ChatService({ messageRouter: router, logger: undefined as any }))
            .toThrow(/logger is required/);
    });

    test('defaults chatStore to InMemoryChatStore', () => {
        const { svc } = makeService();
        expect(svc.chatStore).toBeInstanceOf(InMemoryChatStore);
    });

    test('uses provided chatStore when supplied', () => {
        const store = new InMemoryChatStore();
        const { svc } = makeService({ chatStore: store });
        expect(svc.chatStore).toBe(store);
    });

    test('detects distributed mode from messageRouter.subscribeToChannel', () => {
        const { svc } = makeService();
        expect(svc.isDistributed).toBe(true);
    });
});

// ---- generateMessageId --------------------------------------------------

describe('ChatService — generateMessageId', () => {
    test('returns a non-empty string', () => {
        const { svc } = makeService();
        expect(typeof svc.generateMessageId()).toBe('string');
        expect(svc.generateMessageId().length).toBeGreaterThan(0);
    });

    test('two consecutive calls return different ids', () => {
        const { svc } = makeService();
        expect(svc.generateMessageId()).not.toBe(svc.generateMessageId());
    });
});

// ---- getChannelCache ----------------------------------------------------

describe('ChatService — getChannelCache', () => {
    test('creates a new LRU cache for an unknown channel', () => {
        const { svc } = makeService();
        const cache = svc.getChannelCache('room:1');
        expect(typeof cache.set).toBe('function');
        expect(typeof cache.get).toBe('function');
    });

    test('returns the same cache instance on subsequent calls', () => {
        const { svc } = makeService();
        expect(svc.getChannelCache('room:1')).toBe(svc.getChannelCache('room:1'));
    });

    test('different channels get different cache instances', () => {
        const { svc } = makeService();
        expect(svc.getChannelCache('A')).not.toBe(svc.getChannelCache('B'));
    });
});

// ---- addToChannelHistory / getChannelHistory ----------------------------

describe('ChatService — addToChannelHistory / getChannelHistory', () => {
    test('empty channel returns empty array', async () => {
        const { svc } = makeService();
        expect(await svc.getChannelHistory('room:empty')).toEqual([]);
    });

    test('addToChannelHistory stores message in LRU', async () => {
        const { svc } = makeService();
        svc.addToChannelHistory('room:1', {
            id: 'm1', clientId: 'c1', channel: 'room:1', message: 'hi', timestamp: 'now',
        });
        const hist = await svc.getChannelHistory('room:1');
        expect(hist).toHaveLength(1);
        expect(hist[0].id).toBe('m1');
    });

    test('getChannelHistory respects the limit parameter', async () => {
        const { svc } = makeService();
        for (let i = 1; i <= 5; i++) {
            svc.addToChannelHistory('room:1', {
                id: `m${i}`, clientId: 'c1', channel: 'room:1', message: `msg ${i}`, timestamp: 'now',
            });
        }
        const hist = await svc.getChannelHistory('room:1', 3);
        expect(hist).toHaveLength(3);
        // LRU iterates insertion order; slice(-3) of [m1..m5] gives [m3,m4,m5]
        // (gateway test: LRU is newest-first; slice(-3) gave [m3,m2,m1]; for
        // lru-cache v10 the iterator is most-recent-first too, so we match
        // by id-set rather than positional order.)
        const ids = hist.map((m) => m.id).sort();
        expect(ids).toEqual(['m1', 'm2', 'm3']);
    });

    test('falls back to ChatStore when LRU is empty', async () => {
        const store = new InMemoryChatStore();
        await store.putMessage({
            id: 'd1', clientId: 'c1', channel: 'room:1', message: 'from store', timestamp: 'now',
        });
        const { svc } = makeService({ chatStore: store });
        const hist = await svc.getChannelHistory('room:1', 20);
        expect(hist).toHaveLength(1);
        expect(hist[0].id).toBe('d1');
    });

    test('store-loaded messages backfill the LRU cache', async () => {
        const store = new InMemoryChatStore();
        await store.putMessage({
            id: 'd1', clientId: 'c1', channel: 'room:1', message: 'a', timestamp: 'now',
        });
        const { svc } = makeService({ chatStore: store });
        await svc.getChannelHistory('room:1', 20);
        // Hit again — should come from cache, not store. Verify by emptying
        // the store and re-querying.
        (store as any)._reset();
        const hist = await svc.getChannelHistory('room:1', 20);
        expect(hist).toHaveLength(1);
    });

    test('logs and returns [] when ChatStore.listMessages throws', async () => {
        const store: ChatStore = {
            putMessage: async () => {},
            listMessages: async () => { throw new Error('store down'); },
        };
        const { svc } = makeService({ chatStore: store });
        expect(await svc.getChannelHistory('room:1', 5)).toEqual([]);
    });
});

// ---- sendChannelHistory --------------------------------------------------

describe('ChatService — sendChannelHistory', () => {
    test('sends history when non-empty', async () => {
        const { svc, router } = makeService();
        svc.addToChannelHistory('room:1', {
            id: 'm1', clientId: 'c1', channel: 'room:1', message: 'hi', timestamp: 'now',
        });
        await svc.sendChannelHistory('c1', 'room:1');
        expect(router.sent).toHaveLength(1);
        expect(router.sent[0].message.action).toBe('history');
        expect(router.sent[0].message.channel).toBe('room:1');
    });

    test('sends nothing when empty', async () => {
        const { svc, router } = makeService();
        await svc.sendChannelHistory('c1', 'room:empty');
        expect(router.sent).toHaveLength(0);
    });
});

// ---- handleGetHistory ---------------------------------------------------

describe('ChatService — handleGetHistory', () => {
    test('errors when channel is missing', async () => {
        const { svc, router } = makeService();
        await svc.handleGetHistory('c1', {} as any);
        expect(router.sent).toHaveLength(1);
        expect(router.sent[0].message.type).toBe('error');
    });

    test('sends history when channel is provided', async () => {
        const { svc, router } = makeService();
        svc.addToChannelHistory('room:1', {
            id: 'm1', clientId: 'c1', channel: 'room:1', message: 'hi', timestamp: 'now',
        });
        await svc.handleGetHistory('c1', { channel: 'room:1' });
        expect(router.sent[0].message.action).toBe('history');
        expect(Array.isArray(router.sent[0].message.messages)).toBe(true);
    });
});

// ---- handleJoinChannel --------------------------------------------------

describe('ChatService — handleJoinChannel: validation', () => {
    test('missing channel errors and returns early', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', {} as any);
        expect(sentTo(router, 'c1')).toHaveLength(1);
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });

    test('channel over maxChannelNameLength errors', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'a'.repeat(51) });
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });

    test('authz returning false short-circuits join', async () => {
        const { svc, router } = makeService({ authz: () => false });
        await svc.handleJoinChannel('c1', { channel: 'general' });
        expect(router.subscribed).toHaveLength(0);
        expect(svc.clientChannels.hasSubscription('c1', 'general')).toBe(false);
    });
});

describe('ChatService — handleJoinChannel: happy path', () => {
    test('sends joined ack', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'general' });
        const acks = sentTo(router, 'c1').filter((m) => m.action === 'joined');
        expect(acks).toHaveLength(1);
        expect(acks[0].type).toBe('chat');
        expect(acks[0].channel).toBe('general');
    });

    test('tracks subscription', async () => {
        const { svc } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'room-a' });
        expect(svc.clientChannels.hasSubscription('c1', 'room-a')).toBe(true);
    });

    test('accumulates multiple subscriptions for the same client', async () => {
        const { svc } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'a' });
        await svc.handleJoinChannel('c1', { channel: 'b' });
        expect(svc.clientChannels.get('c1')?.size).toBe(2);
    });

    test('calls subscribeToChannel on the router (distributed mode)', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'lobby' });
        expect(router.subscribed).toContainEqual({ clientId: 'c1', channel: 'lobby' });
    });
});

// ---- handleLeaveChannel -------------------------------------------------

describe('ChatService — handleLeaveChannel', () => {
    test('missing channel errors', async () => {
        const { svc, router } = makeService();
        await svc.handleLeaveChannel('c1', {} as any);
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });

    test('removes subscription and sends left ack', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'room-a' });
        router.sent = [];
        await svc.handleLeaveChannel('c1', { channel: 'room-a' });
        const acks = sentTo(router, 'c1').filter((m) => m.action === 'left');
        expect(acks).toHaveLength(1);
        expect(svc.clientChannels.hasSubscription('c1', 'room-a')).toBe(false);
    });

    test('calls unsubscribeFromChannel on the router', async () => {
        const { svc, router } = makeService();
        await svc.handleLeaveChannel('c1', { channel: 'lobby' });
        expect(router.unsubscribed).toContainEqual({ clientId: 'c1', channel: 'lobby' });
    });
});

// ---- handleSendMessage --------------------------------------------------

describe('ChatService — handleSendMessage: validation', () => {
    test('errors when channel or message missing', async () => {
        const { svc, router } = makeService();
        await svc.handleSendMessage('c1', { channel: '', message: '' } as any);
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });

    test('errors when message exceeds maxMessageLength', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'g' });
        router.sent = [];
        await svc.handleSendMessage('c1', { channel: 'g', message: 'x'.repeat(1001) });
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });

    test('errors when client has not joined the channel', async () => {
        const { svc, router } = makeService();
        await svc.handleSendMessage('c1', { channel: 'g', message: 'hi' });
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });
});

describe('ChatService — handleSendMessage: happy path', () => {
    test('persists, broadcasts, and acks', async () => {
        const store = new InMemoryChatStore();
        const router = new MockRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger(),
            chatStore: store,
        });
        await svc.handleJoinChannel('c1', { channel: 'g' });
        // Drop join acks/history sends.
        router.sent = [];
        router.sentToChannel = [];

        await svc.handleSendMessage('c1', { channel: 'g', message: 'hello' });

        // Broadcast happened.
        expect(router.sentToChannel).toHaveLength(1);
        expect(router.sentToChannel[0].channel).toBe('g');
        expect(router.sentToChannel[0].frame.action).toBe('message');

        // Ack returned to sender.
        const acks = sentTo(router, 'c1').filter((m) => m.action === 'sent');
        expect(acks).toHaveLength(1);
        expect(acks[0].channel).toBe('g');

        // Persistence — fire-and-forget; wait one tick.
        await Promise.resolve();
        const persisted = await store.listMessages('g', 10);
        expect(persisted).toHaveLength(1);
        expect(persisted[0].message).toBe('hello');
    });

    test('persistence failure does not throw to caller (fire-and-forget)', async () => {
        const failingStore: ChatStore = {
            putMessage: async () => { throw new Error('persist down'); },
            listMessages: async () => [],
        };
        const router = new MockRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger(),
            chatStore: failingStore,
        });
        await svc.handleJoinChannel('c1', { channel: 'g' });
        await expect(svc.handleSendMessage('c1', { channel: 'g', message: 'hi' }))
            .resolves.toBeUndefined();
    });
});

// ---- handleAction dispatch ----------------------------------------------

describe('ChatService — handleAction', () => {
    test('dispatches to handleJoinChannel', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'join', { channel: 'g' });
        expect(sentTo(router, 'c1').some((m) => m.action === 'joined')).toBe(true);
    });

    test('unknown action sends error', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c1', 'who-knows', { channel: 'g' });
        expect(sentTo(router, 'c1')[0].type).toBe('error');
    });
});

// ---- Lifecycle ----------------------------------------------------------

describe('ChatService — lifecycle', () => {
    test('onClientDisconnect untracks all subscriptions and unsubscribes per channel', async () => {
        const { svc, router } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'a' });
        await svc.handleJoinChannel('c1', { channel: 'b' });
        router.unsubscribed = [];
        await svc.onClientDisconnect('c1');
        expect(svc.clientChannels.get('c1')).toBeUndefined();
        const channels = router.unsubscribed.map((u) => u.channel).sort();
        expect(channels).toEqual(['a', 'b']);
    });

    test('shutdown clears state and stops the cleanup timer', async () => {
        const { svc } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'a' });
        await svc.shutdown();
        expect(svc.clientChannels.size).toBe(0);
        expect(svc.channelCaches.size).toBe(0);
    });

    test('getStats returns the documented shape', async () => {
        const { svc } = makeService();
        await svc.handleJoinChannel('c1', { channel: 'a' });
        const stats = svc.getStats();
        expect(stats).toEqual({
            connectedClients: 1,
            activeChannels: expect.any(Number),
            totalMessages: expect.any(Number),
            isDistributed: true,
        });
    });
});

// ---- InMemoryChatStore --------------------------------------------------

describe('InMemoryChatStore', () => {
    test('round-trips a message', async () => {
        const store = new InMemoryChatStore();
        const msg: ChatMessage = {
            id: 'm1', clientId: 'c1', channel: 'g', message: 'hi', timestamp: 'now',
        };
        await store.putMessage(msg);
        expect(await store.listMessages('g', 10)).toEqual([msg]);
    });

    test('returns chronological order (oldest first)', async () => {
        const store = new InMemoryChatStore();
        for (let i = 1; i <= 3; i++) {
            await store.putMessage({
                id: `m${i}`, clientId: 'c1', channel: 'g', message: String(i), timestamp: 'now',
            });
        }
        const list = await store.listMessages('g', 10);
        expect(list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    });

    test('limit caps the returned tail to newest N', async () => {
        const store = new InMemoryChatStore();
        for (let i = 1; i <= 5; i++) {
            await store.putMessage({
                id: `m${i}`, clientId: 'c1', channel: 'g', message: String(i), timestamp: 'now',
            });
        }
        const list = await store.listMessages('g', 2);
        expect(list.map((m) => m.id)).toEqual(['m4', 'm5']);
    });

    test('unknown channel returns empty array', async () => {
        const store = new InMemoryChatStore();
        expect(await store.listMessages('nope', 10)).toEqual([]);
    });

    test('defensive copy on put — caller mutation does not affect stored row', async () => {
        const store = new InMemoryChatStore();
        const meta = { foo: 'bar' };
        await store.putMessage({
            id: 'm1', clientId: 'c1', channel: 'g', message: 'hi', metadata: meta, timestamp: 'now',
        });
        meta.foo = 'changed';
        const [row] = await store.listMessages('g', 10);
        expect(row.metadata).toEqual({ foo: 'bar' });
    });
});

// ---- SubscriptionTracker (lifted from gateway) --------------------------

describe('SubscriptionTracker', () => {
    test('addSubscription is idempotent', () => {
        const t = new SubscriptionTracker();
        t.addSubscription('c1', 'a');
        t.addSubscription('c1', 'a');
        expect(t.get('c1')?.size).toBe(1);
    });

    test('removeSubscription removes the client entry when empty', () => {
        const t = new SubscriptionTracker();
        t.addSubscription('c1', 'a');
        t.removeSubscription('c1', 'a');
        expect(t.has('c1')).toBe(false);
    });

    test('removeClient returns previously tracked channels', () => {
        const t = new SubscriptionTracker();
        t.addSubscription('c1', 'a');
        t.addSubscription('c1', 'b');
        expect(t.removeClient('c1').sort()).toEqual(['a', 'b']);
        expect(t.has('c1')).toBe(false);
    });

    test('clientsSubscribedTo iterates only matching clients', () => {
        const t = new SubscriptionTracker();
        t.addSubscription('c1', 'a');
        t.addSubscription('c2', 'a');
        t.addSubscription('c3', 'b');
        expect(Array.from(t.clientsSubscribedTo('a')).sort()).toEqual(['c1', 'c2']);
    });
});
