// realtime-modules/test/integration/chat.test.ts
//
// Integration tests for ChatService using the real WS harness.
// No external services required — InMemoryChatStore + InProcessMessageRouter.

import { startTestServer, connectTestClient, type TestServer } from './harness';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume + discard the session frame that the server always emits on connect. */
async function consumeSession(client: Awaited<ReturnType<typeof connectTestClient>>): Promise<void> {
    await client.waitForMessage((m) => (m as any).type === 'session');
}

/**
 * Wait `ms` milliseconds and resolve false if no matching message arrives,
 * or resolve true if one does. Never rejects.
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
            .catch(() => { /* timed out — no message arrived */ resolve(false); });
    });
}

/**
 * Join a channel on a client and wait for the `joined` ack.
 * Also drains any `history` frame that immediately follows (empty channel).
 */
async function joinChannel(
    client: Awaited<ReturnType<typeof connectTestClient>>,
    channel: string,
): Promise<void> {
    client.send({ service: 'chat', action: 'join', channel });
    await client.waitForMessage(
        (m) => (m as any).type === 'chat' && (m as any).action === 'joined' && (m as any).channel === channel,
    );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('chat integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['chat'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    // -----------------------------------------------------------------------
    // 1. Round-trip: sender receives the message back
    // -----------------------------------------------------------------------

    it('round-trip: client A sends a message and receives it back', async () => {
        const clientA = await connectTestClient(server.url);
        try {
            await consumeSession(clientA);
            await joinChannel(clientA, 'roundtrip');

            clientA.send({ service: 'chat', action: 'send', channel: 'roundtrip', message: 'hello world' });

            // Sender should receive the broadcast `message` frame.
            const frame = await clientA.waitForMessage(
                (m) =>
                    (m as any).type === 'chat' &&
                    (m as any).action === 'message' &&
                    (m as any).channel === 'roundtrip',
            );

            expect((frame as any).message.message).toBe('hello world');
            expect((frame as any).message.channel).toBe('roundtrip');
        } finally {
            await clientA.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // 2. Fan-out: Client B on same channel receives Client A's message
    // -----------------------------------------------------------------------

    it('fan-out: client B in same channel receives message from client A', async () => {
        const [clientA, clientB] = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);
        try {
            await Promise.all([consumeSession(clientA), consumeSession(clientB)]);
            await Promise.all([joinChannel(clientA, 'fanout'), joinChannel(clientB, 'fanout')]);

            clientA.send({ service: 'chat', action: 'send', channel: 'fanout', message: 'broadcast me' });

            // Client B receives the broadcast.
            const frame = await clientB.waitForMessage(
                (m) =>
                    (m as any).type === 'chat' &&
                    (m as any).action === 'message' &&
                    (m as any).channel === 'fanout',
            );

            expect((frame as any).message.message).toBe('broadcast me');
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });

    // -----------------------------------------------------------------------
    // 3. Channel isolation: different channels don't cross-contaminate
    // -----------------------------------------------------------------------

    it('channel isolation: message in channel-1 is NOT received by client in channel-2', async () => {
        const [clientA, clientB] = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);
        try {
            await Promise.all([consumeSession(clientA), consumeSession(clientB)]);
            await Promise.all([
                joinChannel(clientA, 'isolation-ch1'),
                joinChannel(clientB, 'isolation-ch2'),
            ]);

            clientA.send({
                service: 'chat',
                action: 'send',
                channel: 'isolation-ch1',
                message: 'only for ch1',
            });

            // Verify sender received the `sent` ack (proving the send happened).
            await clientA.waitForMessage(
                (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
            );

            // Client B should NOT receive a chat message frame.
            const received = await doesNotReceive(
                clientB,
                (m) => (m as any).type === 'chat' && (m as any).action === 'message',
                500,
            );

            expect(received).toBe(false);
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });

    // -----------------------------------------------------------------------
    // 4. Message history: new client can retrieve prior messages
    // -----------------------------------------------------------------------

    it('message history: new client can request history and gets prior messages', async () => {
        const sender = await connectTestClient(server.url);
        try {
            await consumeSession(sender);
            await joinChannel(sender, 'history-ch');

            // Send 3 messages
            for (const text of ['msg-1', 'msg-2', 'msg-3']) {
                sender.send({ service: 'chat', action: 'send', channel: 'history-ch', message: text });
                // Wait for sent ack before next send to preserve ordering.
                await sender.waitForMessage(
                    (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
                );
            }
        } finally {
            await sender.disconnect();
        }

        // New client joins and requests history.
        const reader = await connectTestClient(server.url);
        try {
            await consumeSession(reader);

            reader.send({ service: 'chat', action: 'history', channel: 'history-ch' });

            const frame = await reader.waitForMessage(
                (m) =>
                    (m as any).type === 'chat' &&
                    (m as any).action === 'history' &&
                    (m as any).channel === 'history-ch',
            );

            const messages: any[] = (frame as any).messages;
            expect(Array.isArray(messages)).toBe(true);
            expect(messages.length).toBe(3);
            // LRU cache iterates in MRU order; assert all messages are present
            // regardless of iteration order.
            const texts = messages.map((m: any) => m.message).sort();
            expect(texts).toEqual(['msg-1', 'msg-2', 'msg-3']);
        } finally {
            await reader.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // 5. No cross-client leakage: sent ack goes only to sender
    // -----------------------------------------------------------------------

    it('no cross-client leakage: sent ack is private to the sending client', async () => {
        const [clientA, clientB] = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);
        try {
            await Promise.all([consumeSession(clientA), consumeSession(clientB)]);
            await Promise.all([
                joinChannel(clientA, 'ack-isolation'),
                joinChannel(clientB, 'ack-isolation'),
            ]);

            clientA.send({
                service: 'chat',
                action: 'send',
                channel: 'ack-isolation',
                message: 'check ack',
            });

            // Client A receives its `sent` ack.
            const ack = await clientA.waitForMessage(
                (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
            );
            expect((ack as any).channel).toBe('ack-isolation');

            // Client B should NOT receive a `sent` ack — it gets the broadcast
            // `message` frame only. Confirm no `sent` frame arrives for B.
            const leaked = await doesNotReceive(
                clientB,
                (m) => (m as any).type === 'chat' && (m as any).action === 'sent',
                400,
            );

            expect(leaked).toBe(false);
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });
});
