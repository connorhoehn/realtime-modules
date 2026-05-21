// realtime-modules/test/integration/multichannel.test.ts
//
// Multi-channel routing isolation tests.
//
// Each test verifies that the routing layer correctly confines events to the
// channel they were sent on, using a shared server wired with chat + presence
// + cursor via createRealtimeServer (real services, no stubs).
//
// Test categories:
//   1. Chat isolation       — messages in ch-1 don't appear in ch-2 subscriptions
//   2. Presence isolation   — join ch-1 doesn't trigger presence events on ch-2
//   3. Single client / two channels — one client can independently receive
//                             events from two subscribed channels
//   4. High cardinality     — 5 channels × 2 clients each, no cross-talk

import * as http from 'http';
import WebSocket from 'ws';
import {
    createRealtimeServer,
    inMemoryAdapters,
} from '../../src/server';
import { ChatManifest } from '../../src/chat';
import { PresenceManifest } from '../../src/presence';
import { CursorManifest } from '../../src/cursor';

// ---------------------------------------------------------------------------
// Minimal client with predicate-based waitForMessage
// ---------------------------------------------------------------------------

interface TestClient {
    ws: WebSocket;
    clientId: string | null;
    send(msg: object): void;
    waitForMessage(
        predicate: (msg: Record<string, unknown>) => boolean,
        timeoutMs?: number,
    ): Promise<Record<string, unknown>>;
    disconnect(): Promise<void>;
}

async function connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);

    const buffer: Record<string, unknown>[] = [];
    const waiters: Array<{
        predicate: (m: Record<string, unknown>) => boolean;
        resolve: (m: Record<string, unknown>) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];
    let assignedClientId: string | null = null;

    ws.on('message', (raw) => {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            parsed = { __raw: raw.toString() };
        }
        if (parsed.type === 'session' && typeof parsed.clientId === 'string') {
            assignedClientId = parsed.clientId;
        }
        const idx = waiters.findIndex((w) => w.predicate(parsed));
        if (idx !== -1) {
            const w = waiters.splice(idx, 1)[0];
            clearTimeout(w.timer);
            w.resolve(parsed);
        } else {
            buffer.push(parsed);
        }
    });

    await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => {
            reject(new Error(`WS rejected: HTTP ${res.statusCode}`));
        });
    });

    return {
        ws,
        get clientId() { return assignedClientId; },
        send(msg) { ws.send(JSON.stringify(msg)); },
        waitForMessage(predicate, timeoutMs = 3_000) {
            const bufferedIdx = buffer.findIndex((m) => predicate(m));
            if (bufferedIdx !== -1) {
                return Promise.resolve(buffer.splice(bufferedIdx, 1)[0]);
            }
            return new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const i = waiters.findIndex((w) => w.resolve === resolve);
                    if (i !== -1) waiters.splice(i, 1);
                    reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                waiters.push({ predicate, resolve, reject, timer });
            });
        },
        disconnect() {
            return new Promise<void>((resolve) => {
                if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
                ws.once('close', () => resolve());
                ws.close();
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

interface TestServer {
    url: string;
    stop(): Promise<void>;
}

async function startMultiFeatureServer(): Promise<TestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((res, rej) => {
        httpServer.on('error', rej);
        httpServer.listen(0, '127.0.0.1', () => res());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    const handle = createRealtimeServer(
        [ChatManifest, PresenceManifest, CursorManifest],
        inMemoryAdapters(),
        { server: httpServer, pingIntervalMs: 0 },
    );

    return {
        url: `ws://127.0.0.1:${port}`,
        async stop() {
            await handle.dispose();
            if (typeof (httpServer as any).closeAllConnections === 'function') {
                try { (httpServer as any).closeAllConnections(); } catch { /* swallow */ }
            }
            await new Promise<void>((res) => {
                const t = setTimeout(() => res(), 500);
                httpServer.close(() => { clearTimeout(t); res(); });
            });
        },
    };
}

// Convenience: wait for session frame and return assigned clientId.
async function waitForSession(client: TestClient): Promise<string> {
    const frame = await client.waitForMessage((m) => m.type === 'session');
    return frame.clientId as string;
}

// Join a chat channel + wait for the 'joined' ack.
async function chatJoin(client: TestClient, channel: string): Promise<void> {
    client.send({ service: 'chat', action: 'join', channel });
    // Drain up to 5 frames looking for the joined ack (history frames may
    // arrive first).
    for (let i = 0; i < 5; i++) {
        const f = await client.waitForMessage(
            (m) => m.type === 'chat' && (m.action === 'joined' || m.action === 'error'),
            3_000,
        );
        if (f.action === 'joined') return;
    }
    throw new Error(`chatJoin: never received 'joined' ack for ${channel}`);
}

// Subscribe to cursor updates in a channel.
async function cursorSubscribe(client: TestClient, channel: string): Promise<void> {
    client.send({ service: 'cursor', action: 'subscribe', channel });
    await client.waitForMessage(
        (m) => m.type === 'cursor' && m.action === 'subscribed' && m.channel === channel,
    );
}

// Send one chat message.
function chatSend(client: TestClient, channel: string, text: string): void {
    client.send({ service: 'chat', action: 'send', channel, message: text });
}

// Send one cursor update.
function cursorUpdate(
    client: TestClient,
    channel: string,
    x: number,
    y: number,
): void {
    client.send({
        service: 'cursor',
        action: 'update',
        channel,
        position: { x, y },
        mode: 'freeform',
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('multi-channel routing isolation', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startMultiFeatureServer();
    });

    afterAll(async () => {
        await server.stop();
    });

    // -------------------------------------------------------------------------
    // 1. Chat isolation
    // -------------------------------------------------------------------------

    it('chat: message in channel-1 is NOT delivered to a client subscribed only to channel-2', async () => {
        const [sender, receiver] = await Promise.all([
            connect(server.url),
            connect(server.url),
        ]);

        try {
            await Promise.all([
                waitForSession(sender),
                waitForSession(receiver),
            ]);

            // Sender joins chat-iso-1 and receiver joins chat-iso-2.
            await chatJoin(sender, 'chat-iso-1');
            await chatJoin(receiver, 'chat-iso-2');

            // Sender posts to chat-iso-1.
            chatSend(sender, 'chat-iso-1', 'hello-channel-1');

            // Receiver should NOT get this message (it is only in chat-iso-2).
            await expect(
                receiver.waitForMessage(
                    (m) =>
                        m.type === 'chat' &&
                        m.action === 'message' &&
                        m.channel === 'chat-iso-1',
                    400,
                ),
            ).rejects.toThrow(/timed out/);
        } finally {
            await Promise.all([sender.disconnect(), receiver.disconnect()]);
        }
    });

    it('chat: message is delivered to all clients joined to the same channel', async () => {
        const [senderA, receiverB] = await Promise.all([
            connect(server.url),
            connect(server.url),
        ]);

        try {
            await Promise.all([
                waitForSession(senderA),
                waitForSession(receiverB),
            ]);

            // Both join the same chat channel.
            await Promise.all([
                chatJoin(senderA, 'chat-shared'),
                chatJoin(receiverB, 'chat-shared'),
            ]);

            chatSend(senderA, 'chat-shared', 'broadcast-test');

            const frame = await receiverB.waitForMessage(
                (m) =>
                    m.type === 'chat' &&
                    m.action === 'message' &&
                    m.channel === 'chat-shared',
                3_000,
            );

            expect(frame.channel).toBe('chat-shared');
            // ChatMessage shape: { id, clientId, channel, message, timestamp }
            // Broadcast frame: { type:'chat', action:'message', channel, message: ChatMessage }
            const chatMsg = frame.message as Record<string, unknown>;
            expect(chatMsg.message).toBe('broadcast-test');
        } finally {
            await Promise.all([senderA.disconnect(), receiverB.disconnect()]);
        }
    });

    // -------------------------------------------------------------------------
    // 2. Presence isolation
    // -------------------------------------------------------------------------

    it('presence: subscribing to channel-1 and setting presence does not trigger events on channel-2 subscriber', async () => {
        const [clientA, clientB] = await Promise.all([
            connect(server.url),
            connect(server.url),
        ]);

        try {
            // Drain session frames.
            await Promise.all([
                waitForSession(clientA),
                waitForSession(clientB),
            ]);

            // clientB subscribes to presence-iso-2.
            clientB.send({ service: 'presence', action: 'subscribe', channel: 'presence-iso-2' });
            await clientB.waitForMessage(
                (m) => m.type === 'presence' && m.action === 'subscribed' && m.channel === 'presence-iso-2',
                3_000,
            );

            // clientA subscribes to presence-iso-1 (different channel) and sets presence.
            clientA.send({ service: 'presence', action: 'subscribe', channel: 'presence-iso-1' });
            await clientA.waitForMessage(
                (m) => m.type === 'presence' && m.action === 'subscribed' && m.channel === 'presence-iso-1',
                3_000,
            );

            // A sets presence (broadcasts on presence:presence-iso-1 channel).
            clientA.send({ service: 'presence', action: 'set', status: 'online', channels: ['presence-iso-1'] });

            // Wait for A's own set-ack.
            await clientA.waitForMessage(
                (m) => m.type === 'presence' && m.action === 'set',
                3_000,
            );

            // B should NOT receive any presence event from presence-iso-1 —
            // it is only subscribed to presence-iso-2.
            await expect(
                clientB.waitForMessage(
                    (m) => m.type === 'presence' && m.channel === 'presence-iso-1',
                    400,
                ),
            ).rejects.toThrow(/timed out/);
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });

    // -------------------------------------------------------------------------
    // 3. Single client subscribed to two channels receives events from both
    // -------------------------------------------------------------------------

    it('a single client subscribed to two cursor channels receives events from both independently', async () => {
        const [observer, senderCh1, senderCh2] = await Promise.all([
            connect(server.url),
            connect(server.url),
            connect(server.url),
        ]);

        try {
            await Promise.all([
                waitForSession(observer),
                waitForSession(senderCh1),
                waitForSession(senderCh2),
            ]);

            // Observer subscribes to BOTH channels.
            await Promise.all([
                cursorSubscribe(observer, 'dual-ch-1'),
                cursorSubscribe(observer, 'dual-ch-2'),
            ]);

            // Other senders subscribe to their respective channels.
            await cursorSubscribe(senderCh1, 'dual-ch-1');
            await cursorSubscribe(senderCh2, 'dual-ch-2');

            // Fire updates on both channels (sequentially to avoid throttle).
            cursorUpdate(senderCh1, 'dual-ch-1', 11, 22);

            // Wait for ch-1 event before sending ch-2 (avoids 250ms throttle
            // on senderCh2 which is a different client so throttle doesn't apply,
            // but let's be safe).
            const frameCh1 = await observer.waitForMessage(
                (m) =>
                    m.type === 'cursor' &&
                    m.action === 'update' &&
                    m.channel === 'dual-ch-1',
            );

            cursorUpdate(senderCh2, 'dual-ch-2', 33, 44);

            const frameCh2 = await observer.waitForMessage(
                (m) =>
                    m.type === 'cursor' &&
                    m.action === 'update' &&
                    m.channel === 'dual-ch-2',
            );

            // Verify each frame carries the correct channel + position.
            expect(frameCh1.channel).toBe('dual-ch-1');
            const pos1 = (frameCh1.cursor as Record<string, unknown>).position as Record<string, unknown>;
            expect(pos1.x).toBe(11);
            expect(pos1.y).toBe(22);

            expect(frameCh2.channel).toBe('dual-ch-2');
            const pos2 = (frameCh2.cursor as Record<string, unknown>).position as Record<string, unknown>;
            expect(pos2.x).toBe(33);
            expect(pos2.y).toBe(44);
        } finally {
            await Promise.all([
                observer.disconnect(),
                senderCh1.disconnect(),
                senderCh2.disconnect(),
            ]);
        }
    });

    // -------------------------------------------------------------------------
    // 4. High cardinality: 5 channels × 2 clients — no cross-talk
    // -------------------------------------------------------------------------

    it('5 channels × 2 clients each: cursor updates do not leak across channels', async () => {
        const CHANNEL_COUNT = 5;

        // Build channels: 'hc-0' … 'hc-4'
        const channelNames = Array.from({ length: CHANNEL_COUNT }, (_, i) => `hc-${i}`);

        // Connect 2 clients per channel (sender + receiver).
        const pairs: Array<{ sender: TestClient; receiver: TestClient; ch: string }> = [];

        for (const ch of channelNames) {
            const [sender, receiver] = await Promise.all([
                connect(server.url),
                connect(server.url),
            ]);
            pairs.push({ sender, receiver, ch });
        }

        try {
            // Drain session frames for all clients.
            await Promise.all(
                pairs.flatMap(({ sender, receiver }) => [
                    waitForSession(sender),
                    waitForSession(receiver),
                ]),
            );

            // Subscribe all senders + receivers to their own channel.
            await Promise.all(
                pairs.flatMap(({ sender, receiver, ch }) => [
                    cursorSubscribe(sender, ch),
                    cursorSubscribe(receiver, ch),
                ]),
            );

            // Each sender sends a unique position.
            for (let i = 0; i < pairs.length; i++) {
                cursorUpdate(pairs[i].sender, pairs[i].ch, i * 10, i * 10 + 1);
            }

            // Each receiver must get EXACTLY the update from its own channel sender.
            const results = await Promise.all(
                pairs.map(({ receiver, ch }) =>
                    receiver.waitForMessage(
                        (m) =>
                            m.type === 'cursor' &&
                            m.action === 'update' &&
                            m.channel === ch,
                        3_000,
                    ),
                ),
            );

            // Validate positions match per-channel sender.
            for (let i = 0; i < CHANNEL_COUNT; i++) {
                const frame = results[i];
                expect(frame.channel).toBe(pairs[i].ch);
                const pos = (frame.cursor as Record<string, unknown>).position as Record<string, unknown>;
                expect(pos.x).toBe(i * 10);
                expect(pos.y).toBe(i * 10 + 1);
            }

            // Cross-talk check: no receiver should have buffered frames from
            // other channels. Each receiver should have zero pending cursor
            // update messages (beyond the one already consumed above).
            //
            // Strategy: give each receiver 200ms and assert it gets nothing.
            const crossTalkChecks = pairs.map(({ receiver }) =>
                receiver.waitForMessage(
                    (m) => m.type === 'cursor' && m.action === 'update',
                    200,
                ).then(
                    // If we DO get a message, fail with details.
                    (unexpected) => {
                        throw new Error(
                            `cross-talk detected: receiver got unexpected frame: ${JSON.stringify(unexpected)}`,
                        );
                    },
                    // Timeout = correct — no cross-talk.
                    (err: Error) => {
                        if (/timed out/.test(err.message)) return;
                        throw err;
                    },
                ),
            );
            await Promise.all(crossTalkChecks);
        } finally {
            await Promise.all(
                pairs.flatMap(({ sender, receiver }) => [
                    sender.disconnect(),
                    receiver.disconnect(),
                ]),
            );
        }
    });
});
