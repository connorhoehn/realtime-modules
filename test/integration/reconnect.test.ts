// realtime-modules/test/integration/reconnect.test.ts
//
// Integration tests for client disconnect + reconnect behaviour.
//
// Key architectural fact: createWsHandler assigns each WS connection a fresh
// clientId (via generateClientId). A "reconnect" at the WS layer is a brand
// new connection with a new clientId — there is no session-token handshake
// that preserves the old identity across disconnects.  The tests below
// therefore validate the *externally visible* semantics:
//
//   1. A reconnecting client can set presence and receives a session frame.
//   2. Chat history persists in the ChatStore across a disconnect/reconnect
//      so the new clientId can retrieve the messages the old clientId sent.
//   3. A bystander client sees an offline/leave event for client A when it
//      disconnects, and sees client A (as a fresh clientId) appear as online
//      when it reconnects.
//   4. Calling `chat:join` twice on the same channel (once before and once
//      after reconnect) does not leave the channel double-subscribed — the
//      new clientId starts with a clean slate.
//
// All tests share a single TestServer to keep startup overhead low.

import { startTestServer, connectTestClient } from './harness';
import type { TestServer } from './harness';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain all buffered frames until the socket closes. */
async function drainUntilClose(client: Awaited<ReturnType<typeof connectTestClient>>): Promise<void> {
    await client.disconnect();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('client reconnect scenarios', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['chat', 'presence'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    // -----------------------------------------------------------------------
    // 1. Clean reconnect: presence reflects the reconnected client as online
    // -----------------------------------------------------------------------

    it('reconnected client receives a session frame and can set presence', async () => {
        // First connection
        const c1 = await connectTestClient(server.url);
        await c1.waitForMessage((m) => (m as any).type === 'session');

        // Set presence on the first connection.
        c1.send({ service: 'presence', action: 'set', status: 'online', channels: [] });
        const presFrame1 = await c1.waitForMessage(
            (m) => (m as any).type === 'presence' && (m as any).action === 'set',
        );
        const clientId1 = (presFrame1 as any).presence?.clientId;
        expect(clientId1).toBeTruthy();
        expect((presFrame1 as any).presence?.status).toBe('online');

        // Disconnect.
        await drainUntilClose(c1);

        // Reconnect — brand-new clientId.
        const c2 = await connectTestClient(server.url);
        const sessionFrame = await c2.waitForMessage((m) => (m as any).type === 'session');
        expect((sessionFrame as any).status).toBe('connected');
        const clientId2 = (sessionFrame as any).clientId;
        expect(typeof clientId2).toBe('string');
        // Reconnect is a fresh identity, not the same clientId.
        expect(clientId2).not.toBe(clientId1);

        // Presence can be set on the new connection.
        c2.send({ service: 'presence', action: 'set', status: 'online', channels: [] });
        const presFrame2 = await c2.waitForMessage(
            (m) => (m as any).type === 'presence' && (m as any).action === 'set',
        );
        expect((presFrame2 as any).presence?.status).toBe('online');

        await c2.disconnect();
    });

    // -----------------------------------------------------------------------
    // 2. Message history survives disconnect: new client retrieves old messages
    // -----------------------------------------------------------------------

    it('messages sent before disconnect are retrievable via history after reconnect', async () => {
        const channel = 'reconnect-history-1';

        // First client joins and sends 3 messages.
        const c1 = await connectTestClient(server.url);
        await c1.waitForMessage((m) => (m as any).type === 'session');

        c1.send({ service: 'chat', action: 'join', channel });
        await c1.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'joined',
        );

        c1.send({ service: 'chat', action: 'send', channel, message: 'msg1' });
        await c1.waitForMessage((m) => (m as any).type === 'chat' && (m as any).action === 'sent');

        c1.send({ service: 'chat', action: 'send', channel, message: 'msg2' });
        await c1.waitForMessage((m) => (m as any).type === 'chat' && (m as any).action === 'sent');

        c1.send({ service: 'chat', action: 'send', channel, message: 'msg3' });
        await c1.waitForMessage((m) => (m as any).type === 'chat' && (m as any).action === 'sent');

        await drainUntilClose(c1);

        // Reconnect with a new client.
        const c2 = await connectTestClient(server.url);
        await c2.waitForMessage((m) => (m as any).type === 'session');

        // Join the same channel — ChatService sends history on join.
        c2.send({ service: 'chat', action: 'join', channel });
        await c2.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'joined',
        );

        // History is sent right after the join ack (sendChannelHistory).
        const historyFrame = await c2.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'history',
            5_000,
        );

        const messages = (historyFrame as any).messages as any[];
        expect(Array.isArray(messages)).toBe(true);
        // All 3 messages should be in the history.
        const texts = messages.map((m: any) => m.message);
        expect(texts).toContain('msg1');
        expect(texts).toContain('msg2');
        expect(texts).toContain('msg3');

        await c2.disconnect();
    });

    // -----------------------------------------------------------------------
    // 3. Bystander sees offline + online events around a disconnect/reconnect
    // -----------------------------------------------------------------------

    it('bystander sees offline event when client A disconnects and online event on reconnect', async () => {
        const channel = 'reconnect-presence-obs-1';

        // Bystander (client B) subscribes to presence for the channel.
        const clientB = await connectTestClient(server.url);
        await clientB.waitForMessage((m) => (m as any).type === 'session');

        clientB.send({ service: 'presence', action: 'subscribe', channel });
        await clientB.waitForMessage(
            (m) => (m as any).type === 'presence' && (m as any).action === 'subscribed',
        );

        // Client A connects, sets presence in the channel, and subscribes.
        const clientA = await connectTestClient(server.url);
        await clientA.waitForMessage((m) => (m as any).type === 'session');

        clientA.send({ service: 'presence', action: 'set', status: 'online', channels: [channel] });
        await clientA.waitForMessage(
            (m) => (m as any).type === 'presence' && (m as any).action === 'set',
        );

        // B should see an 'update' (A's online presence) fanned out on the channel.
        const updateFrame = await clientB.waitForMessage(
            (m) =>
                (m as any).type === 'presence' &&
                (m as any).action === 'update' &&
                (m as any).presence?.status === 'online',
            5_000,
        );
        expect((updateFrame as any).presence?.status).toBe('online');
        const clientAId = (updateFrame as any).presence?.clientId as string;

        // A disconnects.
        await drainUntilClose(clientA);

        // B should see an 'offline' frame for A's clientId.
        const offlineFrame = await clientB.waitForMessage(
            (m) =>
                (m as any).type === 'presence' &&
                ((m as any).action === 'offline' || (m as any).action === 'update') &&
                ((m as any).clientId === clientAId || (m as any).presence?.clientId === clientAId),
            5_000,
        );
        // Presence service sends either action:'offline' or action:'update' with
        // status:'offline' — accept either.
        const offlineAction = (offlineFrame as any).action as string;
        expect(['offline', 'update'].includes(offlineAction)).toBe(true);

        // A reconnects (fresh clientId).
        const clientA2 = await connectTestClient(server.url);
        await clientA2.waitForMessage((m) => (m as any).type === 'session');

        clientA2.send({ service: 'presence', action: 'set', status: 'online', channels: [channel] });
        await clientA2.waitForMessage(
            (m) => (m as any).type === 'presence' && (m as any).action === 'set',
        );

        // B should see a new 'update' with status:'online' for the reconnected A.
        const rejoinFrame = await clientB.waitForMessage(
            (m) =>
                (m as any).type === 'presence' &&
                (m as any).action === 'update' &&
                (m as any).presence?.status === 'online',
            5_000,
        );
        expect((rejoinFrame as any).presence?.status).toBe('online');

        await Promise.all([clientA2.disconnect(), clientB.disconnect()]);
    });

    // -----------------------------------------------------------------------
    // 4. No duplicate subscriptions: reconnect starts with a clean channel slate
    // -----------------------------------------------------------------------

    it('reconnecting client does not carry over subscriptions from its previous session', async () => {
        const channel = 'no-dup-subs-1';

        // First connection: join the channel.
        const c1 = await connectTestClient(server.url);
        await c1.waitForMessage((m) => (m as any).type === 'session');

        c1.send({ service: 'chat', action: 'join', channel });
        await c1.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'joined',
        );

        // Verify channel is joined by sending a message (only subscribed clients
        // can send).
        c1.send({ service: 'chat', action: 'send', channel, message: 'before-disconnect' });
        const sentAck = await c1.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
        );
        expect(sentAck).toBeDefined();

        // Disconnect mid-session.
        await drainUntilClose(c1);

        // Reconnect with a new client.
        const c2 = await connectTestClient(server.url);
        await c2.waitForMessage((m) => (m as any).type === 'session');

        // The new client has NOT joined — sending without joining should error.
        c2.send({ service: 'chat', action: 'send', channel, message: 'should-fail' });
        const errFrame = await c2.waitForMessage(
            (m) => (m as any).type === 'error' && (m as any).service === 'chat',
            5_000,
        );
        expect((errFrame as any).type).toBe('error');

        // Now join the channel explicitly — should succeed with a joined ack.
        c2.send({ service: 'chat', action: 'join', channel });
        const joinedFrame = await c2.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'joined',
            5_000,
        );
        expect((joinedFrame as any).channel).toBe(channel);

        // After joining, sending works fine.
        c2.send({ service: 'chat', action: 'send', channel, message: 'after-reconnect' });
        const sentAck2 = await c2.waitForMessage(
            (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
        );
        expect(sentAck2).toBeDefined();

        await c2.disconnect();
    });
});
