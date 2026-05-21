// realtime-modules/test/reactions/ReactionService.test.ts
//
// Lifted + adapted from gateway's reaction-service test suite:
//   - reaction-service.test.js              (core action handlers)
//   - reaction-service-local-mode.test.js   (isDistributed=false paths)
//   - reaction-service-utils.test.js        (utility methods)
//   - reaction-service-unsub-disconnect.test.js (unsub/disconnect/getStats)
//
// Adaptations vs gateway originals:
//   - jest.mock('authz-interceptor') removed; tests pass an explicit
//     `authorizeChannel` hook through ReactionConfig instead.
//   - jest.mock('ownership-cleanup-coordinator') removed; gateway-specific
//     coordinator wiring is no longer in the lifted module (see header of
//     ReactionService.ts). cleanupRoom() is exercised directly.
//   - Constructor is options-bag based: `new ReactionService({ messageRouter, logger, ... })`.

import { ReactionService } from '../../src/reactions/ReactionService';
import type {
    ReactionMessageRouter,
    ReactionLogger,
    ReactionMetricsCollector,
} from '../../src/reactions/types';

class NoopLogger implements ReactionLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

class SpyLogger implements ReactionLogger {
    infos: Array<{ msg: string; meta?: unknown }> = [];
    warns: Array<{ msg: string; meta?: unknown }> = [];
    debug(): void {}
    info(msg: string, meta?: unknown): void {
        this.infos.push({ msg, meta });
    }
    warn(msg: string, meta?: unknown): void {
        this.warns.push({ msg, meta });
    }
    error(): void {}
}

interface SentEntry {
    clientId: string;
    message: any;
}

class MockRouter implements ReactionMessageRouter {
    sent: SentEntry[] = [];
    channelSends: Array<{ channel: string; message: any }> = [];
    unsubscribed: Array<{ clientId: string; channel: string }> = [];

    sendToLocalClient(clientId: string, msg: any): void {
        this.sent.push({ clientId, message: msg });
    }
    async subscribeToChannel(): Promise<void> {}
    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        this.unsubscribed.push({ clientId, channel });
    }
    async sendToChannel(channel: string, message: any): Promise<void> {
        this.channelSends.push({ channel, message });
    }
}

function findSent(router: MockRouter, predicate: (m: any) => boolean): any {
    return router.sent.find((s) => predicate(s.message))?.message;
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

function makeDistributed(opts: {
    authz?: (clientId: string, channel: string) => boolean;
    metricsCollector?: ReactionMetricsCollector | null;
    logger?: ReactionLogger;
} = {}): { service: ReactionService; router: MockRouter } {
    const router = new MockRouter();
    const service = new ReactionService({
        messageRouter: router,
        logger: opts.logger ?? new NoopLogger(),
        metricsCollector: opts.metricsCollector ?? null,
        config: {
            authorizeChannel: opts.authz,
        },
    });
    return { service, router };
}

function makeLocal(opts: { metricsCollector?: ReactionMetricsCollector | null } = {}): ReactionService {
    return new ReactionService({
        messageRouter: null,
        logger: new NoopLogger(),
        metricsCollector: opts.metricsCollector ?? null,
    });
}

// ─── handleSendReaction ──────────────────────────────────────────────────────

describe('ReactionService — handleSendReaction', () => {
    let router: MockRouter;
    let service: ReactionService;

    beforeEach(() => {
        ({ service, router } = makeDistributed());
    });

    test('missing channel returns error', async () => {
        await service.handleAction('c1', 'send', { emoji: '❤️' });
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/channel and emoji are required/i);
    });

    test('missing emoji returns error', async () => {
        await service.handleAction('c1', 'send', { channel: 'room-1' });
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/channel and emoji are required/i);
    });

    test('unknown emoji returns "Invalid emoji reaction" error', async () => {
        await service.handleAction('c1', 'send', { channel: 'room-1', emoji: '\u{1F916}' });
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toBe('Invalid emoji reaction');
    });

    test('valid emoji sends ack to sender and broadcasts to channel', async () => {
        await service.handleAction('c1', 'send', { channel: 'room-1', emoji: '❤️' });

        const ack = findSent(router, (m) => m.type === 'reaction' && m.action === 'reaction_sent');
        expect(ack).toBeDefined();
        expect(ack.data.emoji).toBe('❤️');
        expect(ack.data.channel).toBe('room-1');
        expect(ack.data.reactionId).toBeDefined();

        expect(router.channelSends).toHaveLength(1);
        expect(router.channelSends[0].channel).toBe('reactions:room-1');
        expect(router.channelSends[0].message.action).toBe('reaction_received');
    });
});

// ─── handleSubscribeToReactions ─────────────────────────────────────────────

describe('ReactionService — handleSubscribeToReactions', () => {
    test('missing channel returns error', async () => {
        const { service, router } = makeDistributed();
        await service.handleAction('c1', 'subscribe', {});
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/channel name is required/i);
    });

    test('valid channel returns success frame with availableReactions list', async () => {
        const { service, router } = makeDistributed();
        await service.handleAction('c1', 'subscribe', { channel: 'room-1' });
        const ack = findSent(router, (m) => m.type === 'reaction' && m.action === 'reaction_subscribed');
        expect(ack).toBeDefined();
        expect(ack.success).toBe(true);
        expect(Array.isArray(ack.data.availableReactions)).toBe(true);
        expect(ack.data.availableReactions.length).toBeGreaterThan(0);
        expect(ack.data.availableReactions).toContain('❤️');
    });

    test('authz hook returning false denies subscription', async () => {
        const { service, router } = makeDistributed({ authz: () => false });
        await service.handleAction('c1', 'subscribe', { channel: 'room-1' });

        const ack = findSent(router, (m) => m.type === 'reaction' && m.action === 'reaction_subscribed');
        expect(ack).toBeUndefined();

        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/not authorized/i);
    });

    test('channel name longer than max length returns error', async () => {
        const { service, router } = makeDistributed();
        const longName = 'a'.repeat(51);
        await service.handleAction('c1', 'subscribe', { channel: longName });
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/must be a string between 1 and 50/i);
    });

    test('subscribing the same client to a second channel reuses the existing Set', async () => {
        const { service } = makeDistributed();
        await service.handleAction('c1', 'subscribe', { channel: 'ch-a' });
        await service.handleAction('c1', 'subscribe', { channel: 'ch-b' });
        expect(service.clientChannels.get('c1')!.size).toBe(2);
    });
});

// ─── handleGetAvailableReactions ────────────────────────────────────────────

describe('ReactionService — handleGetAvailableReactions', () => {
    test('returns success frame with all available emojis', async () => {
        const { service, router } = makeDistributed();
        await service.handleAction('c1', 'getAvailable', {});
        const ack = findSent(router, (m) => m.type === 'reaction' && m.action === 'available_reactions');
        expect(ack).toBeDefined();
        expect(ack.success).toBe(true);
        expect(typeof ack.data.reactions).toBe('object');
        expect('❤️' in ack.data.reactions).toBe(true);
        expect('\u{1F389}' in ack.data.reactions).toBe(true);
    });
});

// ─── unknown action ─────────────────────────────────────────────────────────

describe('ReactionService — unknown action', () => {
    test('returns error frame for unrecognised action', async () => {
        const { service, router } = makeDistributed();
        await service.handleAction('c1', 'fly', {});
        const err = findSent(router, (m) => m.type === 'error');
        expect(err).toBeDefined();
        expect(err.error.message).toMatch(/unknown reaction action.*fly/i);
    });
});

// ─── local mode (isDistributed=false) ────────────────────────────────────────

describe('ReactionService — local mode (isDistributed=false)', () => {
    test('subscribe tracks client without calling router', async () => {
        const svc = makeLocal();
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        expect(svc.clientChannels.has('c1')).toBe(true);
    });

    test('unsubscribe removes client without calling router', async () => {
        const svc = makeLocal();
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        await svc.handleAction('c1', 'unsubscribe', { channel: 'ch' });
        expect(svc.clientChannels.has('c1')).toBe(false);
    });

    test('send uses broadcastToLocalChannel instead of router.sendToChannel', async () => {
        const svc = makeLocal();
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        await expect(
            svc.handleAction('c1', 'send', { channel: 'ch', emoji: '❤️' }),
        ).resolves.toBeUndefined();
    });

    test('handleDisconnect in local mode is a no-op on router', async () => {
        const svc = makeLocal();
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        await svc.handleDisconnect('c1');
        expect(svc.clientChannels.has('c1')).toBe(false);
    });
});

// ─── reaction history ─────────────────────────────────────────────────────────

describe('ReactionService — handleSendReaction history', () => {
    test('second reaction to same channel reuses existing history array', async () => {
        const svc = makeLocal();
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        await svc.handleAction('c1', 'send', { channel: 'ch', emoji: '❤️' });
        await svc.handleAction('c1', 'send', { channel: 'ch', emoji: '\u{1F44D}' });
        expect(svc.reactionHistory.get('ch')!.length).toBe(2);
    });

    test('history exceeds maxHistorySize → oldest entry shifted out', async () => {
        const svc = makeLocal();
        svc.maxHistorySize = 2;
        await svc.handleAction('c1', 'subscribe', { channel: 'ch' });
        await svc.handleAction('c1', 'send', { channel: 'ch', emoji: '❤️' });
        await svc.handleAction('c1', 'send', { channel: 'ch', emoji: '\u{1F44D}' });
        await svc.handleAction('c1', 'send', { channel: 'ch', emoji: '\u{1F389}' });
        expect(svc.reactionHistory.get('ch')!.length).toBe(2);
    });
});

// ─── sendError — metrics + router-without-sendToLocalClient ──────────────────

describe('ReactionService — sendError', () => {
    test('records error metric when metricsCollector is provided', async () => {
        const recordError = jest.fn();
        const { service } = makeDistributed({ metricsCollector: { recordError } });
        await service.handleAction('c1', 'bogusAction', {});
        expect(recordError).toHaveBeenCalled();
    });
});

describe('ReactionService — sendToClient', () => {
    test('does not throw when router has no sendToLocalClient', () => {
        const router: ReactionMessageRouter = {
            async subscribeToChannel(): Promise<void> {},
            async unsubscribeFromChannel(): Promise<void> {},
            async sendToChannel(): Promise<void> {},
        };
        const svc = new ReactionService({ messageRouter: router, logger: new NoopLogger() });
        expect(() => svc.sendToClient('c1', { type: 'test' })).not.toThrow();
    });
});

// ─── utility methods ─────────────────────────────────────────────────────────

describe('ReactionService — generateReactionId', () => {
    test('returns a string prefixed with "reaction_"', () => {
        const svc = makeLocal();
        const id = svc.generateReactionId();
        expect(typeof id).toBe('string');
        expect(id.startsWith('reaction_')).toBe(true);
    });

    test('returns unique values on successive calls', () => {
        const svc = makeLocal();
        const ids = new Set(Array.from({ length: 10 }, () => svc.generateReactionId()));
        expect(ids.size).toBe(10);
    });
});

describe('ReactionService — broadcastToLocalChannel', () => {
    test('sends message to every client subscribed to the channel', () => {
        const { service, router } = makeDistributed();
        service.clientChannels.set('c1', new Set(['room:A']));
        service.clientChannels.set('c2', new Set(['room:A']));
        service.clientChannels.set('c3', new Set(['room:B']));

        service.broadcastToLocalChannel('room:A', { type: 'reaction', action: 'update' });

        const ids = router.sent.map((s) => s.clientId);
        expect(ids).toContain('c1');
        expect(ids).toContain('c2');
        expect(ids).not.toContain('c3');
    });

    test('is a no-op when no clients are subscribed to the channel', () => {
        const { service, router } = makeDistributed();
        service.clientChannels.set('c1', new Set(['room:B']));

        service.broadcastToLocalChannel('room:A', { type: 'reaction' });

        expect(router.sent).toHaveLength(0);
    });

    test('is a no-op when clientChannels is empty', () => {
        const { service, router } = makeDistributed();
        service.broadcastToLocalChannel('room:A', { type: 'reaction' });
        expect(router.sent).toHaveLength(0);
    });
});

describe('ReactionService — sendSuccess', () => {
    test('sends a message with type=reaction, success=true, and given action+data', () => {
        const { service, router } = makeDistributed();
        service.sendSuccess('c1', 'subscribed', { channel: 'room:1' });

        expect(router.sent).toHaveLength(1);
        const { message } = router.sent[0];
        expect(message.type).toBe('reaction');
        expect(message.action).toBe('subscribed');
        expect(message.success).toBe(true);
        expect(message.data).toEqual({ channel: 'room:1' });
    });
});

// ─── handleUnsubscribeFromReactions ─────────────────────────────────────────

describe('ReactionService — handleUnsubscribeFromReactions', () => {
    test('missing channel sends error and returns early', async () => {
        const { service, router } = makeDistributed();
        await service.handleUnsubscribeFromReactions('c-1', {} as any);

        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
    });

    test('sends reaction_unsubscribed success frame', async () => {
        const { service, router } = makeDistributed();
        await service.handleUnsubscribeFromReactions('c-1', { channel: 'general' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'reaction_unsubscribed');
        expect(acks).toHaveLength(1);
        expect(acks[0].data.channel).toBe('general');
    });

    test('removes channel from clientChannels', async () => {
        const { service } = makeDistributed();
        service.clientChannels.set('c-1', new Set(['general']));

        await service.handleUnsubscribeFromReactions('c-1', { channel: 'general' });

        expect(service.clientChannels.has('c-1')).toBe(false);
    });

    test('retains other channels when one is removed', async () => {
        const { service } = makeDistributed();
        service.clientChannels.set('c-1', new Set(['general', 'room-b']));

        await service.handleUnsubscribeFromReactions('c-1', { channel: 'general' });

        expect(service.clientChannels.get('c-1')!.has('general')).toBe(false);
        expect(service.clientChannels.get('c-1')!.has('room-b')).toBe(true);
    });

    test('calls unsubscribeFromChannel on router with reactions: prefix', async () => {
        const { service, router } = makeDistributed();
        await service.handleUnsubscribeFromReactions('c-1', { channel: 'lobby' });

        expect(router.unsubscribed).toContainEqual({ clientId: 'c-1', channel: 'reactions:lobby' });
    });
});

// ─── handleDisconnect ───────────────────────────────────────────────────────

describe('ReactionService — handleDisconnect', () => {
    test('removes client from clientChannels on disconnect', async () => {
        const { service } = makeDistributed();
        service.clientChannels.set('c-1', new Set(['room-a', 'room-b']));

        await service.handleDisconnect('c-1');

        expect(service.clientChannels.has('c-1')).toBe(false);
    });

    test('calls unsubscribeFromChannel for each subscribed channel', async () => {
        const { service, router } = makeDistributed();
        service.clientChannels.set('c-1', new Set(['room-a', 'room-b']));

        await service.handleDisconnect('c-1');

        const channels = router.unsubscribed.map((u) => u.channel).sort();
        expect(channels).toEqual(['reactions:room-a', 'reactions:room-b'].sort());
    });

    test('is a no-op when client was not subscribed', async () => {
        const { service, router } = makeDistributed();
        await service.handleDisconnect('c-unknown');

        expect(router.unsubscribed).toHaveLength(0);
        expect(service.clientChannels.has('c-unknown')).toBe(false);
    });
});

// ─── getStats ────────────────────────────────────────────────────────────────

describe('ReactionService — getStats', () => {
    test('returns zero stats when no activity', () => {
        const { service } = makeDistributed();
        const stats = service.getStats();
        expect(stats.connectedClients).toBe(0);
        expect(stats.activeChannels).toBe(0);
        expect(stats.totalReactions).toBe(0);
        expect(stats.availableReactionsCount).toBeGreaterThan(0);
    });

    test('connectedClients reflects clientChannels map size', () => {
        const { service } = makeDistributed();
        service.clientChannels.set('c-1', new Set(['room-a']));
        service.clientChannels.set('c-2', new Set(['room-b']));
        expect(service.getStats().connectedClients).toBe(2);
    });

    test('totalReactions sums across all channels', () => {
        const { service } = makeDistributed();
        service.reactionHistory.set('ch-1', [{ id: 'r1' } as any, { id: 'r2' } as any]);
        service.reactionHistory.set('ch-2', [{ id: 'r3' } as any]);
        expect(service.getStats().totalReactions).toBe(3);
    });

    test('activeChannels reflects reactionHistory map size', () => {
        const { service } = makeDistributed();
        service.reactionHistory.set('ch-1', []);
        service.reactionHistory.set('ch-2', []);
        expect(service.getStats().activeChannels).toBe(2);
    });
});

// ─── cleanupRoom (replaces gateway's _cleanupRoom + coordinator handlers) ───

describe('ReactionService — cleanupRoom', () => {
    test('is a no-op when roomId is empty string', async () => {
        const { service } = makeDistributed();
        await expect(service.cleanupRoom('')).resolves.not.toThrow();
    });

    test('is a no-op when roomId is null/undefined', async () => {
        const { service } = makeDistributed();
        await expect(service.cleanupRoom(null as any)).resolves.not.toThrow();
        await expect(service.cleanupRoom(undefined as any)).resolves.not.toThrow();
    });

    test('is a no-op for an unknown roomId not in reactionHistory', async () => {
        const { service } = makeDistributed();
        await expect(service.cleanupRoom('room:unknown')).resolves.not.toThrow();
        expect(service.reactionHistory.has('room:unknown')).toBe(false);
    });

    test('removes the reactionHistory entry for a known room', async () => {
        const { service } = makeDistributed();
        service.reactionHistory.set('room:owned', [{ emoji: '\u{1F44D}' } as any]);
        await service.cleanupRoom('room:owned');
        expect(service.reactionHistory.has('room:owned')).toBe(false);
    });

    test('logs info when flushing a known room', async () => {
        const logger = new SpyLogger();
        const { service } = makeDistributed({ logger });
        service.reactionHistory.set('room:log-check', [{ emoji: '\u{1F389}' } as any]);

        await service.cleanupRoom('room:log-check');

        const logged = logger.infos.some(({ msg }) => typeof msg === 'string' && msg.includes('room:log-check'));
        expect(logged).toBe(true);
    });

    test('does not disturb reaction history for other rooms', async () => {
        const { service } = makeDistributed();
        service.reactionHistory.set('room:A', [{ emoji: '\u{1F525}' } as any]);
        service.reactionHistory.set('room:B', [{ emoji: '\u{1F4AF}' } as any]);

        await service.cleanupRoom('room:A');

        expect(service.reactionHistory.has('room:A')).toBe(false);
        expect(service.reactionHistory.has('room:B')).toBe(true);
    });
});

// ─── constructor + config overrides ──────────────────────────────────────────

describe('ReactionService — constructor + config', () => {
    test('throws when logger is missing', () => {
        expect(() => new ReactionService({} as any)).toThrow(/logger is required/i);
    });

    test('isDistributed=false when no router supplied', () => {
        const svc = makeLocal();
        expect(svc.isDistributed).toBe(false);
    });

    test('availableReactions can be replaced via config', () => {
        const custom = { ':smile:': { name: 'smile', effect: 'none' } };
        const svc = new ReactionService({
            messageRouter: null,
            logger: new NoopLogger(),
            config: { availableReactions: custom },
        });
        expect(Object.keys(svc.availableReactions)).toEqual([':smile:']);
        // built-in default emoji are no longer accepted
        expect(svc.availableReactions['❤️']).toBeUndefined();
    });

    test('maxHistorySize and maxChannelNameLength honor config overrides', () => {
        const svc = new ReactionService({
            messageRouter: null,
            logger: new NoopLogger(),
            config: { maxHistorySize: 7, maxChannelNameLength: 12 },
        });
        expect(svc.maxHistorySize).toBe(7);
        expect(svc.maxChannelNameLength).toBe(12);
    });
});
