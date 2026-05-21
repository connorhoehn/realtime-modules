// realtime-modules/test/integration/presence.test.ts
//
// Integration tests for PresenceService using the real WS harness.
// No external services required — InProcessMessageRouter + in-memory state.
//
// Protocol recap:
//   - On connect: server fires onClientConnect → handleSetPresence({ status: 'online', channels: [] })
//     → no channel broadcast (channels is empty).
//   - subscribe: client sends { service: 'presence', action: 'subscribe', channel }
//     → router subscribes client to 'presence:{channel}'
//     → server replies { type: 'presence', action: 'subscribed', channel, presence }
//   - set: client sends { service: 'presence', action: 'set', status, channels, metadata }
//     → server broadcasts { type: 'presence', action: 'update', presence } to each
//       presence:{channel} (excluding sender)
//   - disconnect: server calls onClientDisconnect → setClientOffline → broadcasts
//     { type: 'presence', action: 'offline', clientId } to presence:{channel} subscribers.
//   - get: client sends { service: 'presence', action: 'get', channel }
//     → server replies { type: 'presence', action: 'presence', data: PresenceEntry[] }

import { startTestServer, connectTestClient, type TestServer } from './harness';

// ---------------------------------------------------------------------------
// Never-reject helper for "assert nothing arrived" patterns
// ---------------------------------------------------------------------------

/**
 * Resolves true if the predicate matches within `ms`, false otherwise.
 * Never rejects — safe to use in expect(result).toBe(false) assertions.
 */
async function doesNotReceive(
    client: Awaited<ReturnType<typeof connectTestClient>>,
    predicate: (m: object) => boolean,
    ms: number,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        client
            .waitForMessage(predicate, ms)
            .then(() => { clearTimeout(timer); resolve(true); })
            .catch(() => { resolve(false); });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume + discard the session frame the server always emits on connect. */
async function consumeSession(client: Awaited<ReturnType<typeof connectTestClient>>): Promise<void> {
    await client.waitForMessage((m) => (m as any).type === 'session');
}

/**
 * Consume any early presence frames (onClientConnect fires handleSetPresence
 * which may send a `set` reply to the connecting client) so subsequent
 * assertions start from a clean buffer.
 */
async function consumeInitialPresenceFrame(
    client: Awaited<ReturnType<typeof connectTestClient>>,
): Promise<void> {
    // The connecting client receives its own 'set' ack frame from onClientConnect.
    await client.waitForMessage(
        (m) => (m as any).type === 'presence' && (m as any).action === 'set',
    );
}

/**
 * Subscribe a client to presence events for `channel` and wait for the
 * server's `subscribed` ack.
 */
async function subscribePresence(
    client: Awaited<ReturnType<typeof connectTestClient>>,
    channel: string,
): Promise<void> {
    client.send({ service: 'presence', action: 'subscribe', channel });
    await client.waitForMessage(
        (m) =>
            (m as any).type === 'presence' &&
            (m as any).action === 'subscribed' &&
            (m as any).channel === channel,
    );
}

/**
 * Set presence on `client` for the given `channel` list, then wait for the
 * server's `set` ack.
 */
async function setPresence(
    client: Awaited<ReturnType<typeof connectTestClient>>,
    channels: string[],
    status = 'online',
): Promise<void> {
    client.send({ service: 'presence', action: 'set', status, channels });
    await client.waitForMessage(
        (m) => (m as any).type === 'presence' && (m as any).action === 'set',
    );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('presence integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['presence'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    // -----------------------------------------------------------------------
    // 1. Join event: subscribing client receives an update when another client
    //    sets their presence for the same channel.
    // -----------------------------------------------------------------------

    it('join event: observer receives presence update when another client sets presence for channel', async () => {
        const observer = await connectTestClient(server.url);
        const joiner = await connectTestClient(server.url);
        try {
            // Drain session + initial set-ack frames for both clients.
            await Promise.all([consumeSession(observer), consumeSession(joiner)]);
            await Promise.all([
                consumeInitialPresenceFrame(observer),
                consumeInitialPresenceFrame(joiner),
            ]);

            // Observer subscribes to presence channel 'room-join'.
            await subscribePresence(observer, 'room-join');

            // Joiner announces their presence in 'room-join'.
            joiner.send({
                service: 'presence',
                action: 'set',
                status: 'online',
                channels: ['room-join'],
                metadata: { displayName: 'Joiner' },
            });

            // Observer should receive the update broadcast.
            const update = await observer.waitForMessage(
                (m) =>
                    (m as any).type === 'presence' &&
                    (m as any).action === 'update',
            );

            expect((update as any).presence.status).toBe('online');
            expect(Array.isArray((update as any).presence.channels)).toBe(true);
            expect((update as any).presence.channels).toContain('room-join');
        } finally {
            await Promise.all([observer.disconnect(), joiner.disconnect()]);
        }
    });

    // -----------------------------------------------------------------------
    // 2. Leave event: observer receives an offline frame when a client that
    //    had presence in the channel disconnects.
    // -----------------------------------------------------------------------

    it('leave event: observer receives offline frame when a channel member disconnects', async () => {
        const observer = await connectTestClient(server.url);
        const leaver = await connectTestClient(server.url);
        try {
            await Promise.all([consumeSession(observer), consumeSession(leaver)]);
            await Promise.all([
                consumeInitialPresenceFrame(observer),
                consumeInitialPresenceFrame(leaver),
            ]);

            // Observer subscribes to 'room-leave'.
            await subscribePresence(observer, 'room-leave');

            // Leaver joins the channel's presence and waits for ack.
            await setPresence(leaver, ['room-leave']);

            // Drain the update the observer receives for leaver joining.
            await observer.waitForMessage(
                (m) => (m as any).type === 'presence' && (m as any).action === 'update',
            );

            // Leaver disconnects — server should broadcast offline frame.
            await leaver.disconnect();

            const offline = await observer.waitForMessage(
                (m) =>
                    (m as any).type === 'presence' &&
                    (m as any).action === 'offline',
                5_000, // slightly generous — EvictionTimer fires after disconnectDelayMs (50ms in harness)
            );

            expect((offline as any).type).toBe('presence');
            expect((offline as any).action).toBe('offline');
            expect(typeof (offline as any).clientId).toBe('string');
        } finally {
            await observer.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // 3. Presence list: after 3 clients set presence for a channel, get
    //    returns all 3 entries.
    // -----------------------------------------------------------------------

    it('presence list: get returns all clients that set presence for the channel', async () => {
        const clients = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);
        const querier = await connectTestClient(server.url);
        try {
            // Drain session + initial set-ack for all clients.
            await Promise.all(clients.map((c) => consumeSession(c)));
            await Promise.all(clients.map((c) => consumeInitialPresenceFrame(c)));
            await consumeSession(querier);
            await consumeInitialPresenceFrame(querier);

            // Each of the 3 clients sets presence for 'room-list'.
            for (const c of clients) {
                await setPresence(c, ['room-list']);
            }

            // Querier asks for channel presence.
            querier.send({ service: 'presence', action: 'get', channel: 'room-list' });

            const frame = await querier.waitForMessage(
                (m) =>
                    (m as any).type === 'presence' &&
                    (m as any).action === 'presence',
            );

            const data: any[] = (frame as any).data;
            expect(Array.isArray(data)).toBe(true);
            // All 3 clients should appear in the list.
            expect(data.length).toBe(3);
            for (const entry of data) {
                expect(entry.channels).toContain('room-list');
            }
        } finally {
            await Promise.all([...clients.map((c) => c.disconnect()), querier.disconnect()]);
        }
    });

    // -----------------------------------------------------------------------
    // 4. Isolation: a client in channel-1 does NOT receive presence events
    //    from channel-2.
    // -----------------------------------------------------------------------

    it('isolation: presence events in channel-2 are not received by channel-1 observer', async () => {
        const observer = await connectTestClient(server.url);
        const outsider = await connectTestClient(server.url);
        try {
            await Promise.all([consumeSession(observer), consumeSession(outsider)]);
            await Promise.all([
                consumeInitialPresenceFrame(observer),
                consumeInitialPresenceFrame(outsider),
            ]);

            // Observer subscribes to 'channel-iso-1' only.
            await subscribePresence(observer, 'channel-iso-1');

            // Outsider sets presence for 'channel-iso-2' (different channel).
            outsider.send({
                service: 'presence',
                action: 'set',
                status: 'online',
                channels: ['channel-iso-2'],
            });
            // Wait for outsider's own ack to ensure the set was processed.
            await outsider.waitForMessage(
                (m) => (m as any).type === 'presence' && (m as any).action === 'set',
            );

            // Observer should NOT receive any update for channel-iso-2.
            const leaked = await doesNotReceive(
                observer,
                (m) => (m as any).type === 'presence' && (m as any).action === 'update',
                500,
            );

            expect(leaked).toBe(false);
        } finally {
            await Promise.all([observer.disconnect(), outsider.disconnect()]);
        }
    });
});
