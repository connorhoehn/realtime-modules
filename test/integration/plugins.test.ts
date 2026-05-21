// realtime-modules/test/integration/plugins.test.ts
//
// Integration tests for v0.5.0 features:
//   1. Per-feature adapter overrides (PerFeatureAdapters form)
//   2. FeaturePlugin lifecycle hooks: onConnect, onDisconnect, onMessage
//   3. Multiple plugins called in order
//   4. Plugin errors are swallowed (do not crash the server)

import http from 'http';
import WebSocket from 'ws';
import {
    createRealtimeServer,
    inMemoryAdapters,
    type PerFeatureAdapters,
    type FeaturePlugin,
} from '../../src/server';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import { ChatManifest } from '../../src/chat';
import { ActivityManifest } from '../../src/activity';

// ---------------------------------------------------------------------------
// Minimal queued WebSocket client (mirrors factory.test.ts)
// ---------------------------------------------------------------------------

interface QueuedClient {
    ws: WebSocket;
    nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
    open(): Promise<void>;
    close(): Promise<void>;
}

function makeQueuedClient(url: string): QueuedClient {
    const ws = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<{
        resolve: (v: Record<string, unknown>) => void;
        reject: (e: Error) => void;
    }> = [];
    let openResolve: (() => void) | null = null;
    let openReject: ((e: Error) => void) | null = null;
    let opened = false;
    let errored: Error | null = null;

    ws.on('open', () => { opened = true; openResolve?.(); });
    ws.on('error', (err: Error) => {
        errored = err;
        openReject?.(err);
        for (const w of waiters.splice(0)) w.reject(err);
    });
    ws.on('message', (data: WebSocket.RawData) => {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data.toString()); }
        catch { parsed = { __raw: data.toString() }; }
        if (waiters.length > 0) {
            waiters.shift()!.resolve(parsed);
        } else {
            queue.push(parsed);
        }
    });

    return {
        ws,
        open(): Promise<void> {
            if (opened) return Promise.resolve();
            if (errored) return Promise.reject(errored);
            return new Promise<void>((res, rej) => { openResolve = res; openReject = rej; });
        },
        nextMessage(timeoutMs = 3_000): Promise<Record<string, unknown>> {
            if (queue.length > 0) return Promise.resolve(queue.shift()!);
            return new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === wrapped);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`nextMessage timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                const wrapped = (v: Record<string, unknown>): void => { clearTimeout(timer); resolve(v); };
                waiters.push({ resolve: wrapped, reject: (e) => { clearTimeout(timer); reject(e); } });
            });
        },
        close(): Promise<void> {
            return new Promise<void>((resolve) => {
                if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
                ws.once('close', () => resolve());
                ws.close();
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

type ServerHandle = {
    port: number;
    server: http.Server;
    handle: ReturnType<typeof createRealtimeServer>;
};

function startServer(
    features: Parameters<typeof createRealtimeServer>[0],
    adapters: Parameters<typeof createRealtimeServer>[1],
    plugins: FeaturePlugin[] = [],
): Promise<ServerHandle> {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') { reject(new Error('Failed to bind')); return; }
            const handle = createRealtimeServer(features, adapters, {
                server,
                pingIntervalMs: 0,
                plugins,
            });
            resolve({ port: addr.port, server, handle });
        });
    });
}

async function stopServer(h: ServerHandle): Promise<void> {
    await h.handle.dispose();
    await new Promise<void>((resolve) => {
        if (typeof (h.server as any).closeAllConnections === 'function') {
            try { (h.server as any).closeAllConnections(); } catch { /* swallow */ }
        }
        h.server.close(() => resolve());
        setTimeout(resolve, 500);
    });
}

/** Drain up to `n` frames; return the first one matching `pred`, or undefined. */
async function findFrame(
    client: QueuedClient,
    pred: (f: Record<string, unknown>) => boolean,
    maxFrames = 6,
): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < maxFrames; i++) {
        try {
            const f = await client.nextMessage(2_000);
            if (pred(f)) return f;
        } catch {
            break;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerFeatureAdapters (AdapterConfig)', () => {
    it('accepts PerFeatureAdapters form and wires the provided chat store', async () => {
        const chatStore = new InMemoryChatStore();

        const adapters: PerFeatureAdapters = {
            chat: { store: chatStore },
        };

        const srv = await startServer([ChatManifest], adapters);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            // Consume session frame.
            await client.nextMessage();

            // Join and send a message.
            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'test-room' }));
            await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');

            client.ws.send(JSON.stringify({
                service: 'chat',
                action: 'send',
                channel: 'test-room',
                message: 'hello world',
                userId: 'user-1',
                username: 'Alice',
            }));

            // Allow the server to process the message.
            await new Promise((r) => setTimeout(r, 150));

            // Verify the message was persisted into the provided store.
            const msgs = await chatStore.listMessages('test-room', 50);
            expect(msgs.some((m) => m.message === 'hello world')).toBe(true);
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });

    it('accepts flat AdapterMap (inMemoryAdapters) unchanged', async () => {
        const srv = await startServer([ChatManifest], inMemoryAdapters());
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'room-a' }));
            const joined = await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');
            expect(joined).toBeDefined();
            expect(joined!.channel).toBe('room-a');
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });

    it('accepts PerFeatureAdapters with no chat field (uses service default)', async () => {
        const adapters: PerFeatureAdapters = {
            // chat not specified — ChatService uses its own InMemoryChatStore.
        };
        const srv = await startServer([ChatManifest], adapters);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'room-b' }));
            const joined = await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');
            expect(joined).toBeDefined();
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });
});

describe('FeaturePlugin lifecycle hooks', () => {
    it('onConnect is fired when a client subscribes to a channel', async () => {
        const connects: Array<{ clientId: string; channelId: string }> = [];

        const plugin: FeaturePlugin = {
            name: 'test-connect',
            onConnect(ctx) { connects.push({ ...ctx }); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [plugin]);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'ch-1' }));
            await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');

            // Allow async plugin calls to settle.
            await new Promise((r) => setTimeout(r, 50));

            expect(connects.length).toBeGreaterThanOrEqual(1);
            const hit = connects.find((c) => c.channelId === 'ch-1');
            expect(hit).toBeDefined();
            expect(typeof hit!.clientId).toBe('string');
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });

    it('onDisconnect is fired with correct channels when client disconnects', async () => {
        const disconnects: Array<{ clientId: string; channels: string[] }> = [];

        const plugin: FeaturePlugin = {
            name: 'test-disconnect',
            onDisconnect(ctx) { disconnects.push({ clientId: ctx.clientId, channels: [...ctx.channels] }); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [plugin]);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            // Subscribe to a channel so the router tracks it.
            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'disc-ch' }));
            await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');

            await client.close();
            // Give the close event time to propagate server-side.
            await new Promise((r) => setTimeout(r, 150));

            expect(disconnects.length).toBeGreaterThanOrEqual(1);
            const hit = disconnects.find((d) => d.channels.includes('disc-ch'));
            expect(hit).toBeDefined();
        } finally {
            await stopServer(srv);
        }
    });

    it('onMessage is fired when a message is sent to a channel', async () => {
        const messages: Array<{ clientId: string; channelId: string; message: unknown }> = [];

        const plugin: FeaturePlugin = {
            name: 'test-message',
            onMessage(ctx) { messages.push({ ...ctx }); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [plugin]);
        const clientA = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        const clientB = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await clientA.open();
            await clientB.open();
            await clientA.nextMessage(); // session A
            await clientB.nextMessage(); // session B

            // Both join the same channel.
            clientA.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'msg-ch' }));
            clientB.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'msg-ch' }));
            await findFrame(clientA, (f) => f.type === 'chat' && f.action === 'joined');
            await findFrame(clientB, (f) => f.type === 'chat' && f.action === 'joined');

            // A sends a message.
            clientA.ws.send(JSON.stringify({
                service: 'chat',
                action: 'send',
                channel: 'msg-ch',
                message: 'plugin-test',
                userId: 'user-a',
                username: 'Alice',
            }));

            await new Promise((r) => setTimeout(r, 150));

            expect(messages.some((m) => m.channelId === 'msg-ch')).toBe(true);
        } finally {
            await clientA.close();
            await clientB.close();
            await stopServer(srv);
        }
    });

    it('multiple plugins are called in array order', async () => {
        const order: string[] = [];

        const pluginA: FeaturePlugin = {
            name: 'plugin-A',
            onConnect() { order.push('A'); },
        };
        const pluginB: FeaturePlugin = {
            name: 'plugin-B',
            onConnect() { order.push('B'); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [pluginA, pluginB]);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'order-ch' }));
            await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');
            await new Promise((r) => setTimeout(r, 50));

            // A should have been called before B for each connect event.
            const aIdx = order.indexOf('A');
            const bIdx = order.indexOf('B');
            expect(aIdx).toBeGreaterThanOrEqual(0);
            expect(bIdx).toBeGreaterThanOrEqual(0);
            expect(aIdx).toBeLessThan(bIdx);
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });

    it('plugin errors are swallowed and do not crash the server', async () => {
        const throwingPlugin: FeaturePlugin = {
            name: 'throwing-plugin',
            onConnect() { throw new Error('plugin kaboom'); },
            onMessage() { throw new Error('plugin kaboom'); },
            onDisconnect() { throw new Error('plugin kaboom'); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [throwingPlugin]);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            // Joining should not crash the server despite the plugin throwing.
            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'crash-ch' }));
            const joined = await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');
            expect(joined).toBeDefined();

            // Sending a message should also survive.
            client.ws.send(JSON.stringify({
                service: 'chat',
                action: 'send',
                channel: 'crash-ch',
                message: 'after-throw',
                userId: 'u1',
                username: 'U1',
            }));

            // Server should still be reachable.
            await new Promise((r) => setTimeout(r, 100));
            expect(srv.handle.listClients().length).toBeGreaterThanOrEqual(1);
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });

    it('async plugin hooks that reject are swallowed', async () => {
        const asyncThrowPlugin: FeaturePlugin = {
            name: 'async-throw',
            async onConnect() { throw new Error('async kaboom'); },
        };

        const srv = await startServer([ChatManifest], inMemoryAdapters(), [asyncThrowPlugin]);
        const client = makeQueuedClient(`ws://127.0.0.1:${srv.port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'async-ch' }));
            const joined = await findFrame(client, (f) => f.type === 'chat' && f.action === 'joined');
            expect(joined).toBeDefined();
        } finally {
            await client.close();
            await stopServer(srv);
        }
    });
});
