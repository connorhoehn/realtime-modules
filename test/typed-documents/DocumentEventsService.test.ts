// realtime-modules/test/typed-documents/DocumentEventsService.test.ts
//
// Lifted + adapted from gateway's test/document-events-service.test.js.
//
// Adaptations vs the gateway original:
//   - Constructor is options-bag based:
//     `new DocumentEventsService({ messageRouter, logger })`.
//   - Mocks rewritten in TS against the lifted contracts
//     (DocumentEventsMessageRouter / DocumentEventsLogger) rather than
//     ad-hoc duck-typed classes.
//   - One extra test covers the configurable `maxDocumentIdLength` option
//     (the gateway original hard-coded 100).
//
// Coverage parity with the gateway original is preserved one-for-one;
// see each `describe` for the matching gateway test name.

import { DocumentEventsService } from '../../src/typed-documents/DocumentEventsService';
import type {
    DocumentEventsLogger,
    DocumentEventsMessageRouter,
} from '../../src/typed-documents/types';

class MockMessageRouter implements DocumentEventsMessageRouter {
    subscriptions = new Map<string, Set<string>>();
    sentMessages: Array<{ clientId: string; message: any }> = [];

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

    sendToClient(clientId: string, message: any): void {
        this.sentMessages.push({ clientId, message });
    }

    reset(): void {
        this.sentMessages = [];
    }

    getSubscriptions(clientId: string): Set<string> {
        return this.subscriptions.get(clientId) ?? new Set();
    }
}

class MockLogger implements DocumentEventsLogger {
    logs: { debug: any[]; info: any[]; warn: any[]; error: any[] } = {
        debug: [],
        info: [],
        warn: [],
        error: [],
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

    hasLog(level: keyof MockLogger['logs'], searchTerm: string): boolean {
        return this.logs[level].some((log) =>
            JSON.stringify(log).toLowerCase().includes(searchTerm.toLowerCase()),
        );
    }

    reset(): void {
        this.logs = { debug: [], info: [], warn: [], error: [] };
    }
}

describe('DocumentEventsService', () => {
    let service: DocumentEventsService;
    let mockRouter: MockMessageRouter;
    let mockLogger: MockLogger;

    beforeEach(() => {
        mockRouter = new MockMessageRouter();
        mockLogger = new MockLogger();
        service = new DocumentEventsService({
            messageRouter: mockRouter,
            logger: mockLogger,
        });
    });

    afterEach(() => {
        mockRouter.reset();
        mockLogger.reset();
    });

    describe('handleAction - subscribe', () => {
        test('subscribes client to doc-comments and doc channels with valid documentId', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.has(`doc-comments:${documentId}`)).toBe(true);
            expect(subscriptions.has(`doc:${documentId}`)).toBe(true);
            expect(subscriptions.size).toBe(2);
        });

        test('sends subscribed confirmation to client', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });

            const messages = mockRouter.sentMessages.filter((m) => m.clientId === clientId);
            expect(messages.length).toBe(1);
            expect(messages[0].message.type).toBe('document-events');
            expect(messages[0].message.action).toBe('subscribed');
            expect(messages[0].message.documentId).toBe(documentId);
            expect(messages[0].message.timestamp).toBeDefined();
        });

        test('tracks subscription locally for disconnect cleanup', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(1);
            expect(stats.totalSubscriptions).toBe(2); // doc-comments + doc
        });

        test('logs subscription event', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });

            expect(mockLogger.hasLog('info', clientId)).toBe(true);
            expect(mockLogger.hasLog('info', documentId)).toBe(true);
            expect(mockLogger.hasLog('info', 'subscribed')).toBe(true);
        });

        test('rejects subscribe with missing documentId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', {});

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('documentId is required');
            expect(errorMessages[0].message.service).toBe('document-events');
        });

        test('rejects subscribe with non-string documentId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', { documentId: 123 as any });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('documentId is required');
        });

        test('rejects subscribe with empty documentId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'subscribe', { documentId: '' });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('documentId is required');
        });

        test('rejects subscribe with documentId exceeding 100 chars (default cap)', async () => {
            const clientId = 'client-1';
            const longDocumentId = 'a'.repeat(101);

            await service.handleAction(clientId, 'subscribe', { documentId: longDocumentId });

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('max 100 chars');
        });

        test('rejects subscribe with documentId exceeding configured cap (lift-only)', async () => {
            const lowCapService = new DocumentEventsService({
                messageRouter: mockRouter,
                logger: mockLogger,
                config: { maxDocumentIdLength: 10 },
            });
            await lowCapService.handleAction('client-1', 'subscribe', {
                documentId: 'a'.repeat(11),
            });
            const errs = mockRouter.sentMessages.filter((m) => m.message.type === 'error');
            expect(errs.length).toBe(1);
            expect(errs[0].message.message).toContain('max 10 chars');
        });
    });

    describe('handleAction - unsubscribe', () => {
        test('unsubscribes client from doc channels', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });
            await service.handleAction(clientId, 'unsubscribe', { documentId });

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.size).toBe(0);
        });

        test('sends unsubscribed confirmation to client', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });
            mockRouter.reset();
            await service.handleAction(clientId, 'unsubscribe', { documentId });

            const messages = mockRouter.sentMessages.filter((m) => m.clientId === clientId);
            expect(messages.length).toBe(1);
            expect(messages[0].message.type).toBe('document-events');
            expect(messages[0].message.action).toBe('unsubscribed');
            expect(messages[0].message.documentId).toBe(documentId);
        });

        test('cleans up local tracking when all subscriptions removed', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });
            await service.handleAction(clientId, 'unsubscribe', { documentId });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('rejects unsubscribe with missing documentId', async () => {
            const clientId = 'client-1';

            await service.handleAction(clientId, 'unsubscribe', {});

            const errorMessages = mockRouter.sentMessages.filter(
                (m) => m.clientId === clientId && m.message.type === 'error',
            );
            expect(errorMessages.length).toBe(1);
            expect(errorMessages[0].message.message).toContain('documentId is required');
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
            expect(errorMessages[0].message.message).toContain('Unknown document-events action');
            expect(errorMessages[0].message.message).toContain('invalid-action');
        });
    });

    describe('handleDisconnect', () => {
        test('unsubscribes from all tracked channels on disconnect', async () => {
            const clientId = 'client-1';
            const doc1 = 'doc-abc';
            const doc2 = 'doc-xyz';

            await service.handleAction(clientId, 'subscribe', { documentId: doc1 });
            await service.handleAction(clientId, 'subscribe', { documentId: doc2 });
            await service.handleDisconnect(clientId);

            const subscriptions = mockRouter.getSubscriptions(clientId);
            expect(subscriptions.size).toBe(0);
        });

        test('cleans up client tracking on disconnect', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });
            await service.handleDisconnect(clientId);

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('logs disconnect event', async () => {
            const clientId = 'client-1';
            const documentId = 'doc-abc123';

            await service.handleAction(clientId, 'subscribe', { documentId });
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

    describe('getStats', () => {
        test('returns zero stats when no subscriptions', () => {
            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(0);
            expect(stats.totalSubscriptions).toBe(0);
        });

        test('counts multiple clients and subscriptions correctly', async () => {
            await service.handleAction('client-1', 'subscribe', { documentId: 'doc-a' });
            await service.handleAction('client-2', 'subscribe', { documentId: 'doc-b' });

            const stats = service.getStats();
            expect(stats.subscribedClients).toBe(2);
            expect(stats.totalSubscriptions).toBe(4); // 2 clients × 2 channels each
        });
    });

    describe('defensive branch coverage', () => {
        test('handleUnsubscribe tolerates ghost client with no tracked entry', async () => {
            await expect(
                service.handleUnsubscribe('ghost-client', { documentId: 'doc-x' }),
            ).resolves.toBeUndefined();
            const ack = mockRouter.sentMessages.find(
                (m) => m.clientId === 'ghost-client' && m.message.action === 'unsubscribed',
            );
            expect(ack).toBeDefined();
        });

        test('handleUnsubscribe keeps client tracked when other docs remain', async () => {
            await service.handleSubscribe('client-1', { documentId: 'doc-drop' });
            await service.handleSubscribe('client-1', { documentId: 'doc-keep' });
            await service.handleUnsubscribe('client-1', { documentId: 'doc-drop' });
            const tracked = service.clientChannels.get('client-1');
            expect(tracked).toBeDefined();
            expect(tracked!.has('doc-comments:doc-keep')).toBe(true);
            expect(tracked!.has('doc:doc-keep')).toBe(true);
            expect(tracked!.size).toBe(2);
        });

        test('sendToClient and sendError are no-ops when messageRouter is null', () => {
            const noRouter = new DocumentEventsService({
                messageRouter: null,
                logger: mockLogger,
            });
            expect(() => noRouter.sendToClient('c-1', { type: 'document-events' })).not.toThrow();
            expect(() => noRouter.sendError('c-1', 'boom')).not.toThrow();
        });

        test('handleAction catches handler throws and replies with "Internal server error"', async () => {
            mockRouter.subscribeToChannel = async () => {
                throw new Error('redis down');
            };
            await service.handleAction('client-1', 'subscribe', { documentId: 'doc-x' });
            const internal = mockRouter.sentMessages.find(
                (m) =>
                    m.clientId === 'client-1' &&
                    m.message.type === 'error' &&
                    m.message.message === 'Internal server error',
            );
            expect(internal).toBeDefined();
            expect(mockLogger.logs.error.length).toBeGreaterThan(0);
        });

        test('handleDisconnect logs per-channel unsubscribe failures but still clears tracking', async () => {
            await service.handleSubscribe('client-1', { documentId: 'doc-x' });
            mockRouter.unsubscribeFromChannel = async () => {
                throw new Error('router gone');
            };
            await expect(service.handleDisconnect('client-1')).resolves.toBeUndefined();
            expect(mockLogger.logs.error.length).toBeGreaterThan(0);
            expect(service.clientChannels.has('client-1')).toBe(false);
        });

        test('constructor throws without logger', () => {
            expect(() => new (DocumentEventsService as any)({})).toThrow(/logger is required/);
            expect(() => new (DocumentEventsService as any)(undefined)).toThrow(
                /logger is required/,
            );
        });
    });
});
