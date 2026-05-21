// realtime-modules/test/presence/PresenceService.test.ts
//
// Lifted + adapted from gateway test/presence-service-handlers.test.js
// and test/presence-service-pure.test.js. Tests the in-process surface
// only — registry shadow-write / ownership-handler tests stay in
// gateway because those code paths weren't lifted.

import PresenceService = require('../../src/presence/PresenceService');
import { PresenceManifest } from '../../src/presence';
import type { PresenceConfig, PresenceEntry, PresenceMessageRouter } from '../../src/presence';

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

interface SentRecord {
    clientId: string;
    message: any;
}
interface ChannelSentRecord {
    channel: string;
    message: any;
    excludeClientId?: string;
}
interface SubRecord {
    clientId: string;
    channel: string;
}

class MockRouter implements PresenceMessageRouter {
    nodeId = 'node-test';
    redisAvailable: boolean | undefined = undefined;
    sent: SentRecord[] = [];
    channelSent: ChannelSentRecord[] = [];
    subscribed: SubRecord[] = [];
    unsubscribed: SubRecord[] = [];

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

function makeService(config: PresenceConfig = {}) {
    const router = new MockRouter();
    const svc = new PresenceService(router, new NoopLogger(), config);
    return { svc, router };
}

function sentTo(router: MockRouter, clientId: string): any[] {
    return router.sent.filter((s) => s.clientId === clientId).map((s) => s.message);
}

function makePresence(clientId: string, channels: string[] = [], overrides: Partial<PresenceEntry> = {}): PresenceEntry {
    return {
        clientId,
        status: 'online',
        metadata: {},
        channels,
        nodeId: 'node-test',
        timestamp: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastHeartbeat: Date.now(),
        ...overrides,
    };
}

// Shut down intervals after each test so Jest doesn't linger.
const services: PresenceService[] = [];
afterEach(async () => {
    while (services.length) {
        const svc = services.pop()!;
        await svc.shutdown();
    }
});

function track(svc: PresenceService): PresenceService {
    services.push(svc);
    return svc;
}

// ─── construction ────────────────────────────────────────────────────────────

describe('PresenceService — construction', () => {
    test('throws when messageRouter is missing', () => {
        expect(() => new PresenceService(null as any, new NoopLogger())).toThrow(/messageRouter/);
    });

    test('honours config overrides for tunables', () => {
        const { svc } = makeService({ disconnectDelayMs: 1 });
        track(svc);
        expect(svc).toBeInstanceOf(PresenceService);
    });
});

// ─── handleSetPresence ───────────────────────────────────────────────────────

describe('PresenceService — handleSetPresence: validation', () => {
    test('missing status sends error and returns early', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', {} as any);

        const msgs = sentTo(router, 'c-1');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].type).toBe('error');
    });

    test('invalid status sends error', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'invisible' as any });

        const msgs = sentTo(router, 'c-1');
        expect(msgs[0].type).toBe('error');
    });
});

describe('PresenceService — handleSetPresence: happy path', () => {
    test('sends type:presence action:set ack', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'set');
        expect(acks).toHaveLength(1);
        expect(acks[0].type).toBe('presence');
    });

    test('ack includes presence object with the submitted status', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'away' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'set');
        expect(ack.presence.status).toBe('away');
        expect(ack.presence.clientId).toBe('c-1');
    });

    test('ack includes a timestamp string', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'busy' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'set');
        expect(typeof ack.timestamp).toBe('string');
    });

    test('stores presence in clientPresence map', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });

        expect(svc.clientPresence.has('c-1')).toBe(true);
        expect(svc.clientPresence.get('c-1')!.status).toBe('online');
    });

    test('all four valid statuses are accepted', async () => {
        const statuses: Array<'online' | 'away' | 'busy' | 'offline'> = ['online', 'away', 'busy', 'offline'];
        for (const status of statuses) {
            const { svc, router } = makeService();
            track(svc);
            await svc.handleSetPresence('c-1', { status });

            const ack = sentTo(router, 'c-1').find((m) => m.action === 'set');
            expect(ack).toBeTruthy();
        }
    });

    test('broadcasts to each requested channel with presence: prefix', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online', channels: ['room-a', 'room-b'] });

        const broadcasts = router.channelSent.filter((c) => c.message.action === 'update');
        expect(broadcasts.map((b) => b.channel).sort()).toEqual(['presence:room-a', 'presence:room-b']);
    });

    test('uses router nodeId when present', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'set');
        expect(ack.presence.nodeId).toBe(router.nodeId);
    });

    test('falls back to "local" nodeId when router omits it', async () => {
        const router = new MockRouter();
        delete (router as any).nodeId;
        const svc = new PresenceService(router, new NoopLogger());
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'set');
        expect(ack.presence.nodeId).toBe('local');
    });
});

// ─── handleGetPresence ───────────────────────────────────────────────────────

describe('PresenceService — handleGetPresence: validation', () => {
    test('neither targetClientId nor channel sends error', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleGetPresence('c-1', {});

        const msgs = sentTo(router, 'c-1');
        expect(msgs[0].type).toBe('error');
    });

    test('unknown targetClientId sends error', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleGetPresence('c-1', { targetClientId: 'nobody' });

        const msgs = sentTo(router, 'c-1');
        expect(msgs[0].type).toBe('error');
    });
});

describe('PresenceService — handleGetPresence: happy path', () => {
    test('returns presence for a known targetClientId', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-2', { status: 'online' });
        router.sent = [];

        await svc.handleGetPresence('c-1', { targetClientId: 'c-2' });

        const msg = sentTo(router, 'c-1').find((m) => m.action === 'presence');
        expect(msg).toBeTruthy();
        expect(msg.type).toBe('presence');
        expect(msg.data.status).toBe('online');
    });

    test('returns channel presence array when queried by channel', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSetPresence('c-2', { status: 'online', channels: ['room-a'] });
        router.sent = [];

        await svc.handleGetPresence('c-1', { channel: 'room-a' });

        const msg = sentTo(router, 'c-1').find((m) => m.action === 'presence');
        expect(msg).toBeTruthy();
        expect(Array.isArray(msg.data)).toBe(true);
    });

    test('returns empty array for channel with no subscribers', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleGetPresence('c-1', { channel: 'empty-room' });

        const msg = sentTo(router, 'c-1').find((m) => m.action === 'presence');
        expect(Array.isArray(msg.data)).toBe(true);
        expect(msg.data).toHaveLength(0);
    });
});

// ─── handleSubscribePresence ─────────────────────────────────────────────────

describe('PresenceService — handleSubscribePresence: validation', () => {
    test('missing channel sends error and returns early', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSubscribePresence('c-1', {} as any);

        const msgs = sentTo(router, 'c-1');
        expect(msgs[0].type).toBe('error');
    });

    test('authorizeChannel:false returns silently without sending subscribed ack', async () => {
        const { svc, router } = makeService({ authorizeChannel: () => false });
        track(svc);
        await svc.handleSubscribePresence('c-1', { channel: 'room-1' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'subscribed');
        expect(acks).toHaveLength(0);
        expect(router.subscribed).toHaveLength(0);
    });
});

describe('PresenceService — handleSubscribePresence: happy path', () => {
    test('sends type:presence action:subscribed ack with channel and timestamp', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSubscribePresence('c-1', { channel: 'room-1' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'subscribed');
        expect(ack).toBeTruthy();
        expect(ack.type).toBe('presence');
        expect(ack.channel).toBe('room-1');
        expect(typeof ack.timestamp).toBe('string');
    });

    test('ack includes a presence array for the channel', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSubscribePresence('c-1', { channel: 'room-1' });

        const ack = sentTo(router, 'c-1').find((m) => m.action === 'subscribed');
        expect(Array.isArray(ack.presence)).toBe(true);
    });

    test('calls subscribeToChannel with presence: prefix on the router', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleSubscribePresence('c-1', { channel: 'board-1' });

        expect(router.subscribed).toContainEqual({ clientId: 'c-1', channel: 'presence:board-1' });
    });

    test('authorizeChannel:true allows subscribe', async () => {
        const { svc, router } = makeService({ authorizeChannel: () => true });
        track(svc);
        await svc.handleSubscribePresence('c-1', { channel: 'room-2' });

        expect(router.subscribed).toContainEqual({ clientId: 'c-1', channel: 'presence:room-2' });
    });
});

// ─── handleUnsubscribePresence ───────────────────────────────────────────────

describe('PresenceService — handleUnsubscribePresence', () => {
    test('missing channel sends error and returns early', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleUnsubscribePresence('c-1', {} as any);

        const msgs = sentTo(router, 'c-1');
        expect(msgs[0].type).toBe('error');
    });

    test('sends action:unsubscribed ack and calls router', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleUnsubscribePresence('c-1', { channel: 'room-2' });

        const msgs = sentTo(router, 'c-1').filter((m) => m.action === 'unsubscribed');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].channel).toBe('room-2');
        expect(router.unsubscribed).toContainEqual({ clientId: 'c-1', channel: 'presence:room-2' });
    });
});

// ─── handleHeartbeat ─────────────────────────────────────────────────────────

describe('PresenceService — handleHeartbeat', () => {
    test('updates lastSeen and lastHeartbeat for an existing client', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });

        const before = svc.clientPresence.get('c-1')!.lastHeartbeat;
        await new Promise((r) => setTimeout(r, 5));
        await svc.handleHeartbeat('c-1', {});

        const after = svc.clientPresence.get('c-1')!.lastHeartbeat;
        expect(after).toBeGreaterThanOrEqual(before);
        expect(svc.clientPresence.get('c-1')!.lastSeen).toBeTruthy();
    });

    test('is a no-op for a client with no presence', async () => {
        const { svc } = makeService();
        track(svc);
        await expect(svc.handleHeartbeat('unknown-client', {})).resolves.toBeUndefined();
    });
});

// ─── handleAction dispatch ───────────────────────────────────────────────────

describe('PresenceService — handleAction dispatch', () => {
    test('dispatches "set" to handleSetPresence', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleAction('c-1', 'set', { status: 'online' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'set');
        expect(acks).toHaveLength(1);
    });

    test('dispatches "subscribe" to handleSubscribePresence', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleAction('c-1', 'subscribe', { channel: 'room-a' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'subscribed');
        expect(acks).toHaveLength(1);
    });

    test('dispatches "unsubscribe" to handleUnsubscribePresence', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleAction('c-1', 'unsubscribe', { channel: 'room-a' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'unsubscribed');
        expect(acks).toHaveLength(1);
    });

    test('dispatches "get" to handleGetPresence', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleAction('c-1', 'get', { channel: 'room-a' });

        const acks = sentTo(router, 'c-1').filter((m) => m.action === 'presence');
        expect(acks).toHaveLength(1);
    });

    test('dispatches "heartbeat" to handleHeartbeat', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });
        await expect(svc.handleAction('c-1', 'heartbeat', {})).resolves.toBeUndefined();
    });

    test('sends error for unknown action', async () => {
        const { svc, router } = makeService();
        track(svc);
        await svc.handleAction('c-1', 'teleport', {});

        const errs = sentTo(router, 'c-1').filter((m) => m.type === 'error');
        expect(errs).toHaveLength(1);
    });
});

// ─── updateChannelPresence (pure) ────────────────────────────────────────────

describe('PresenceService — updateChannelPresence', () => {
    test('adds client to listed channels in channelPresence', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:1']), ['room:1']);
        expect(svc.channelPresence.get('room:1')!.has('c1')).toBe(true);
    });

    test('updates clientChannels reverse index', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:1', 'room:2']), ['room:1', 'room:2']);
        const channels = svc.clientChannels.get('c1')!;
        expect(channels.has('room:1') && channels.has('room:2')).toBe(true);
    });

    test('removes client from channels dropped in update', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:1', 'room:2']), ['room:1', 'room:2']);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:2']), ['room:2']);
        expect(svc.channelPresence.has('room:1')).toBe(false);
        expect(svc.channelPresence.get('room:2')!.has('c1')).toBe(true);
    });

    test('drops empty channel map when last client leaves', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:1']), ['room:1']);
        await svc.updateChannelPresence('c1', makePresence('c1', []), []);
        expect(svc.channelPresence.has('room:1')).toBe(false);
    });
});

describe('PresenceService — removeClientFromAllChannels', () => {
    test('removes client from all subscribed channels', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.updateChannelPresence('c1', makePresence('c1', ['room:A', 'room:B']), ['room:A', 'room:B']);
        svc.removeClientFromAllChannels('c1');
        expect(svc.channelPresence.has('room:A')).toBe(false);
        expect(svc.channelPresence.has('room:B')).toBe(false);
        expect(svc.clientChannels.has('c1')).toBe(false);
    });

    test('is a no-op when client has no channels', () => {
        const { svc } = makeService();
        track(svc);
        expect(() => svc.removeClientFromAllChannels('unknown')).not.toThrow();
    });
});

// ─── cleanupStaleClients ─────────────────────────────────────────────────────

describe('PresenceService — cleanupStaleClients', () => {
    test('evicts clients whose lastHeartbeat is older than staleThresholdMs', () => {
        const { svc } = makeService({ staleThresholdMs: 50 });
        track(svc);
        svc.clientPresence.set('old', makePresence('old', [], { lastHeartbeat: Date.now() - 1000 }));
        svc.clientPresence.set('fresh', makePresence('fresh', [], { lastHeartbeat: Date.now() }));

        svc.cleanupStaleClients();

        expect(svc.clientPresence.has('old')).toBe(false);
        expect(svc.clientPresence.has('fresh')).toBe(true);
    });

    test('also tears down channel reverse index for evicted clients', async () => {
        const { svc } = makeService({ staleThresholdMs: 50 });
        track(svc);
        const entry = makePresence('old', ['room:1'], { lastHeartbeat: Date.now() - 1000 });
        svc.clientPresence.set('old', entry);
        await svc.updateChannelPresence('old', entry, ['room:1']);

        svc.cleanupStaleClients();

        expect(svc.channelPresence.has('room:1')).toBe(false);
        expect(svc.clientChannels.has('old')).toBe(false);
    });
});

// ─── cleanupStalePresence (status flip) ──────────────────────────────────────

describe('PresenceService — cleanupStalePresence', () => {
    test('flips inactive clients to status:offline (in-place)', () => {
        const { svc } = makeService({ presenceTimeoutMs: 50 });
        track(svc);
        const entry = makePresence('stale', [], {
            lastSeen: new Date(Date.now() - 5000).toISOString(),
            lastHeartbeat: Date.now() - 5000,
        });
        svc.clientPresence.set('stale', entry);

        svc.cleanupStalePresence();

        expect(svc.clientPresence.get('stale')!.status).toBe('offline');
    });
});

// ─── client lifecycle (connect, disconnect, reconnect) ───────────────────────

describe('PresenceService — onClientConnect / onClientDisconnect', () => {
    test('onClientConnect seeds an online presence entry', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.onClientConnect('c-new');
        expect(svc.clientPresence.get('c-new')!.status).toBe('online');
    });

    test('onClientDisconnect schedules a disconnect timer and clears state after delay', async () => {
        const { svc } = makeService({ disconnectDelayMs: 10 });
        track(svc);
        await svc.handleSetPresence('c-x', { status: 'online', channels: ['room:1'] });

        await svc.onClientDisconnect('c-x');
        expect(svc.disconnectEviction.isScheduled('c-x')).toBe(true);

        await new Promise((r) => setTimeout(r, 30));
        expect(svc.clientPresence.has('c-x')).toBe(false);
        expect(svc.disconnectEviction.isScheduled('c-x')).toBe(false);
    });

    test('reconnect cancels pending disconnect timer', async () => {
        const { svc } = makeService({ disconnectDelayMs: 1000 });
        track(svc);
        await svc.handleSetPresence('c-x', { status: 'online', channels: ['room:1'] });
        await svc.onClientDisconnect('c-x');
        expect(svc.disconnectEviction.isScheduled('c-x')).toBe(true);

        await svc.onClientConnect('c-x');
        expect(svc.disconnectEviction.isScheduled('c-x')).toBe(false);
        expect(svc.clientPresence.has('c-x')).toBe(true);
    });

    test('handleDisconnect is an alias for onClientDisconnect', async () => {
        const { svc } = makeService({ disconnectDelayMs: 10 });
        track(svc);
        await svc.handleSetPresence('c-y', { status: 'online' });
        await svc.handleDisconnect('c-y');
        expect(svc.disconnectEviction.isScheduled('c-y')).toBe(true);
    });
});

// ─── getStats ────────────────────────────────────────────────────────────────

describe('PresenceService — getStats', () => {
    test('returns zero stats when no activity', () => {
        const { svc } = makeService();
        track(svc);
        const stats = svc.getStats();
        expect(stats.connectedClients).toBe(0);
        expect(stats.activeChannels).toBe(0);
        expect(typeof stats.statusBreakdown).toBe('object');
    });

    test('connectedClients reflects clientPresence size', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });
        await svc.handleSetPresence('c-2', { status: 'away' });

        expect(svc.getStats().connectedClients).toBe(2);
    });

    test('statusBreakdown counts by status', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online' });
        await svc.handleSetPresence('c-2', { status: 'online' });
        await svc.handleSetPresence('c-3', { status: 'away' });

        const breakdown = svc.getStats().statusBreakdown;
        expect(breakdown.online).toBe(2);
        expect(breakdown.away).toBe(1);
    });
});

// ─── shutdown ────────────────────────────────────────────────────────────────

describe('PresenceService — shutdown', () => {
    test('clears all internal state and timers', async () => {
        const { svc } = makeService({ disconnectDelayMs: 10_000 });
        await svc.handleSetPresence('c-1', { status: 'online', channels: ['r1'] });
        await svc.onClientDisconnect('c-1');

        await svc.shutdown();

        expect(svc.clientPresence.size).toBe(0);
        expect(svc.channelPresence.size).toBe(0);
        expect(svc.clientChannels.size).toBe(0);
        expect(svc.disconnectEviction.pendingCount).toBe(0);
    });
});

// ─── metadata validation ─────────────────────────────────────────────────────

describe('PresenceService — metadata validation', () => {
    test('truncates metadata when key count exceeds maxMetadataKeys', async () => {
        const { svc } = makeService({ maxMetadataKeys: 3 });
        track(svc);
        const metadata: Record<string, number> = {};
        for (let i = 0; i < 10; i++) metadata[`k${i}`] = i;

        await svc.handleSetPresence('c-1', { status: 'online', metadata });

        const stored = svc.clientPresence.get('c-1')!.metadata;
        expect(Object.keys(stored)).toHaveLength(3);
    });

    test('replaces oversize metadata with stub object', async () => {
        const { svc } = makeService({ maxMetadataSize: 50 });
        track(svc);
        const metadata = { displayName: 'Alice', bio: 'x'.repeat(500) };

        await svc.handleSetPresence('c-1', { status: 'online', metadata });

        const stored = svc.clientPresence.get('c-1')!.metadata as any;
        expect(stored._truncated).toBe(true);
        expect(stored.displayName).toBe('Alice');
    });

    test('handles non-object metadata gracefully', async () => {
        const { svc } = makeService();
        track(svc);
        await svc.handleSetPresence('c-1', { status: 'online', metadata: 'oops' as any });
        expect(svc.clientPresence.get('c-1')!.metadata).toEqual({});
    });
});

// ─── manifest ────────────────────────────────────────────────────────────────

describe('PresenceManifest', () => {
    test('declares the presence:* channel pattern and tunable env vars', () => {
        expect(PresenceManifest.name).toBe('presence');
        expect(PresenceManifest.version).toBe('0.1.0');
        expect(PresenceManifest.channels).toContain('presence:*');
        expect(PresenceManifest.envVars).toHaveProperty('PRESENCE_HEARTBEAT_INTERVAL_MS');
        expect(PresenceManifest.envVars).toHaveProperty('PRESENCE_DISCONNECT_DELAY_MS');
    });
});
