// realtime-modules/test/integration/factory.test.ts
//
// Basic integration test for createRealtimeServer + inMemoryAdapters.
// Verifies the factory returns a working WsHandlerHandle, attaches to a
// real http.Server, and routes WS frames to the expected services.

import http from 'http';
import WebSocket from 'ws';
import {
    createRealtimeServer,
    inMemoryAdapters,
} from '../../src/server';
import { ChatManifest } from '../../src/chat';
import { PresenceManifest } from '../../src/presence';
import { ReactionsManifest } from '../../src/reactions';
import { CursorManifest } from '../../src/cursor';
import { ActivityManifest } from '../../src/activity';

// ---------------------------------------------------------------------------
// Helpers — mirrored from test/server-ws/createWsHandler.test.ts
//
// The message listener MUST be attached before the socket opens, otherwise
// the server's synchronous session frame is delivered before we have a
// listener and is silently discarded.
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

    ws.on('open', () => {
        opened = true;
        openResolve?.();
    });
    ws.on('error', (err: Error) => {
        errored = err;
        openReject?.(err);
        for (const w of waiters.splice(0)) w.reject(err);
    });
    ws.on('message', (data: WebSocket.RawData) => {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(data.toString());
        } catch {
            parsed = { __raw: data.toString() };
        }
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
            return new Promise<void>((res, rej) => {
                openResolve = res;
                openReject = rej;
            });
        },
        nextMessage(timeoutMs = 3_000): Promise<Record<string, unknown>> {
            if (queue.length > 0) return Promise.resolve(queue.shift()!);
            return new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === wrapped);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`nextMessage timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                const wrapped = (v: Record<string, unknown>): void => {
                    clearTimeout(timer);
                    resolve(v);
                };
                waiters.push({
                    resolve: wrapped,
                    reject: (e) => { clearTimeout(timer); reject(e); },
                });
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

function startServer(
    features: Parameters<typeof createRealtimeServer>[0] = [],
): Promise<{
    port: number;
    server: http.Server;
    handle: ReturnType<typeof createRealtimeServer>;
}> {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('Failed to bind'));
                return;
            }
            const handle = createRealtimeServer(features, inMemoryAdapters(), {
                server,
                pingIntervalMs: 0, // no keepalive pings in tests
            });
            resolve({ port: addr.port, server, handle });
        });
    });
}

async function stopServer(
    handle: ReturnType<typeof createRealtimeServer>,
    server: http.Server,
): Promise<void> {
    await handle.dispose();
    await new Promise<void>((resolve) => {
        if (typeof (server as any).closeAllConnections === 'function') {
            try { (server as any).closeAllConnections(); } catch { /* swallow */ }
        }
        server.close(() => resolve());
        setTimeout(resolve, 500);
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRealtimeServer factory', () => {
    it('returns a WsHandlerHandle with the expected interface', async () => {
        const { handle, server } = await startServer([]);
        try {
            expect(handle).toBeDefined();
            expect(typeof handle.dispose).toBe('function');
            expect(typeof handle.listClients).toBe('function');
            expect(typeof handle.sendToClient).toBe('function');
            expect(handle.wss).toBeDefined();
        } finally {
            await stopServer(handle, server);
        }
    });

    it('accepts a WebSocket connection and sends a session frame', async () => {
        const { port, handle, server } = await startServer([ChatManifest, PresenceManifest]);
        const client = makeQueuedClient(`ws://127.0.0.1:${port}`);
        try {
            await client.open();
            // Some services (e.g. presence) may send frames in onClientConnect
            // before the session frame is emitted. Scan up to 5 frames.
            let session: Record<string, unknown> | undefined;
            for (let i = 0; i < 5; i++) {
                const f = await client.nextMessage();
                if (f.type === 'session') { session = f; break; }
            }
            expect(session).toBeDefined();
            expect(session!.status).toBe('connected');
            expect(typeof session!.clientId).toBe('string');
        } finally {
            await client.close();
            await stopServer(handle, server);
        }
    });

    it('routes a chat join action and receives a joined response', async () => {
        const { port, handle, server } = await startServer([ChatManifest]);
        const client = makeQueuedClient(`ws://127.0.0.1:${port}`);
        try {
            await client.open();
            // Consume the session frame.
            await client.nextMessage();

            client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'general' }));

            // The chat service sends a 'joined' ack (and may also send a
            // history frame if there are messages). Read frames until we find
            // the joined ack.
            let joined: Record<string, unknown> | undefined;
            for (let i = 0; i < 5; i++) {
                const f = await client.nextMessage();
                if (f.type === 'chat' && f.action === 'joined') {
                    joined = f;
                    break;
                }
            }
            expect(joined).toBeDefined();
            expect(joined!.channel).toBe('general');
        } finally {
            await client.close();
            await stopServer(handle, server);
        }
    });

    it('returns SERVICE_NOT_AVAILABLE for an unknown service name', async () => {
        // An unknown manifest is silently skipped → the handler has no such
        // service → it returns a SERVICE_NOT_AVAILABLE error frame.
        const unknownManifest = { name: 'not-a-real-feature', version: '0.1.0' };
        const { port, handle, server } = await startServer([unknownManifest as any]);
        const client = makeQueuedClient(`ws://127.0.0.1:${port}`);
        try {
            await client.open();
            await client.nextMessage(); // session

            client.ws.send(JSON.stringify({ service: 'not-a-real-feature', action: 'anything' }));
            const frame = await client.nextMessage();
            expect(frame.type).toBe('error');
            expect(frame.code).toBe('SERVICE_NOT_AVAILABLE');
        } finally {
            await client.close();
            await stopServer(handle, server);
        }
    });

    it('works with all built-in features wired at once', async () => {
        const features = [
            ChatManifest,
            PresenceManifest,
            ReactionsManifest,
            CursorManifest,
            ActivityManifest,
        ];
        const { port, handle, server } = await startServer(features);
        const client = makeQueuedClient(`ws://127.0.0.1:${port}`);
        try {
            await client.open();
            // Some services fire onClientConnect before the session frame.
            // Scan up to 10 frames for the session handshake.
            let session: Record<string, unknown> | undefined;
            for (let i = 0; i < 10; i++) {
                const f = await client.nextMessage();
                if (f.type === 'session') { session = f; break; }
            }
            expect(session).toBeDefined();

            // listClients reflects the connected client.
            expect(handle.listClients().length).toBe(1);
        } finally {
            await client.close();
            await stopServer(handle, server);
        }
    });

    it('inMemoryAdapters() returns adapters with the expected methods', () => {
        const adapters = inMemoryAdapters();
        expect(adapters).toBeDefined();
        expect(typeof adapters.chatStore?.putMessage).toBe('function');
        expect(typeof adapters.chatStore?.listMessages).toBe('function');
        expect(typeof adapters.activityHistoryStore?.append).toBe('function');
        expect(typeof adapters.activityHistoryStore?.list).toBe('function');
    });

    it('listClients tracks connected clients and decrements after close', async () => {
        const { port, handle, server } = await startServer([ChatManifest]);
        const client = makeQueuedClient(`ws://127.0.0.1:${port}`);
        try {
            await client.open();
            // Wait for the session frame (first frame for chat-only).
            await client.nextMessage();

            expect(handle.listClients().length).toBe(1);

            await client.close();
            // Allow the close event to propagate server-side.
            await new Promise((r) => setTimeout(r, 100));
            expect(handle.listClients().length).toBe(0);
        } finally {
            await stopServer(handle, server);
        }
    });
});
