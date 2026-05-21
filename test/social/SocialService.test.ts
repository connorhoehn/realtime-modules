// realtime-modules/test/social/SocialService.test.ts
//
// Lifted + adapted from gateway's test/social-service.test.js
// (~411 LOC). Same scenarios, ported to TypeScript with the options-bag
// constructor and the lifted MessageRouter contract.
//
// Adaptations vs the gateway original:
//   - Constructor is options-bag based:
//     `new SocialService({ messageRouter, logger, ... })`.
//   - Mock router implements the narrow `SocialMessageRouter` interface
//     (sendToClient / subscribeToChannel / unsubscribeFromChannel).
//   - Added constructor-validation + local-mode (null router) tests that
//     have no gateway counterpart (the gateway service always had a
//     router in practice) — these pin the lifted module's surface.

import { SocialService } from '../../src/social/SocialService';
import type {
    SocialLogger,
    SocialMessageRouter,
} from '../../src/social/types';

interface SentEntry {
    clientId: string;
    message: any;
}

class MockMessageRouter implements SocialMessageRouter {
    subscriptions = new Map<string, Set<string>>();
    sentMessages: SentEntry[] = [];

    async subscribeToChannel(clientId: string, channel: string): Promise<void> {
        if (!this.subscriptions.has(clientId)) {
            this.subscriptions.set(clientId, new Set());
        }
        this.subscriptions.get(clientId)!.add(channel);
    }

    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        const channels = this.subscriptions.get(clientId);
        if (channels) {
            channels.delete(channel);
            if (channels.size === 0) {
                this.subscriptions.delete(clientId);
            }
        }
    }

    sendToClient(clientId: string, message: unknown): void {
        this.sentMessages.push({ clientId, message });
    }

    reset(): void {
        this.sentMessages = [];
    }

    getSubscriptions(clientId: string): Set<string> {
        return this.subscriptions.get(clientId) ?? new Set();
    }
}

class MockLogger implements SocialLogger {
    logs = {
        debug: [] as Array<{ msg: string; args: unknown[] }>,
        info: [] as Array<{ msg: string; args: unknown[] }>,
        warn: [] as Array<{ msg: string; args: unknown[] }>,
        error: [] as Array<{ msg: string; args: unknown[] }>,
    };

    debug(msg: string, ...args: unknown[]): void {
        this.logs.debug.push({ msg, args });
    }
    info(msg: string, ...args: unknown[]): void {
        this.logs.info.push({ msg, args });
    }
    warn(msg: string, ...args: unknown[]): void {
        this.logs.warn.push({ msg, args });
    }
    error(msg: string, ...args: unknown[]): void {
        this.logs.error.push({ msg, args });
    }

    hasLog(level: 'debug' | 'info' | 'warn' | 'error', searchTerm: string): boolean {
        return this.logs[level].some((log) =>
            JSON.stringify(log).toLowerCase().includes(searchTerm.toLowerCase()),
        );
    }

    reset(): void {
        this.logs = { debug: [], info: [], warn: [], error: [] };
    }
}

describe('SocialService', () => {
    let service: SocialService;
    let mockRouter: MockMessageRouter;
    let mockLogger: MockLogger;

    beforeEach(() => {
        mockRouter = new MockMessageRouter();
        mockLogger = new MockLogger();
        service = new SocialService({ messageRouter: mockRouter, logger: mockLogger });
    });

    afterEach(() => {
        mockRouter.reset();
        mockLogger.reset();
    });

    describe('handleAction - subscribe', () => {
        test('subscribes client to social channel with valid channelId', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.has(channelId)).toBe(true);
            expect(subscriptions.size).toBe(1);
        });

        test('sends subscribed confirmation to client', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });

            const messages = mockRouter.sentMessages.filter((m) => m.clientId === clientId);
            expect(messages.length).toBe(1);
            expect(messages[0].message.type).toBe('social');
            expect(messages[0].message.action).toBe('subscribed');
            expect(messages[0].message.channelId).toBe(channelId);
            expect(messages[0].message.timestamp).toBeDefined();
        });

        test('tracks subscription locally for disconnect cleanup', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(1);
            expect(stats.totalSubscriptions).toBe(1);
        });

        test('logs subscription event', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });

            expect(mockLogger.hasLog('info', clientId)).toBe(true);
            expect(mockLogger.hasLog('info', channelId)).toBe(true);
            expect(mockLogger.hasLog('info', 'subscribed')).toBe(true);
        });

        test('allows client to subscribe to multiple channels', async () => {
            const clientId = 'client-1';
            const channel1 = 'room-abc';
            const channel2 = 'room-xyz';

            await service.handleAction(clientId, 'subscribe', { channelId: channel1 });
            await service.handleAction(clientId, 'subscribe', { channelId: channel2 });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.has(channel1)).toBe(true);
            expect(subscriptions.has(channel2)).toBe(true);
            expect(subscriptions.size).toBe(2);

            const stats = service.getStats();
            expect(stats.totalSubscriptions).toBe(2);
        });

        test('rejects subscribe with missing channelId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', {});

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('channelId is required');
            expect(errorMessages[0].message.service).toBe('social');
        });

        test('rejects subscribe with non-string channelId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', { channelId: 123 as any });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('channelId is required');
        });

        test('rejects subscribe with empty channelId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', { channelId: '' });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('channelId is required');
        });

        test('rejects subscribe with channelId exceeding 100 chars', async () => {
            const clientId = 'client-1';
            const longChannelId = 'a'.repeat(101);

            await service.handleAction(clientId, 'subscribe', { channelId: longChannelId });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('max 100 chars');
        });
    });

    describe('handleAction - unsubscribe', () => {
        test('unsubscribes client from social channel', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });
            await service.handleAction(clientId, 'unsubscribe', { channelId });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.size).toBe(0);
        });

        test('sends unsubscribed confirmation to client', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });
            mockRouter.reset();
            await service.handleAction(clientId, 'unsubscribe', { channelId });

            const messages = mockRouter.sentMessages.filter((m) => m.clientId === clientId);
            expect(messages.length).toBe(1);
            expect(messages[0].message.type).toBe('social');
            expect(messages[0].message.action).toBe('unsubscribed');
            expect(messages[0].message.channelId).toBe(channelId);
        });

        test('cleans up local tracking when all subscriptions removed', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });
            await service.handleAction(clientId, 'unsubscribe', { channelId });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('unsubscribes from one channel while maintaining others', async () => {
            const clientId = 'client-1';
            const channel1 = 'room-abc';
            const channel2 = 'room-xyz';

            await service.handleAction(clientId, 'subscribe', { channelId: channel1 });
            await service.handleAction(clientId, 'subscribe', { channelId: channel2 });
            await service.handleAction(clientId, 'unsubscribe', { channelId: channel1 });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.has(channel1)).toBe(false);
            expect(subscriptions.has(channel2)).toBe(true);
            expect(subscriptions.size).toBe(1);
        });

        test('rejects unsubscribe with missing channelId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'unsubscribe', {});

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('channelId is required');
        });
    });

    describe('handleAction - unknown action', () => {
        test('sends error for unknown action', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'invalid-action', {});

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('Unknown social action');
            expect(errorMessages[0].message.message).toContain('invalid-action');
        });
    });

    describe('handleDisconnect', () => {
        test('unsubscribes from all tracked channels on disconnect', async () => {
            const clientId = 'client-1';
            const channel1 = 'room-abc';
            const channel2 = 'room-xyz';

            await service.handleAction(clientId, 'subscribe', { channelId: channel1 });
            await service.handleAction(clientId, 'subscribe', { channelId: channel2 });
            await service.handleDisconnect(clientId);

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.size).toBe(0);
        });

        test('cleans up client tracking on disconnect', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });
            await service.handleDisconnect(clientId);

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('logs disconnect event', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'subscribe', { channelId });
            mockLogger.reset();
            await service.handleDisconnect(clientId);

            expect(mockLogger.hasLog('debug', clientId)).toBe(true);
            expect(mockLogger.hasLog('debug', 'disconnected')).toBe(true);
        });

        test('handles disconnect for client with no subscriptions gracefully', async () => {
            const clientId = 'client-unknown';

            await expect(service.handleDisconnect(clientId)).resolves.not.toThrow();
        });
    });

    describe('error handling', () => {
        test('handleAction outer catch: messageRouter throw triggers logger.error + generic error frame', async () => {
            const clientId = 'client-1';
            const channelId = 'room-abc123';
            mockRouter.subscribeToChannel = async () => {
                throw new Error('redis down');
            };

            await service.handleAction(clientId, 'subscribe', { channelId });

            expect(mockLogger.hasLog('error', clientId)).toBe(true);
            expect(mockLogger.hasLog('error', 'subscribe')).toBe(true);
            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toBe('Internal server error');
            expect(errorMessages[0].message.service).toBe('social');
        });

        test('handleUnsubscribe: tolerates client with no prior subscription tracking', async () => {
            const clientId = 'client-unknown';
            const channelId = 'room-abc123';

            await service.handleAction(clientId, 'unsubscribe', { channelId });

            // No local tracking, but unsubscribed confirmation still sent
            const messages = mockRouter.sentMessages.filter((m) => m.clientId === clientId);
            expect(messages.length).toBe(1);
            expect(messages[0].message.action).toBe('unsubscribed');
            expect(service.getStats().subscribedClients).toBe(0);
        });

        test('sendToClient is a no-op when messageRouter is null', () => {
            const nullRouterService = new SocialService({
                messageRouter: null,
                logger: mockLogger,
            });
            expect(() => nullRouterService.sendError('client-x', 'whatever')).not.toThrow();
        });

        test('handleDisconnect: per-channel unsubscribe throw is logged, loop continues, tracking cleared', async () => {
            const clientId = 'client-1';
            const channel1 = 'room-abc';
            const channel2 = 'room-xyz';

            await service.handleAction(clientId, 'subscribe', { channelId: channel1 });
            await service.handleAction(clientId, 'subscribe', { channelId: channel2 });
            mockLogger.reset();

            const unsubscribed: string[] = [];
            mockRouter.unsubscribeFromChannel = async (cid: string, ch: string) => {
                if (ch === channel1) throw new Error('redis down');
                unsubscribed.push(ch);
            };

            await service.handleDisconnect(clientId);

            expect(mockLogger.hasLog('error', channel1)).toBe(true);
            expect(mockLogger.hasLog('error', 'unsubscribing')).toBe(true);
            expect(unsubscribed).toContain(channel2);
            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });
    });

    describe('getStats', () => {
        test('returns zero stats when no subscriptions', () => {
            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('counts multiple clients and subscriptions correctly', async () => {
            await service.handleAction('client-1', 'subscribe', { channelId: 'room-a' });
            await service.handleAction('client-1', 'subscribe', { channelId: 'room-b' });
            await service.handleAction('client-2', 'subscribe', { channelId: 'room-c' });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(2);
            expect(stats.totalSubscriptions).toBe(3); // client-1 has 2, client-2 has 1
        });
    });

    // ─── constructor + config overrides (lifted-module-specific) ────────────
    describe('constructor + config', () => {
        test('throws when logger is missing', () => {
            expect(() => new SocialService({} as any)).toThrow(/logger is required/i);
        });

        test('maxChannelIdLength honors config override', () => {
            const svc = new SocialService({
                messageRouter: null,
                logger: mockLogger,
                config: { maxChannelIdLength: 25 },
            });
            expect(svc.maxChannelIdLength).toBe(25);
        });

        test('subscribe rejects channelId exceeding configured maxChannelIdLength', async () => {
            const svc = new SocialService({
                messageRouter: mockRouter,
                logger: mockLogger,
                config: { maxChannelIdLength: 10 },
            });
            const tooLong = 'a'.repeat(11);
            await svc.handleAction('c1', 'subscribe', { channelId: tooLong });

            const errs = mockRouter.sentMessages.filter(
                (m) => m.clientId === 'c1' && m.message.type === 'error',
            );
            expect(errs.length).toBe(1);
            expect(errs[0].message.message).toContain('max 10 chars');
        });
    });

    // ─── local mode (messageRouter = null) ───────────────────────────────────
    describe('local mode (messageRouter=null)', () => {
        test('subscribe tracks client locally without calling a router', async () => {
            const svc = new SocialService({ messageRouter: null, logger: mockLogger });
            await svc.handleAction('c1', 'subscribe', { channelId: 'room-a' });
            expect(svc.clientChannels.has('c1')).toBe(true);
            expect(svc.getStats().totalSubscriptions).toBe(1);
        });

        test('unsubscribe removes client locally without calling a router', async () => {
            const svc = new SocialService({ messageRouter: null, logger: mockLogger });
            await svc.handleAction('c1', 'subscribe', { channelId: 'room-a' });
            await svc.handleAction('c1', 'unsubscribe', { channelId: 'room-a' });
            expect(svc.clientChannels.has('c1')).toBe(false);
        });

        test('handleDisconnect in local mode clears tracking and does not throw', async () => {
            const svc = new SocialService({ messageRouter: null, logger: mockLogger });
            await svc.handleAction('c1', 'subscribe', { channelId: 'room-a' });
            await expect(svc.handleDisconnect('c1')).resolves.not.toThrow();
            expect(svc.clientChannels.has('c1')).toBe(false);
        });
    });
});
