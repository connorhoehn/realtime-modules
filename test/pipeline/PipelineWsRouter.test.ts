// realtime-modules/test/pipeline/PipelineWsRouter.test.ts
//
// Lifted + adapted from gateway's pipeline-service-{subscribe,
// disconnect, local-broadcast}.test.js and the emitEvent slice of
// pipeline-service.test.js.
//
// Adaptations vs the gateway originals:
//   - Constructor is options-bag based:
//       `new PipelineWsRouter({ messageRouter, logger, ... })`.
//   - TypeScript: typed mocks for the narrow PipelineMessageRouter slice.
//   - Trigger/cancel/approval/audit/authz/tracing tests are NOT lifted —
//     those handlers stay in the gateway composite PipelineService.
//   - `handleAction` is trimmed to subscribe/unsubscribe; the legacy
//     dispatch tests for trigger/cancel/etc. live with the gateway.

import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';
import type {
    PipelineLogger,
    PipelineMessageRouter,
} from '../../src/pipeline/types';

class NoopLogger implements PipelineLogger {
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

class MockRouter implements PipelineMessageRouter {
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

function makeRouter(routerOverride?: MockRouter | null) {
    const router = routerOverride === undefined ? new MockRouter() : routerOverride;
    const logger = new NoopLogger();
    const service = new PipelineWsRouter({ messageRouter: router, logger });
    return { service, router: router as MockRouter, logger };
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

// ─── ctor guard ───────────────────────────────────────────────────────────

describe('PipelineWsRouter ctor', () => {
    test('throws when logger missing', () => {
        // @ts-expect-error — exercising the runtime guard
        expect(() => new PipelineWsRouter({})).toThrow(/logger is required/);
    });

    test('null messageRouter is allowed (local mode)', () => {
        expect(
            () => new PipelineWsRouter({ messageRouter: null, logger: new NoopLogger() }),
        ).not.toThrow();
    });

    test('respects custom maxChannelLength from config', () => {
        const service = new PipelineWsRouter({
            messageRouter: null,
            logger: new NoopLogger(),
            config: { maxChannelLength: 20 },
        });
        expect(service.maxChannelLength).toBe(20);
        // A runId pushing past 20 chars total should now fail.
        expect(service._isValidChannel('pipeline:run:abcdefghij')).toBe(false);
    });
});

// ─── _isValidChannel ──────────────────────────────────────────────────────

describe('PipelineWsRouter._isValidChannel', () => {
    let service: PipelineWsRouter;
    beforeEach(() => {
        ({ service } = makeRouter());
    });

    test('accepts pipeline:all', () => {
        expect(service._isValidChannel('pipeline:all')).toBe(true);
    });

    test('accepts pipeline:approvals', () => {
        expect(service._isValidChannel('pipeline:approvals')).toBe(true);
    });

    test('accepts pipeline:run:{runId} with non-empty runId', () => {
        expect(service._isValidChannel('pipeline:run:abc-123')).toBe(true);
    });

    test('rejects pipeline:run: with no runId suffix', () => {
        expect(service._isValidChannel('pipeline:run:')).toBe(false);
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

    test('rejects unknown pipeline-prefixed channel', () => {
        expect(service._isValidChannel('pipeline:random')).toBe(false);
    });

    test('rejects non-pipeline channel', () => {
        expect(service._isValidChannel('chat:general')).toBe(false);
    });

    test('rejects channel exceeding maxChannelLength', () => {
        const longId = 'x'.repeat(service.maxChannelLength);
        expect(service._isValidChannel(`pipeline:run:${longId}`)).toBe(false);
    });

    test('static MAX_CHANNEL_LENGTH preserved for back-compat', () => {
        expect(PipelineWsRouter.MAX_CHANNEL_LENGTH).toBe(100);
    });

    test('static CHANNEL_PREFIXES preserved for back-compat', () => {
        expect(PipelineWsRouter.CHANNEL_PREFIXES).toEqual(
            expect.arrayContaining(['pipeline:run:', 'pipeline:all', 'pipeline:approvals']),
        );
    });
});

// ─── handleSubscribe ──────────────────────────────────────────────────────

describe('PipelineWsRouter.handleSubscribe', () => {
    test('sends subscribed ack on valid channel', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        const ack = router.sent.find(
            (s) => s.clientId === 'c-1' && s.message.action === 'subscribed',
        );
        expect(ack).toBeDefined();
        expect(ack!.message.channel).toBe('pipeline:all');
        expect(ack!.message.type).toBe('pipeline');
        expect(typeof ack!.message.timestamp).toBe('string');
    });

    test('calls messageRouter.subscribeToChannel', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        expect(router.subs).toContainEqual({
            clientId: 'c-1',
            channel: 'pipeline:all',
            op: 'sub',
        });
    });

    test('tracks channel in clientChannels', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:run:r1' });
        expect(service.clientChannels.has('c-1')).toBe(true);
        expect(service.clientChannels.get('c-1')!.has('pipeline:run:r1')).toBe(true);
    });

    test('sends error frame on invalid channel', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'chat:general' });
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.service).toBe('pipeline');
    });

    test('sends error frame when channel missing', async () => {
        const { service, router } = makeRouter();
        // @ts-expect-error — exercising runtime guard
        await service.handleSubscribe('c-1', {});
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err).toBeDefined();
    });

    test('multiple subscriptions from same client accumulate', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleSubscribe('c-1', { channel: 'pipeline:approvals' });
        expect(service.clientChannels.get('c-1')!.size).toBe(2);
    });
});

// ─── handleUnsubscribe ────────────────────────────────────────────────────

describe('PipelineWsRouter.handleUnsubscribe', () => {
    test('sends unsubscribed ack', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleUnsubscribe('c-1', { channel: 'pipeline:all' });
        const ack = sentTo(router, 'c-1').find((m) => m.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(ack.channel).toBe('pipeline:all');
        expect(ack.type).toBe('pipeline');
    });

    test('removes channel from client tracking', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleUnsubscribe('c-1', { channel: 'pipeline:all' });
        expect(service.clientChannels.has('c-1')).toBe(false);
    });

    test('retains other channels when one is unsubscribed', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleSubscribe('c-1', { channel: 'pipeline:approvals' });
        await service.handleUnsubscribe('c-1', { channel: 'pipeline:all' });
        expect(service.clientChannels.get('c-1')!.has('pipeline:all')).toBe(false);
        expect(service.clientChannels.get('c-1')!.has('pipeline:approvals')).toBe(true);
    });

    test('sends error frame when channel missing', async () => {
        const { service, router } = makeRouter();
        await service.handleUnsubscribe('c-1', {});
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err).toBeDefined();
    });

    test('tolerates unsubscribe for clientId not tracked', async () => {
        const { service, router } = makeRouter();
        await service.handleUnsubscribe('ghost', { channel: 'pipeline:all' });
        expect(router.subs).toContainEqual({
            clientId: 'ghost',
            channel: 'pipeline:all',
            op: 'unsub',
        });
        const ack = sentTo(router, 'ghost').find((m) => m.action === 'unsubscribed');
        expect(ack).toBeDefined();
        expect(service.clientChannels.has('ghost')).toBe(false);
    });
});

// ─── handleAction dispatch ────────────────────────────────────────────────

describe('PipelineWsRouter.handleAction', () => {
    test('dispatches subscribe', async () => {
        const { service, router } = makeRouter();
        await service.handleAction('c-1', 'subscribe', { channel: 'pipeline:all' });
        expect(sentTo(router, 'c-1').some((m) => m.action === 'subscribed')).toBe(true);
    });

    test('dispatches unsubscribe', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleAction('c-1', 'unsubscribe', { channel: 'pipeline:all' });
        expect(sentTo(router, 'c-1').some((m) => m.action === 'unsubscribed')).toBe(true);
    });

    test('sends error frame on unknown action', async () => {
        const { service, router } = makeRouter();
        await service.handleAction('c-1', 'launch-rockets', {});
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toContain('launch-rockets');
    });

    test('catches handler throws and replies with generic error frame', async () => {
        const { service, router } = makeRouter();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => {
            errs.push(args);
        };
        router.subscribeToChannel = async () => {
            throw new Error('router blew up');
        };
        await service.handleAction('c-1', 'subscribe', { channel: 'pipeline:all' });
        const err = sentTo(router, 'c-1').find(
            (m) => m.type === 'error' && m.message === 'Internal server error',
        );
        expect(err).toBeDefined();
        expect(errs.length).toBeGreaterThan(0);
    });
});

// ─── emitEvent ────────────────────────────────────────────────────────────

describe('PipelineWsRouter.emitEvent', () => {
    test('broadcasts pipeline:event frame via messageRouter.sendToChannel', async () => {
        const { service, router } = makeRouter();
        await service.emitEvent(
            'pipeline:run:r1',
            'pipeline.step.completed',
            { stepId: 's1' },
            { seq: 42, sourceNodeId: 'node-123', emittedAt: 1700000000000 },
        );
        const send = router.channelSends.find((s) => s.channel === 'pipeline:run:r1');
        expect(send).toBeDefined();
        expect(send!.message.type).toBe('pipeline:event');
        expect(send!.message.eventType).toBe('pipeline.step.completed');
        expect(send!.message.payload).toEqual({ stepId: 's1' });
        expect(send!.message.channel).toBe('pipeline:run:r1');
        expect(send!.message.seq).toBe(42);
        expect(send!.message.sourceNodeId).toBe('node-123');
        expect(send!.message.emittedAt).toBe(1700000000000);
    });

    test('emitEvent without envelope omits seq/sourceNodeId/emittedAt (undefined)', async () => {
        const { service, router } = makeRouter();
        await service.emitEvent('pipeline:run:r2', 'pipeline.run.started', { runId: 'r2' });
        const send = router.channelSends.find((s) => s.channel === 'pipeline:run:r2');
        expect(send).toBeDefined();
        expect(send!.message.seq).toBeUndefined();
        expect(send!.message.sourceNodeId).toBeUndefined();
        expect(send!.message.emittedAt).toBeUndefined();
    });

    test('uses local broadcast when messageRouter is null', async () => {
        const service = new PipelineWsRouter({
            messageRouter: null,
            logger: new NoopLogger(),
        });
        service.clientChannels.addSubscription('c-1', 'pipeline:all');
        const sent: Array<{ id: string; msg: unknown }> = [];
        service.sendToClient = (id: string, msg: unknown) => {
            sent.push({ id, msg });
        };
        await service.emitEvent('pipeline:all', 'pipeline.run.started', { runId: 'r3' });
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe('c-1');
        expect((sent[0].msg as any).type).toBe('pipeline:event');
        expect((sent[0].msg as any).eventType).toBe('pipeline.run.started');
    });

    test('skips emit when channel is missing', async () => {
        const { service, router } = makeRouter();
        // @ts-expect-error — runtime guard
        await service.emitEvent(null, 'pipeline.run.started', {});
        expect(router.channelSends).toHaveLength(0);
    });

    test('skips emit when eventType is missing', async () => {
        const { service, router } = makeRouter();
        // @ts-expect-error — runtime guard
        await service.emitEvent('pipeline:all', null, {});
        expect(router.channelSends).toHaveLength(0);
    });

    test('local broadcast skips subscribers whose channels set does not match', async () => {
        const service = new PipelineWsRouter({
            messageRouter: null,
            logger: new NoopLogger(),
        });
        service.clientChannels.addSubscription('c-match', 'pipeline:all');
        service.clientChannels.addSubscription('c-other', 'pipeline:approvals');
        const sent: Array<{ id: string; msg: unknown }> = [];
        service.sendToClient = (id: string, msg: unknown) => {
            sent.push({ id, msg });
        };
        await service.emitEvent('pipeline:all', 'pipeline.run.started', {});
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe('c-match');
    });

    test('catches messageRouter.sendToChannel failures and logs them', async () => {
        const { service, router } = makeRouter();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => {
            errs.push(args);
        };
        router.sendToChannel = async () => {
            throw new Error('redis down');
        };
        await expect(
            service.emitEvent('pipeline:all', 'pipeline.run.started', {}),
        ).resolves.toBeUndefined();
        expect(errs.length).toBeGreaterThan(0);
    });

    test('logs warn when channel missing', async () => {
        const warns: unknown[][] = [];
        const router = new MockRouter();
        const service = new PipelineWsRouter({
            messageRouter: router,
            logger: {
                debug: () => {},
                info: () => {},
                warn: (...args: unknown[]) => warns.push(args),
                error: () => {},
            },
        });
        // @ts-expect-error
        await service.emitEvent(null, 'pipeline.run.started', {});
        expect(warns.length).toBeGreaterThan(0);
    });
});

// ─── _broadcastToLocalSubscribers ─────────────────────────────────────────

describe('PipelineWsRouter._broadcastToLocalSubscribers', () => {
    function makeNullCapture() {
        const sent: Array<{ clientId: string; message: unknown }> = [];
        const service = new PipelineWsRouter({
            messageRouter: null,
            logger: new NoopLogger(),
        });
        service.sendToClient = (clientId: string, message: unknown) =>
            sent.push({ clientId, message });
        return { service, sent };
    }

    test('sends message to every client subscribed to the channel', () => {
        const { service, sent } = makeNullCapture();
        service.clientChannels.set('c1', new Set(['pipeline:all']));
        service.clientChannels.set('c2', new Set(['pipeline:all']));
        service.clientChannels.set('c3', new Set(['pipeline:approvals']));

        const msg = { type: 'pipeline:event', eventType: 'run.started' };
        service._broadcastToLocalSubscribers('pipeline:all', msg);

        const ids = sent.map((s) => s.clientId);
        expect(ids).toContain('c1');
        expect(ids).toContain('c2');
        expect(ids).not.toContain('c3');
    });

    test('is a no-op when no client subscribed to the channel', () => {
        const { service, sent } = makeNullCapture();
        service.clientChannels.set('c1', new Set(['pipeline:approvals']));
        service._broadcastToLocalSubscribers('pipeline:all', { type: 'pipeline:event' });
        expect(sent).toHaveLength(0);
    });

    test('is a no-op when clientChannels is empty', () => {
        const { service, sent } = makeNullCapture();
        service._broadcastToLocalSubscribers('pipeline:all', { type: 'pipeline:event' });
        expect(sent).toHaveLength(0);
    });

    test('sends same message object to multiple subscribers', () => {
        const { service, sent } = makeNullCapture();
        service.clientChannels.set('c1', new Set(['pipeline:run:r1']));
        service.clientChannels.set('c2', new Set(['pipeline:run:r1']));
        service.clientChannels.set('c3', new Set(['pipeline:run:r1']));

        const msg = { type: 'pipeline:event', eventType: 'step.completed' };
        service._broadcastToLocalSubscribers('pipeline:run:r1', msg);
        expect(sent).toHaveLength(3);
        sent.forEach(({ message }) => expect(message).toBe(msg));
    });
});

// ─── handleDisconnect ─────────────────────────────────────────────────────

describe('PipelineWsRouter.handleDisconnect', () => {
    test('unsubscribes all tracked channels on disconnect', async () => {
        const { service, router } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleSubscribe('c-1', { channel: 'pipeline:approvals' });
        await service.handleDisconnect('c-1');
        const unsubs = router.subs.filter((s) => s.clientId === 'c-1' && s.op === 'unsub');
        expect(unsubs).toHaveLength(2);
    });

    test('removes client from clientChannels after disconnect', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleDisconnect('c-1');
        expect(service.clientChannels.has('c-1')).toBe(false);
    });

    test('no-op when client was not subscribed', async () => {
        const { service, router } = makeRouter();
        await expect(service.handleDisconnect('c-never')).resolves.toBeUndefined();
        expect(router.subs).toHaveLength(0);
    });

    test('retains other clients after one disconnects', async () => {
        const { service } = makeRouter();
        service.clientChannels.set('c-1', new Set(['pipeline:all']));
        service.clientChannels.set('c-2', new Set(['pipeline:all']));
        await service.handleDisconnect('c-1');
        expect(service.clientChannels.has('c-1')).toBe(false);
        expect(service.clientChannels.has('c-2')).toBe(true);
    });

    test('catches per-channel unsubscribe failures during disconnect', async () => {
        const { service, router } = makeRouter();
        const errs: unknown[][] = [];
        service.logger.error = (...args: unknown[]) => {
            errs.push(args);
        };
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        router.unsubscribeFromChannel = async () => {
            throw new Error('router gone');
        };
        await expect(service.handleDisconnect('c-1')).resolves.toBeUndefined();
        expect(errs.length).toBeGreaterThan(0);
        expect(service.clientChannels.has('c-1')).toBe(false);
    });
});

// ─── getStats ─────────────────────────────────────────────────────────────

describe('PipelineWsRouter.getStats', () => {
    test('returns zero stats when no clients subscribed', () => {
        const { service } = makeRouter();
        expect(service.getStats()).toEqual({
            subscribedClients: 0,
            totalSubscriptions: 0,
        });
    });

    test('counts clients and total subscriptions', async () => {
        const { service } = makeRouter();
        await service.handleSubscribe('c-1', { channel: 'pipeline:all' });
        await service.handleSubscribe('c-1', { channel: 'pipeline:approvals' });
        await service.handleSubscribe('c-2', { channel: 'pipeline:all' });
        const stats = service.getStats();
        expect(stats.subscribedClients).toBe(2);
        expect(stats.totalSubscriptions).toBe(3);
    });

    test('stats reflect actual state after disconnect', async () => {
        const { service } = makeRouter();
        service.clientChannels.set('c-1', new Set(['pipeline:all']));
        service.clientChannels.set('c-2', new Set(['pipeline:all']));
        await service.handleDisconnect('c-1');
        const stats = service.getStats();
        expect(stats.subscribedClients).toBe(1);
        expect(stats.totalSubscriptions).toBe(1);
    });
});

// ─── sendToClient / sendError ─────────────────────────────────────────────

describe('PipelineWsRouter.sendToClient (no router)', () => {
    test('is a no-op when messageRouter is null', () => {
        const service = new PipelineWsRouter({
            messageRouter: null,
            logger: new NoopLogger(),
        });
        expect(() => service.sendToClient('c-1', { type: 'pipeline:ack' })).not.toThrow();
        expect(() => service.sendError('c-1', 'boom')).not.toThrow();
    });
});

describe('PipelineWsRouter.sendError', () => {
    test('sends error frame with type=error and service=pipeline', () => {
        const { service, router } = makeRouter();
        service.sendError('c-1', 'not authorized');
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.service).toBe('pipeline');
        expect(err.message).toBe('not authorized');
        expect(typeof err.timestamp).toBe('string');
    });

    test('omits correlationId when not provided', () => {
        const { service, router } = makeRouter();
        service.sendError('c-1', 'oops');
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect('correlationId' in err).toBe(false);
    });

    test('includes correlationId when provided', () => {
        const { service, router } = makeRouter();
        service.sendError('c-1', 'forbidden', 'corr-123');
        const err = sentTo(router, 'c-1').find((m) => m.type === 'error');
        expect(err.correlationId).toBe('corr-123');
    });
});

// ─── manifest re-export wiring ────────────────────────────────────────────

describe('PipelineWsManifest', () => {
    test('is re-exported from the subpath barrel', async () => {
        const { PipelineWsManifest } = await import('../../src/pipeline');
        const direct = await import('../../src/pipeline/manifest');
        expect(PipelineWsManifest).toBe(direct.PipelineWsManifest);
    });

    test('declares the three pipeline channel patterns', async () => {
        const { PipelineWsManifest } = await import('../../src/pipeline');
        expect(PipelineWsManifest.channels).toEqual(
            expect.arrayContaining([
                'pipeline:run:*',
                'pipeline:all',
                'pipeline:approvals',
            ]),
        );
    });

    test('declares the PIPELINE_MAX_CHANNEL_LENGTH env var', async () => {
        const { PipelineWsManifest } = await import('../../src/pipeline');
        expect(PipelineWsManifest.envVars?.PIPELINE_MAX_CHANNEL_LENGTH).toBeDefined();
        expect(PipelineWsManifest.envVars?.PIPELINE_MAX_CHANNEL_LENGTH.default).toBe('100');
    });
});
