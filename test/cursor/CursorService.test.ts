// realtime-modules/test/cursor/CursorService.test.ts
//
// Lifted + adapted from gateway's cursor-service test suite:
//   - cursor-service-pure.test.js         (validation + helpers + throttle)
//   - cursor-service-update.test.js       (handleUpdateCursor + dispatch + disconnect + stats)
//   - cursor-service-subscription.test.js (modes + subscribe/unsubscribe handlers)
//   - cursor-service-cleanup.test.js      (shutdown + TTL sweep + remove*)
//   - cursor-service-ownership.test.js    (cleanupRoom — adapted; coordinator
//                                          handlers no longer lift)
//
// Adaptations vs gateway originals:
//   - jest.mock('authz-interceptor') removed; tests pass an explicit
//     `authorizeChannel` hook through CursorConfig instead.
//   - jest.mock('ownership-cleanup-coordinator') removed; gateway-specific
//     coordinator wiring is no longer in the lifted module. cleanupRoom()
//     is exercised directly (renamed from gateway's _cleanupRoom).
//   - Constructor is options-bag based:
//       new CursorService({ messageRouter, logger, config: { ... } })
//   - CursorService now requires messageRouter (gateway original also did,
//     but checked at sendToClient call-time; lifted version checks in ctor).

import { CursorService } from '../../src/cursor/CursorService';
import type {
    CursorLogger,
    CursorMessageRouter,
    CursorMetricsCollector,
} from '../../src/cursor/types';

class NoopLogger implements CursorLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

class SpyLogger implements CursorLogger {
    infos: string[] = [];
    debugs: string[] = [];
    warns: Array<{ msg: string; meta?: unknown }> = [];
    debug(msg: string): void { this.debugs.push(msg); }
    info(msg: string): void { this.infos.push(msg); }
    warn(msg: string, meta?: unknown): void { this.warns.push({ msg, meta }); }
    error(): void {}
}

interface SentEntry { clientId: string; message: any }
interface ChannelSendEntry { channel: string; message: any; excludeClientId?: string }
interface SubEntry { clientId: string; channel: string }

class MockRouter implements CursorMessageRouter {
    sent: SentEntry[] = [];
    channelSent: ChannelSendEntry[] = [];
    subscribed: SubEntry[] = [];
    unsubscribed: SubEntry[] = [];

    sendToClient(clientId: string, message: any): void {
        this.sent.push({ clientId, message });
    }
    async sendToChannel(channel: string, message: any, excludeClientId?: string): Promise<void> {
        this.channelSent.push({ channel, message, excludeClientId });
    }
    async subscribeToChannel(clientId: string, channel: string): Promise<void> {
        this.subscribed.push({ clientId, channel });
    }
    async unsubscribeFromChannel(clientId: string, channel: string): Promise<void> {
        this.unsubscribed.push({ clientId, channel });
    }
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

function makeService(opts: {
    authz?: (clientId: string, channel: string) => boolean;
    logger?: CursorLogger;
    metricsCollector?: CursorMetricsCollector | null;
} = {}): { svc: CursorService; router: MockRouter } {
    const router = new MockRouter();
    const svc = new CursorService({
        messageRouter: router,
        logger: opts.logger ?? new NoopLogger(),
        metricsCollector: opts.metricsCollector ?? null,
        config: {
            authorizeChannel: opts.authz,
        },
    });
    return { svc, router };
}

function seedCursor(svc: CursorService, clientId: string, channel: string, tsOverride?: string) {
    const ts = tsOverride || new Date().toISOString();
    const data: any = { clientId, channel, position: { x: 0, y: 0 }, metadata: {}, timestamp: ts };
    svc.clientCursors.set(clientId, data);
    if (!svc.channelCursors.has(channel)) {
        svc.channelCursors.set(channel, new Map());
    }
    svc.channelCursors.get(channel)!.set(clientId, data);
    return data;
}

afterEach(() => jest.clearAllMocks());

// ─── validatePositionForMode ─────────────────────────────────────────────────

describe('CursorService — validatePositionForMode', () => {
    let svc: CursorService;
    beforeEach(() => { ({ svc } = makeService()); });
    afterEach(async () => { await svc.shutdown(); });

    test('freeform: valid x/y returns true', () => {
        expect(svc.validatePositionForMode({ x: 10, y: 20 }, 'freeform')).toBe(true);
    });

    test('freeform: missing y returns false', () => {
        expect(svc.validatePositionForMode({ x: 10 }, 'freeform')).toBe(false);
    });

    test('freeform: non-number x returns false', () => {
        expect(svc.validatePositionForMode({ x: '10', y: 20 }, 'freeform')).toBe(false);
    });

    test('table: valid row/col returns true', () => {
        expect(svc.validatePositionForMode({ row: 0, col: 3 }, 'table')).toBe(true);
    });

    test('table: negative row returns false', () => {
        expect(svc.validatePositionForMode({ row: -1, col: 0 }, 'table')).toBe(false);
    });

    test('text: valid position >= 0 returns true', () => {
        expect(svc.validatePositionForMode({ position: 42 }, 'text')).toBe(true);
    });

    test('text: position < 0 returns false', () => {
        expect(svc.validatePositionForMode({ position: -1 }, 'text')).toBe(false);
    });

    test('canvas: valid x/y returns true', () => {
        expect(svc.validatePositionForMode({ x: 5, y: 10 }, 'canvas')).toBe(true);
    });

    test('unknown mode returns false', () => {
        expect(svc.validatePositionForMode({ x: 5, y: 10 }, 'no-such-mode')).toBe(false);
    });
});

// ─── generateInitials / generateUserColor ────────────────────────────────────

describe('CursorService — generateInitials', () => {
    let svc: CursorService;
    beforeEach(() => { ({ svc } = makeService()); });
    afterEach(async () => { await svc.shutdown(); });

    test('returns first 2 chars uppercased', () => {
        expect(svc.generateInitials('alice')).toBe('AL');
    });

    test('returns whole string when shorter than 2 chars', () => {
        expect(svc.generateInitials('x').length).toBeLessThanOrEqual(2);
    });
});

describe('CursorService — generateUserColor', () => {
    let svc: CursorService;
    beforeEach(() => { ({ svc } = makeService()); });
    afterEach(async () => { await svc.shutdown(); });

    test('returns a hex color string starting with #', () => {
        expect(svc.generateUserColor('client-abc')).toMatch(/^#[0-9A-F]{6}$/i);
    });

    test('same clientId always produces the same color', () => {
        expect(svc.generateUserColor('client-abc')).toBe(svc.generateUserColor('client-abc'));
    });

    test('different clientIds produce valid colors', () => {
        expect(svc.generateUserColor('aaaaaaaaaa')).toMatch(/^#[0-9A-F]{6}$/i);
        expect(svc.generateUserColor('bbbbbbbbbb')).toMatch(/^#[0-9A-F]{6}$/i);
    });
});

// ─── storeLocalCursorData / getLocalChannelCursors ───────────────────────────

describe('CursorService — storeLocalCursorData / getLocalChannelCursors', () => {
    let svc: CursorService;
    beforeEach(() => { ({ svc } = makeService()); });
    afterEach(async () => { await svc.shutdown(); });

    test('stores cursor data in clientCursors map', () => {
        svc.storeLocalCursorData('c1', 'room:1', { x: 10, y: 20 } as any);
        expect(svc.clientCursors.get('c1')).toEqual({ x: 10, y: 20 });
    });

    test('stores cursor data in channelCursors map', () => {
        svc.storeLocalCursorData('c1', 'room:1', { x: 10, y: 20 } as any);
        const channelMap = svc.channelCursors.get('room:1');
        expect(channelMap).toBeDefined();
        expect(channelMap!.get('c1')).toEqual({ x: 10, y: 20 });
    });

    test('getLocalChannelCursors returns empty for unknown channel', () => {
        expect(svc.getLocalChannelCursors('no-such')).toEqual([]);
    });

    test('getLocalChannelCursors returns all cursors in a channel', () => {
        svc.storeLocalCursorData('c1', 'room:1', { x: 1, y: 2 } as any);
        svc.storeLocalCursorData('c2', 'room:1', { x: 3, y: 4 } as any);
        expect(svc.getLocalChannelCursors('room:1')).toHaveLength(2);
    });

    test('subsequent store overwrites previous data for same client + channel', () => {
        svc.storeLocalCursorData('c1', 'room:1', { x: 1, y: 2 } as any);
        svc.storeLocalCursorData('c1', 'room:1', { x: 99, y: 99 } as any);
        expect(svc.clientCursors.get('c1')).toEqual({ x: 99, y: 99 });
    });
});

// ─── shouldUpdateCursor (throttle) ───────────────────────────────────────────

describe('CursorService — shouldUpdateCursor', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('first call for a client returns true', () => {
        const { svc } = makeService();
        expect(svc.shouldUpdateCursor('c1')).toBe(true);
    });

    test('immediate second call is throttled (returns false)', () => {
        const { svc } = makeService();
        svc.shouldUpdateCursor('c1');
        expect(svc.shouldUpdateCursor('c1')).toBe(false);
    });

    test('call after throttle interval returns true again', () => {
        const { svc } = makeService();
        svc.shouldUpdateCursor('c1');
        jest.advanceTimersByTime(svc.throttleInterval + 1);
        expect(svc.shouldUpdateCursor('c1')).toBe(true);
    });

    test('different clients have independent throttle buckets', () => {
        const { svc } = makeService();
        svc.shouldUpdateCursor('c1');
        expect(svc.shouldUpdateCursor('c2')).toBe(true);
    });
});

// ─── handleGetCursors ─────────────────────────────────────────────────────────

describe('CursorService — handleGetCursors', () => {
    test('sends error when channel is missing', async () => {
        const { svc, router } = makeService();
        await svc.handleGetCursors('c1', {} as any);
        const msgs = sentTo(router, 'c1');
        expect(msgs.length).toBeGreaterThan(0);
        expect(msgs[0].type).toBe('error');
        await svc.shutdown();
    });

    test('sends cursor list when channel is provided', async () => {
        const { svc, router } = makeService();
        svc.storeLocalCursorData('c2', 'room:1', { x: 5, y: 6, timestamp: new Date().toISOString() } as any);
        await svc.handleGetCursors('c1', { channel: 'room:1' });
        const msg = sentTo(router, 'c1')[0];
        expect(msg.action).toBe('cursors');
        expect(msg.channel).toBe('room:1');
        expect(Array.isArray(msg.cursors)).toBe(true);
        await svc.shutdown();
    });
});

// ─── handleUpdateCursor: validation ──────────────────────────────────────────

describe('CursorService — handleUpdateCursor: validation', () => {
    test('missing channel sends error and returns early', async () => {
        const { svc, router } = makeService();
        await svc.handleUpdateCursor('c-1', { position: { x: 10, y: 20 } } as any);
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
        await svc.shutdown();
    });

    test('missing position sends error and returns early', async () => {
        const { svc, router } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1' } as any);
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
        await svc.shutdown();
    });

    test('unsupported mode sends error', async () => {
        const { svc, router } = makeService();
        await svc.handleUpdateCursor('c-1', {
            channel: 'board-1',
            position: { x: 5, y: 5 },
            mode: 'holographic',
        });
        const errs = sentTo(router, 'c-1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(1);
        await svc.shutdown();
    });

    test('invalid position for mode (missing required field) sends error', async () => {
        const { svc, router } = makeService();
        await svc.handleUpdateCursor('c-1', {
            channel: 'board-1',
            position: { x: 5 }, // missing y
            mode: 'freeform',
        });
        const errs = sentTo(router, 'c-1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(1);
        await svc.shutdown();
    });
});

// ─── handleUpdateCursor: happy path ──────────────────────────────────────────

describe('CursorService — handleUpdateCursor: happy path', () => {
    test('stores cursor data in clientCursors map after valid update', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 10, y: 20 } });
        expect(svc.clientCursors.has('c-1')).toBe(true);
        expect(svc.clientCursors.get('c-1')!.position).toEqual({ x: 10, y: 20 });
        await svc.shutdown();
    });

    test('stores cursor data in channelCursors map', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 10, y: 20 } });
        expect(svc.channelCursors.has('board-1')).toBe(true);
        expect(svc.channelCursors.get('board-1')!.has('c-1')).toBe(true);
        await svc.shutdown();
    });

    test('text mode with valid position stores cursor', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'doc-1', position: { position: 42 }, mode: 'text' });
        expect(svc.clientCursors.has('c-1')).toBe(true);
        await svc.shutdown();
    });

    test('table mode with valid row/col stores cursor', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'sheet-1', position: { row: 3, col: 7 }, mode: 'table' });
        expect(svc.clientCursors.has('c-1')).toBe(true);
        await svc.shutdown();
    });

    test('broadcasts cursor update to channel via router.sendToChannel', async () => {
        const { svc, router } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        expect(router.channelSent.length).toBeGreaterThan(0);
        const broadcast = router.channelSent.find((e) => e.channel.includes('board-1'));
        expect(broadcast).toBeTruthy();
        await svc.shutdown();
    });

    test('enriches cursor data with userInitials and userColor', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 5, y: 5 } });
        const cursor = svc.clientCursors.get('c-1')!;
        expect(cursor.metadata.userInitials).toBeTruthy();
        expect(cursor.metadata.userColor).toMatch(/^#/);
        await svc.shutdown();
    });
});

// ─── handleAction (dispatch) ──────────────────────────────────────────────────

describe('CursorService — handleAction dispatch', () => {
    test('dispatches "update" to handleUpdateCursor', async () => {
        const { svc } = makeService();
        await svc.handleAction('c-1', 'update', { channel: 'board-1', position: { x: 1, y: 2 } });
        expect(svc.clientCursors.has('c-1')).toBe(true);
        await svc.shutdown();
    });

    test('dispatches "modes" to handleGetModes (sends modes frame)', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c-1', 'modes', {});
        const frames = sentTo(router, 'c-1').filter((m) => m.action === 'modes');
        expect(frames).toHaveLength(1);
        await svc.shutdown();
    });

    test('dispatches "get" to handleGetCursors', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c-1', 'get', { channel: 'board-1' });
        const frames = sentTo(router, 'c-1').filter((m) => m.action === 'cursors');
        expect(frames).toHaveLength(1);
        await svc.shutdown();
    });

    test('dispatches "subscribe" to handleSubscribeCursors', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c-1', 'subscribe', { channel: 'board-1' });
        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'subscribed');
        expect(acks).toHaveLength(1);
        await svc.shutdown();
    });

    test('dispatches "unsubscribe" to handleUnsubscribeCursors', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c-1', 'unsubscribe', { channel: 'board-1' });
        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'unsubscribed');
        expect(acks).toHaveLength(1);
        await svc.shutdown();
    });

    test('sends error for unknown action', async () => {
        const { svc, router } = makeService();
        await svc.handleAction('c-1', 'fly', {});
        const errs = sentTo(router, 'c-1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(1);
        await svc.shutdown();
    });
});

// ─── getStats ─────────────────────────────────────────────────────────────────

describe('CursorService — getStats', () => {
    test('returns zero stats when no activity', () => {
        const { svc } = makeService();
        const stats = svc.getStats();
        expect(stats.connectedClients).toBe(0);
        expect(stats.activeChannels).toBe(0);
        void svc.shutdown();
    });

    test('connectedClients reflects clientCursors size after update', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        await svc.handleUpdateCursor('c-2', { channel: 'board-1', position: { x: 3, y: 4 } });
        expect(svc.getStats().connectedClients).toBe(2);
        await svc.shutdown();
    });

    test('activeChannels reflects channelCursors map size', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        await svc.handleUpdateCursor('c-2', { channel: 'board-2', position: { x: 3, y: 4 } });
        expect(svc.getStats().activeChannels).toBe(2);
        await svc.shutdown();
    });

    test('isDistributed is true (router is always required)', () => {
        const { svc } = makeService();
        expect(svc.getStats().isDistributed).toBe(true);
        void svc.shutdown();
    });
});

// ─── handleGetModes ───────────────────────────────────────────────────────────

describe('CursorService — handleGetModes', () => {
    test('sends a frame with type:cursor action:modes', async () => {
        const { svc, router } = makeService();
        await svc.handleGetModes('c-1', {});
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('cursor');
        expect(msgs[0].action).toBe('modes');
        await svc.shutdown();
    });

    test('modes payload is an object (the supportedModes map)', async () => {
        const { svc, router } = makeService();
        await svc.handleGetModes('c-1', {});
        const msg = sentTo(router, 'c-1')[0];
        expect(typeof msg.modes).toBe('object');
        expect(msg.modes).not.toBeNull();
        await svc.shutdown();
    });

    test('response includes a timestamp string', async () => {
        const { svc, router } = makeService();
        await svc.handleGetModes('c-1', {});
        const msg = sentTo(router, 'c-1')[0];
        expect(typeof msg.timestamp).toBe('string');
        await svc.shutdown();
    });

    test('includes at least the "freeform" mode', async () => {
        const { svc, router } = makeService();
        await svc.handleGetModes('c-1', {});
        const msg = sentTo(router, 'c-1')[0];
        expect(msg.modes).toHaveProperty('freeform');
        await svc.shutdown();
    });
});

// ─── handleSubscribeCursors ───────────────────────────────────────────────────

describe('CursorService — handleSubscribeCursors: validation', () => {
    test('missing channel sends error and returns early', async () => {
        const { svc, router } = makeService();
        await svc.handleSubscribeCursors('c-1', {} as any);
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
        await svc.shutdown();
    });

    test('authz hook returning false denies subscription', async () => {
        const { svc, router } = makeService({ authz: () => false });
        await svc.handleSubscribeCursors('c-1', { channel: 'room-1' });
        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'subscribed');
        expect(acks).toHaveLength(0);
        const errs = sentTo(router, 'c-1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0].error.message).toMatch(/not authorized/i);
        await svc.shutdown();
    });
});

describe('CursorService — handleSubscribeCursors: happy path', () => {
    test('sends subscribed ack with channel + timestamp', async () => {
        const { svc, router } = makeService();
        await svc.handleSubscribeCursors('c-1', { channel: 'board-1' });
        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'subscribed');
        expect(acks).toHaveLength(1);
        expect(acks[0].type).toBe('cursor');
        expect(acks[0].channel).toBe('board-1');
        expect(typeof acks[0].timestamp).toBe('string');
        await svc.shutdown();
    });

    test('cursors array is included in the ack (may be empty)', async () => {
        const { svc, router } = makeService();
        await svc.handleSubscribeCursors('c-1', { channel: 'board-1' });
        const ack = sentTo(router, 'c-1').find((m) => m.action === 'subscribed');
        expect(Array.isArray(ack.cursors)).toBe(true);
        await svc.shutdown();
    });

    test('calls subscribeToChannel with cursor: prefix on the router', async () => {
        const { svc, router } = makeService();
        await svc.handleSubscribeCursors('c-1', { channel: 'board-1' });
        expect(router.subscribed).toContainEqual({ clientId: 'c-1', channel: 'cursor:board-1' });
        await svc.shutdown();
    });
});

// ─── handleUnsubscribeCursors ─────────────────────────────────────────────────

describe('CursorService — handleUnsubscribeCursors', () => {
    test('missing channel sends error and returns early', async () => {
        const { svc, router } = makeService();
        await svc.handleUnsubscribeCursors('c-1', {} as any);
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
        await svc.shutdown();
    });

    test('sends unsubscribed ack with channel + timestamp', async () => {
        const { svc, router } = makeService();
        await svc.handleUnsubscribeCursors('c-1', { channel: 'board-1' });
        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('cursor');
        expect(msgs[0].action).toBe('unsubscribed');
        expect(msgs[0].channel).toBe('board-1');
        expect(typeof msgs[0].timestamp).toBe('string');
        await svc.shutdown();
    });

    test('calls unsubscribeFromChannel with cursor: prefix on the router', async () => {
        const { svc, router } = makeService();
        await svc.handleUnsubscribeCursors('c-1', { channel: 'board-2' });
        expect(router.unsubscribed).toContainEqual({ clientId: 'c-1', channel: 'cursor:board-2' });
        await svc.shutdown();
    });
});

// ─── onClientDisconnect ───────────────────────────────────────────────────────

describe('CursorService — onClientDisconnect', () => {
    test('removes client from clientCursors on disconnect', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        await svc.onClientDisconnect('c-1');
        expect(svc.clientCursors.has('c-1')).toBe(false);
        await svc.shutdown();
    });

    test('removes client from channelCursors on disconnect', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        await svc.onClientDisconnect('c-1');
        expect(svc.channelCursors.has('board-1')).toBe(false);
        await svc.shutdown();
    });

    test('removes channel map when last client in channel disconnects', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        await svc.handleUpdateCursor('c-2', { channel: 'board-1', position: { x: 3, y: 4 } });

        await svc.onClientDisconnect('c-1');
        expect(svc.channelCursors.get('board-1')!.has('c-1')).toBe(false);
        expect(svc.channelCursors.get('board-1')!.has('c-2')).toBe(true);

        await svc.onClientDisconnect('c-2');
        expect(svc.channelCursors.has('board-1')).toBe(false);
        await svc.shutdown();
    });

    test('cleans up throttle entry on disconnect', async () => {
        const { svc } = makeService();
        await svc.handleUpdateCursor('c-1', { channel: 'board-1', position: { x: 1, y: 2 } });
        expect(svc.cursorUpdateThrottle.has('c-1')).toBe(true);
        await svc.onClientDisconnect('c-1');
        expect(svc.cursorUpdateThrottle.has('c-1')).toBe(false);
        await svc.shutdown();
    });

    test('is a no-op for a client that never updated', async () => {
        const { svc } = makeService();
        await expect(svc.onClientDisconnect('c-unknown')).resolves.toBeUndefined();
        await svc.shutdown();
    });
});

// ─── shutdown ─────────────────────────────────────────────────────────────────

describe('CursorService — shutdown', () => {
    test('stops the cleanup sweep without error', async () => {
        const { svc } = makeService();
        await expect(svc.shutdown()).resolves.not.toThrow();
    });

    test('clears clientCursors, channelCursors, and cursorUpdateThrottle', async () => {
        const { svc } = makeService();
        seedCursor(svc, 'c1', 'room:1');
        svc.cursorUpdateThrottle.set('c1', Date.now());

        await svc.shutdown();

        expect(svc.clientCursors.size).toBe(0);
        expect(svc.channelCursors.size).toBe(0);
        expect(svc.cursorUpdateThrottle.size).toBe(0);
    });

    test('is safe to call shutdown twice (idempotent)', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        await expect(svc.shutdown()).resolves.not.toThrow();
    });
});

// ─── cleanupStaleData ─────────────────────────────────────────────────────────

describe('CursorService — cleanupStaleData', () => {
    test('no-op when clientCursors is empty', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        svc.cleanupStaleData();
        expect(svc.clientCursors.size).toBe(0);
    });

    test('does not remove fresh cursors', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        svc.cleanupStaleData();
        expect(svc.clientCursors.has('c1')).toBe(true);
    });

    test('removes cursors older than cursorTTL', async () => {
        const { svc, router } = makeService();
        await svc.shutdown();
        const staleTs = new Date(Date.now() - svc.cursorTTL - 1000).toISOString();
        seedCursor(svc, 'c-stale', 'room:1', staleTs);

        svc.cleanupStaleData();
        await Promise.resolve();
        await Promise.resolve();

        expect(svc.clientCursors.has('c-stale')).toBe(false);
        expect(router.channelSent.length).toBeGreaterThan(0);
    });

    test('leaves fresh cursors untouched when stale ones are removed', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        const staleTs = new Date(Date.now() - svc.cursorTTL - 1000).toISOString();
        seedCursor(svc, 'c-stale', 'room:1', staleTs);
        seedCursor(svc, 'c-fresh', 'room:1');

        svc.cleanupStaleData();
        await Promise.resolve();
        await Promise.resolve();

        expect(svc.clientCursors.has('c-stale')).toBe(false);
        expect(svc.clientCursors.has('c-fresh')).toBe(true);
    });

    test('logs info when stale cursors are found', async () => {
        const logger = new SpyLogger();
        const { svc } = makeService({ logger });
        await svc.shutdown();
        const staleTs = new Date(Date.now() - svc.cursorTTL - 1000).toISOString();
        seedCursor(svc, 'c-stale', 'room:1', staleTs);

        svc.cleanupStaleData();
        await Promise.resolve();

        expect(logger.infos.some((m) => /stale/.test(m))).toBe(true);
    });
});

// ─── removeStaleClientCursor ──────────────────────────────────────────────────

describe('CursorService — removeStaleClientCursor', () => {
    test('no-op for an unknown clientId', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        await expect(svc.removeStaleClientCursor('ghost')).resolves.not.toThrow();
    });

    test('removes the client from clientCursors', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeStaleClientCursor('c1');
        expect(svc.clientCursors.has('c1')).toBe(false);
    });

    test('removes the client from channelCursors', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeStaleClientCursor('c1');
        expect(svc.channelCursors.has('room:1')).toBe(false);
    });

    test('removes cursorUpdateThrottle entry', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        svc.cursorUpdateThrottle.set('c1', Date.now());
        await svc.removeStaleClientCursor('c1');
        expect(svc.cursorUpdateThrottle.has('c1')).toBe(false);
    });

    test('broadcasts cursor removal to the channel', async () => {
        const { svc, router } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeStaleClientCursor('c1');
        const removeMsg = router.channelSent.find(
            (e) => e.channel === 'cursor:room:1' && e.message.action === 'remove',
        );
        expect(removeMsg).toBeDefined();
        expect(removeMsg!.message.clientId).toBe('c1');
    });

    test('leaves other clients in the channel intact', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        seedCursor(svc, 'c2', 'room:1');
        await svc.removeStaleClientCursor('c1');
        expect(svc.channelCursors.has('room:1')).toBe(true);
        expect(svc.channelCursors.get('room:1')!.has('c2')).toBe(true);
    });
});

// ─── broadcastCursorRemoval ───────────────────────────────────────────────────

describe('CursorService — broadcastCursorRemoval', () => {
    test('sends a cursor:remove message to the prefixed channel', async () => {
        const { svc, router } = makeService();
        await svc.shutdown();
        await svc.broadcastCursorRemoval('room:A', 'c1');
        const removeMsg = router.channelSent.find((e) => e.channel === 'cursor:room:A');
        expect(removeMsg).toBeDefined();
        expect(removeMsg!.message).toMatchObject({
            type: 'cursor',
            action: 'remove',
            channel: 'room:A',
            clientId: 'c1',
        });
    });
});

// ─── removeLocalCursorData / removeCursorData ─────────────────────────────────

describe('CursorService — removeLocalCursorData', () => {
    test('no-op for an unknown clientId', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        await expect(svc.removeLocalCursorData('ghost')).resolves.not.toThrow();
    });

    test('removes client entry from clientCursors', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeLocalCursorData('c1');
        expect(svc.clientCursors.has('c1')).toBe(false);
    });

    test('removes client entry from channelCursors', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeLocalCursorData('c1');
        expect(svc.channelCursors.has('room:1')).toBe(false);
    });

    test('broadcasts cursor removal', async () => {
        const { svc, router } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        await svc.removeLocalCursorData('c1');
        const removeMsg = router.channelSent.find(
            (e) => e.channel === 'cursor:room:1' && e.message.action === 'remove',
        );
        expect(removeMsg).toBeDefined();
    });

    test('removeCursorData delegates to removeLocalCursorData', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        const spy = jest.spyOn(svc, 'removeLocalCursorData');
        await svc.removeCursorData('c1');
        expect(spy).toHaveBeenCalledWith('c1');
        spy.mockRestore();
    });
});

// ─── getChannelCursors ────────────────────────────────────────────────────────

describe('CursorService — getChannelCursors', () => {
    test('returns empty array for an unknown channel', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        const result = await svc.getChannelCursors('room:empty');
        expect(result).toEqual([]);
    });

    test('returns all cursor entries for a known channel', async () => {
        const { svc } = makeService();
        await svc.shutdown();
        seedCursor(svc, 'c1', 'room:1');
        seedCursor(svc, 'c2', 'room:1');
        const result = await svc.getChannelCursors('room:1');
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.clientId)).toEqual(expect.arrayContaining(['c1', 'c2']));
    });
});

// ─── cleanupRoom (replaces gateway's _cleanupRoom + coordinator handler) ─────

describe('CursorService — cleanupRoom', () => {
    test('is a no-op when roomId is empty string', async () => {
        const { svc } = makeService();
        await expect(svc.cleanupRoom('')).resolves.not.toThrow();
        await svc.shutdown();
    });

    test('is a no-op when roomId is null/undefined', async () => {
        const { svc } = makeService();
        await expect(svc.cleanupRoom(null as any)).resolves.not.toThrow();
        await expect(svc.cleanupRoom(undefined as any)).resolves.not.toThrow();
        await svc.shutdown();
    });

    test('is a no-op when room is not in channelCursors', async () => {
        const { svc } = makeService();
        await expect(svc.cleanupRoom('room:unknown')).resolves.not.toThrow();
        expect(svc.channelCursors.size).toBe(0);
        await svc.shutdown();
    });

    test('removes the room entry from channelCursors', async () => {
        const { svc } = makeService();
        const cursorMap = new Map<string, any>();
        cursorMap.set('c1', { x: 10, y: 20 });
        svc.channelCursors.set('room:1', cursorMap);
        svc.clientCursors.set('c1', { channel: 'room:1' } as any);

        await svc.cleanupRoom('room:1');

        expect(svc.channelCursors.has('room:1')).toBe(false);
        await svc.shutdown();
    });

    test('removes clientCursors entry for clients whose channel matches the room', async () => {
        const { svc } = makeService();
        const cursorMap = new Map<string, any>();
        cursorMap.set('c1', {});
        svc.channelCursors.set('room:2', cursorMap);
        svc.clientCursors.set('c1', { channel: 'room:2' } as any);

        await svc.cleanupRoom('room:2');

        expect(svc.clientCursors.has('c1')).toBe(false);
        await svc.shutdown();
    });

    test('removes cursorUpdateThrottle entry for cleaned clients', async () => {
        const { svc } = makeService();
        const cursorMap = new Map<string, any>();
        cursorMap.set('c1', {});
        svc.channelCursors.set('room:3', cursorMap);
        svc.clientCursors.set('c1', { channel: 'room:3' } as any);
        svc.cursorUpdateThrottle.set('c1', Date.now());

        await svc.cleanupRoom('room:3');

        expect(svc.cursorUpdateThrottle.has('c1')).toBe(false);
        await svc.shutdown();
    });

    test('leaves clientCursors entries whose channel is a different room', async () => {
        const { svc } = makeService();
        const cursorMap = new Map<string, any>();
        cursorMap.set('c1', {});
        svc.channelCursors.set('room:A', cursorMap);
        svc.clientCursors.set('c1', { channel: 'room:B' } as any);

        await svc.cleanupRoom('room:A');

        expect(svc.clientCursors.has('c1')).toBe(true);
        await svc.shutdown();
    });

    test('logs info when flushing a known room', async () => {
        const logger = new SpyLogger();
        const { svc } = makeService({ logger });
        const cursorMap = new Map<string, any>();
        cursorMap.set('c1', {});
        svc.channelCursors.set('room:log-check', cursorMap);
        svc.clientCursors.set('c1', { channel: 'room:log-check' } as any);

        await svc.cleanupRoom('room:log-check');

        expect(logger.infos.some((m) => m.includes('room:log-check'))).toBe(true);
        await svc.shutdown();
    });
});

// ─── sendError — metrics integration ─────────────────────────────────────────

describe('CursorService — sendError', () => {
    test('records error metric when metricsCollector is provided', async () => {
        const recordError = jest.fn();
        const { svc } = makeService({ metricsCollector: { recordError } });
        await svc.handleAction('c1', 'bogus-action', {});
        expect(recordError).toHaveBeenCalled();
        await svc.shutdown();
    });
});

// ─── constructor + config overrides ──────────────────────────────────────────

describe('CursorService — constructor + config', () => {
    test('throws when logger is missing', () => {
        expect(() => new CursorService({} as any)).toThrow(/logger is required/i);
    });

    test('throws when messageRouter is missing', () => {
        expect(
            () => new CursorService({ logger: new NoopLogger() } as any),
        ).toThrow(/messageRouter is required/i);
    });

    test('throttleInterval / cursorTTL / cleanupInterval honor config overrides', () => {
        const router = new MockRouter();
        const svc = new CursorService({
            messageRouter: router,
            logger: new NoopLogger(),
            config: { throttleInterval: 11, cursorTTL: 22, cleanupInterval: 33 },
        });
        expect(svc.throttleInterval).toBe(11);
        expect(svc.cursorTTL).toBe(22);
        expect(svc.cleanupInterval).toBe(33);
        void svc.shutdown();
    });

    test('supportedModes can be replaced via config', () => {
        const custom = {
            tiny: { name: 'tiny', description: 'x', requiredFields: ['x', 'y'], optionalFields: [] },
        };
        const router = new MockRouter();
        const svc = new CursorService({
            messageRouter: router,
            logger: new NoopLogger(),
            config: { supportedModes: custom },
        });
        expect(Object.keys(svc.supportedModes)).toEqual(['tiny']);
        expect(svc.supportedModes['freeform']).toBeUndefined();
        void svc.shutdown();
    });
});
