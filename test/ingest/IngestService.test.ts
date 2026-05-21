// realtime-modules/test/ingest/IngestService.test.ts
//
// Lifted + adapted from gateway's test/ingest-service.test.js.
//
// Adaptations vs the gateway original:
//   - Constructor is options-bag based:
//       `new IngestService({ messageRouter, logger, ... })`.
//   - TypeScript: typed mocks for the narrow IngestMessageRouter slice.
//   - The local-mode emit test no longer reaches into a `Set<string>`
//     directly; we use the SubscriptionTracker addSubscription verb that
//     IngestService exposes via clientChannels (still a Map subclass).

import { IngestService } from '../../src/ingest/IngestService';
import type {
    IngestLogger,
    IngestMessageRouter,
} from '../../src/ingest/types';

class NoopLogger implements IngestLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

interface SentEntry {
    clientId: string;
    message: any;
}
interface ChannelSendEntry {
    channel: string;
    message: any;
}
interface SubOp {
    clientId: string;
    channel: string;
    op: 'sub' | 'unsub';
}

class MockRouter implements IngestMessageRouter {
    sent: SentEntry[] = [];
    channelSends: ChannelSendEntry[] = [];
    subs: SubOp[] = [];

    async subscribeToChannel(clientId: string, channel: string): Promise<void> {
        this.subs.push({ clientId, channel, op: 'sub' });
    }
    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        this.subs.push({ clientId, channel, op: 'unsub' });
    }
    async sendToChannel(channel: string, message: unknown): Promise<void> {
        this.channelSends.push({ channel, message });
    }
    sendToClient(clientId: string, message: unknown): void {
        this.sent.push({ clientId, message });
    }
}

function makeService(routerOverride?: MockRouter | null) {
    const router = routerOverride === undefined ? new MockRouter() : routerOverride;
    const logger = new NoopLogger();
    const service = new IngestService({ messageRouter: router, logger });
    return { service, router: router as MockRouter, logger };
}

// ─── ctor guard ───────────────────────────────────────────────────────────

describe('IngestService ctor', () => {
    test('throws when logger missing', () => {
        // @ts-expect-error — exercising the runtime guard
        expect(() => new IngestService({})).toThrow(/logger is required/);
    });

    test('null messageRouter is allowed (local mode)', () => {
        expect(() => new IngestService({ messageRouter: null, logger: new NoopLogger() })).not.toThrow();
    });

    test('respects custom maxChannelLength from config', () => {
        const service = new IngestService({
            messageRouter: null,
            logger: new NoopLogger(),
            config: { maxChannelLength: 20 },
        });
        expect(service.maxChannelLength).toBe(20);
        // A source-id pushing past 20 chars total should now fail.
        expect(service._isValidChannel('ingest:source:abcdefghi')).toBe(false);
    });
});

// ─── _isValidChannel ──────────────────────────────────────────────────────

describe('IngestService._isValidChannel', () => {
    let service: IngestService;
    beforeEach(() => { ({ service } = makeService()); });

    test('accepts ingest:progress', () => {
        expect(service._isValidChannel('ingest:progress')).toBe(true);
    });

    test('accepts ingest:source:{sourceId}', () => {
        expect(service._isValidChannel('ingest:source:src-1')).toBe(true);
    });

    test('rejects null', () => {
        expect(service._isValidChannel(null)).toBe(false);
    });

    test('rejects non-string', () => {
        expect(service._isValidChannel(42)).toBe(false);
    });

    test('rejects empty string', () => {
        expect(service._isValidChannel('')).toBe(false);
    });

    test('rejects unknown channel', () => {
        expect(service._isValidChannel('ingest:other')).toBe(false);
    });

    test('rejects bare ingest:source: with no id', () => {
        expect(service._isValidChannel('ingest:source:')).toBe(false);
    });

    test('rejects channel exceeding maxChannelLength', () => {
        const longId = 'x'.repeat(service.maxChannelLength);
        expect(service._isValidChannel(`ingest:source:${longId}`)).toBe(false);
    });

    test('static MAX_CHANNEL_LENGTH preserved for back-compat', () => {
        expect(IngestService.MAX_CHANNEL_LENGTH).toBe(100);
    });

    test('static VALID_CHANNELS preserved for back-compat', () => {
        expect(IngestService.VALID_CHANNELS).toContain('ingest:progress');
    });
});

// ─── handleSubscribe ──────────────────────────────────────────────────────

describe('IngestService.handleSubscribe', () => {
    test('sends subscribed ack on valid channel', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        const ack = router.sent.find(
            (s) => s.clientId === 'client-1' && s.message.action === 'subscribed',
        );
        expect(ack).toBeDefined();
        expect(ack!.message.channel).toBe('ingest:progress');
        expect(ack!.message.type).toBe('ingest');
        expect(typeof ack!.message.timestamp).toBe('string');
    });

    test('calls messageRouter.subscribeToChannel', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        expect(router.subs).toContainEqual({
            clientId: 'client-1',
            channel: 'ingest:progress',
            op: 'sub',
        });
    });

    test('tracks channel in clientChannels', async () => {
        const { service } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        expect(service.clientChannels.has('client-1')).toBe(true);
        expect(service.clientChannels.get('client-1')!.has('ingest:progress')).toBe(true);
    });

    test('sends error frame on invalid channel', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:unknown' });
        const err = router.sent.find((s) => s.message.type === 'error');
        expect(err).toBeDefined();
        expect(err!.message.service).toBe('ingest');
    });

    test('subscribing to ingest:source: channel is valid', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:source:src-42' });
        const ack = router.sent.find((s) => s.message.action === 'subscribed');
        expect(ack).toBeDefined();
        expect(ack!.message.channel).toBe('ingest:source:src-42');
    });

    test('multiple subscriptions from same client accumulate', async () => {
        const { service } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleSubscribe('client-1', { channel: 'ingest:source:src-1' });
        expect(service.clientChannels.get('client-1')!.size).toBe(2);
    });
});

// ─── handleUnsubscribe ────────────────────────────────────────────────────

describe('IngestService.handleUnsubscribe', () => {
    test('sends unsubscribed ack', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleUnsubscribe('client-1', { channel: 'ingest:progress' });
        const ack = router.sent.find((s) => s.message.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(ack!.message.channel).toBe('ingest:progress');
    });

    test('removes channel from client tracking', async () => {
        const { service } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleUnsubscribe('client-1', { channel: 'ingest:progress' });
        expect(service.clientChannels.has('client-1')).toBe(false);
    });

    test('removes clientId entry when last channel unsubscribed', async () => {
        const { service } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleSubscribe('client-1', { channel: 'ingest:source:s1' });
        await service.handleUnsubscribe('client-1', { channel: 'ingest:progress' });
        expect(service.clientChannels.has('client-1')).toBe(true); // still has source channel
        await service.handleUnsubscribe('client-1', { channel: 'ingest:source:s1' });
        expect(service.clientChannels.has('client-1')).toBe(false);
    });

    test('sends error frame when channel missing', async () => {
        const { service, router } = makeService();
        await service.handleUnsubscribe('client-1', {});
        const err = router.sent.find((s) => s.message.type === 'error');
        expect(err).toBeDefined();
    });

    test('tolerates unsubscribe for clientId not tracked (no channels entry)', async () => {
        const { service, router } = makeService();
        await service.handleUnsubscribe('ghost-client', { channel: 'ingest:progress' });
        expect(router.subs).toContainEqual({
            clientId: 'ghost-client',
            channel: 'ingest:progress',
            op: 'unsub',
        });
        const ack = router.sent.find((s) => s.message.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(service.clientChannels.has('ghost-client')).toBe(false);
    });
});

// ─── handleAction dispatch ────────────────────────────────────────────────

describe('IngestService.handleAction', () => {
    test('dispatches subscribe', async () => {
        const { service, router } = makeService();
        await service.handleAction('client-1', 'subscribe', { channel: 'ingest:progress' });
        expect(router.sent.some((s) => s.message.action === 'subscribed')).toBe(true);
    });

    test('dispatches unsubscribe', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleAction('client-1', 'unsubscribe', { channel: 'ingest:progress' });
        expect(router.sent.some((s) => s.message.action === 'unsubscribed')).toBe(true);
    });

    test('sends error frame on unknown action', async () => {
        const { service, router } = makeService();
        await service.handleAction('client-1', 'launch_missiles', {});
        const err = router.sent.find((s) => s.message.type === 'error');
        expect(err).toBeDefined();
        expect(err!.message.message).toContain('launch_missiles');
    });

    test('catches handler throws and replies with generic error frame', async () => {
        const { service, router } = makeService();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => { errs.push(args); };
        // Force handleSubscribe to throw by making subscribeToChannel reject
        router.subscribeToChannel = async () => { throw new Error('router blew up'); };
        await service.handleAction('client-1', 'subscribe', { channel: 'ingest:progress' });
        const err = router.sent.find(
            (s) => s.message.type === 'error' && s.message.message === 'Internal server error',
        );
        expect(err).toBeDefined();
        expect(errs.length).toBeGreaterThan(0);
    });
});

// ─── emitEvent ────────────────────────────────────────────────────────────

describe('IngestService.emitEvent', () => {
    test('broadcasts to channel via messageRouter.sendToChannel', async () => {
        const { service, router } = makeService();
        const event = { type: 'sync.started', sourceId: 'src-1' };
        await service.emitEvent('ingest:progress', event);
        const send = router.channelSends.find((s) => s.channel === 'ingest:progress');
        expect(send).toBeDefined();
        expect(send!.message.type).toBe('ingest:event');
        expect(send!.message.event).toEqual(event);
        expect(send!.message.channel).toBe('ingest:progress');
        expect(typeof send!.message.timestamp).toBe('string');
    });

    test('uses local broadcast when messageRouter is null', async () => {
        const service = new IngestService({ messageRouter: null, logger: new NoopLogger() });
        // subscribe client manually since no router is wired
        service.clientChannels.addSubscription('c-1', 'ingest:progress');
        const sent: Array<{ id: string; msg: unknown }> = [];
        service.sendToClient = (id: string, msg: unknown) => { sent.push({ id, msg }); };
        await service.emitEvent('ingest:progress', { type: 'sync.started' });
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe('c-1');
    });

    test('skips emit when channel is missing', async () => {
        const { service, router } = makeService();
        // @ts-expect-error — exercising the runtime guard
        await service.emitEvent(null, { type: 'sync.started' });
        expect(router.channelSends).toHaveLength(0);
    });

    test('skips emit when event is missing', async () => {
        const { service, router } = makeService();
        // @ts-expect-error — exercising the runtime guard
        await service.emitEvent('ingest:progress', null);
        expect(router.channelSends).toHaveLength(0);
    });

    test('local broadcast skips subscribers whose channels set does not contain the channel', async () => {
        const service = new IngestService({ messageRouter: null, logger: new NoopLogger() });
        service.clientChannels.addSubscription('c-match', 'ingest:progress');
        service.clientChannels.addSubscription('c-other', 'ingest:source:s-9');
        const sent: Array<{ id: string; msg: unknown }> = [];
        service.sendToClient = (id: string, msg: unknown) => { sent.push({ id, msg }); };
        await service.emitEvent('ingest:progress', { type: 'sync.started' });
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe('c-match');
    });

    test('catches messageRouter.sendToChannel failures and logs them', async () => {
        const { service, router } = makeService();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => { errs.push(args); };
        router.sendToChannel = async () => { throw new Error('redis down'); };
        await expect(
            service.emitEvent('ingest:progress', { type: 'sync.started' }),
        ).resolves.toBeUndefined();
        expect(errs.length).toBeGreaterThan(0);
    });
});

// ─── handleDisconnect ─────────────────────────────────────────────────────

describe('IngestService.handleDisconnect', () => {
    test('unsubscribes all tracked channels on disconnect', async () => {
        const { service, router } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleSubscribe('client-1', { channel: 'ingest:source:s1' });
        await service.handleDisconnect('client-1');
        const unsubs = router.subs.filter(
            (s) => s.clientId === 'client-1' && s.op === 'unsub',
        );
        expect(unsubs).toHaveLength(2);
    });

    test('removes client from clientChannels after disconnect', async () => {
        const { service } = makeService();
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        await service.handleDisconnect('client-1');
        expect(service.clientChannels.has('client-1')).toBe(false);
    });

    test('no-op when client was not subscribed', async () => {
        const { service } = makeService();
        await expect(service.handleDisconnect('client-never-seen')).resolves.toBeUndefined();
    });

    test('catches per-channel unsubscribe failures during disconnect', async () => {
        const { service, router } = makeService();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => { errs.push(args); };
        await service.handleSubscribe('client-1', { channel: 'ingest:progress' });
        router.unsubscribeFromChannel = async () => { throw new Error('router gone'); };
        await expect(service.handleDisconnect('client-1')).resolves.toBeUndefined();
        expect(errs.length).toBeGreaterThan(0);
        expect(service.clientChannels.has('client-1')).toBe(false);
    });
});

// ─── getStats ─────────────────────────────────────────────────────────────

describe('IngestService.getStats', () => {
    test('returns zero stats when no clients subscribed', () => {
        const { service } = makeService();
        expect(service.getStats()).toEqual({ subscribedClients: 0, totalSubscriptions: 0 });
    });

    test('counts clients and total subscriptions', async () => {
        const { service } = makeService();
        await service.handleSubscribe('c-1', { channel: 'ingest:progress' });
        await service.handleSubscribe('c-1', { channel: 'ingest:source:s1' });
        await service.handleSubscribe('c-2', { channel: 'ingest:progress' });
        const stats = service.getStats();
        expect(stats.subscribedClients).toBe(2);
        expect(stats.totalSubscriptions).toBe(3);
    });
});

// ─── sendToClient null-router fallback ────────────────────────────────────

describe('IngestService.sendToClient (no router)', () => {
    test('is a no-op when messageRouter is null', () => {
        const service = new IngestService({ messageRouter: null, logger: new NoopLogger() });
        expect(() => service.sendToClient('c-1', { type: 'ingest:event' })).not.toThrow();
        expect(() => service.sendError('c-1', 'boom')).not.toThrow();
    });
});
