// realtime-modules/test/integration/ingest.test.ts
//
// Integration tests for IngestService using the real WS harness.
// No external services required — in-process message router stub.
//
// Covers:
//   - Server start / WS handshake
//   - Subscribe to ingest:progress → subscribed ack
//   - Subscribe to ingest:source:{id} → subscribed ack
//   - Subscribe with invalid channel → error frame
//   - Unsubscribe → unsubscribed ack
//   - emitEvent → delivered to local subscribers when no messageRouter
//   - Unknown action → error frame

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { IngestService } from '../../src/ingest/IngestService';

// ---------------------------------------------------------------------------
// Minimal logger
// ---------------------------------------------------------------------------

const noopLogger = {
    debug(): void { /* noop */ },
    info(): void { /* noop */ },
    warn(): void { /* noop */ },
    error(): void { /* noop */ },
};

// ---------------------------------------------------------------------------
// In-process message router for IngestService
// ---------------------------------------------------------------------------

class IngestTestRouter {
    private handle: WsHandlerHandle | null = null;
    /** channel → Set<clientId> — for sendToChannel fan-out */
    private channelMembers = new Map<string, Set<string>>();

    setHandle(h: WsHandlerHandle): void { this.handle = h; }

    sendToClient(clientId: string, message: unknown): void {
        this.handle?.sendToClient(clientId, message as Record<string, unknown>);
    }

    sendToChannel(channel: string, message: unknown): void {
        const members = this.channelMembers.get(channel);
        if (!members) return;
        for (const clientId of members) {
            this.sendToClient(clientId, message);
        }
    }

    subscribeToChannel(clientId: string, channel: string): void {
        if (!this.channelMembers.has(channel)) this.channelMembers.set(channel, new Set());
        this.channelMembers.get(channel)!.add(clientId);
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
        this.channelMembers.get(channel)?.delete(clientId);
    }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

interface IngestTestServer {
    url: string;
    ingestSvc: IngestService;
    stop(): Promise<void>;
}

async function startIngestServer(): Promise<IngestTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    const router = new IngestTestRouter();

    const ingestSvc = new IngestService({ logger: noopLogger, messageRouter: router });

    const handle = createWsHandler({
        server: httpServer,
        services: { ingest: ingestSvc } as any,
        pingIntervalMs: 0,
    });

    router.setHandle(handle);

    return {
        url: `ws://127.0.0.1:${port}`,
        ingestSvc,
        async stop(): Promise<void> {
            await handle.dispose();
            await new Promise<void>((resolve) => {
                if (typeof (httpServer as any).closeAllConnections === 'function') {
                    try { (httpServer as any).closeAllConnections(); } catch { /* swallow */ }
                }
                const t = setTimeout(() => resolve(), 500);
                httpServer.close(() => { clearTimeout(t); resolve(); });
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Test client helper
// ---------------------------------------------------------------------------

async function connectClient(url: string): Promise<{
    ws: WebSocket;
    clientId: string;
    send(msg: object): void;
    waitFor(pred: (m: object) => boolean, ms?: number): Promise<object>;
    close(): Promise<void>;
}> {
    const ws = new WebSocket(url);
    const buffer: object[] = [];
    const waiters: Array<{
        predicate: (msg: object) => boolean;
        resolve: (msg: object) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    ws.on('message', (raw) => {
        let parsed: object;
        try { parsed = JSON.parse(raw.toString()); } catch { parsed = { __raw: raw.toString() }; }
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
            reject(new Error(`WS upgrade rejected: HTTP ${res.statusCode}`));
        });
    });

    const obj = {
        ws,
        clientId: '',
        send(msg: object) { ws.send(JSON.stringify(msg)); },
        waitFor(predicate: (m: object) => boolean, timeoutMs = 3_000) {
            const bufferedIdx = buffer.findIndex(predicate);
            if (bufferedIdx !== -1) return Promise.resolve(buffer.splice(bufferedIdx, 1)[0]);
            return new Promise<object>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                waiters.push({ predicate, resolve, reject, timer });
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

    const session = await obj.waitFor((m) => (m as any).type === 'session') as any;
    obj.clientId = session.clientId ?? '';

    return obj;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingest feature integration', () => {
    let server: IngestTestServer;

    beforeAll(async () => {
        server = await startIngestServer();
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections with session handshake', async () => {
        expect(server).toBeDefined();
        const client = await connectClient(server.url);
        expect(client.clientId).toMatch(/^c_/);
        await client.close();
    });

    it('subscribe to ingest:progress → subscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('ingest:progress');
        } finally {
            await client.close();
        }
    });

    it('subscribe to ingest:source:{id} → subscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:source:datasource-42' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('ingest:source:datasource-42');
        } finally {
            await client.close();
        }
    });

    it('subscribe with invalid channel format → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'ingest', action: 'subscribe', channel: 'not-a-valid-ingest-channel' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'ingest',
            );
            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('ingest');
        } finally {
            await client.close();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            await client.waitFor(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'ingest', action: 'unsubscribe', channel: 'ingest:progress' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'unsubscribed',
            );
            expect((frame as any).channel).toBe('ingest:progress');
        } finally {
            await client.close();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'ingest', action: 'publish', channel: 'ingest:progress' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'ingest',
            );
            expect((frame as any).message).toMatch(/unknown ingest action/i);
        } finally {
            await client.close();
        }
    });

    it('emitEvent → subscribed clients receive ingest:event frame', async () => {
        // Use a standalone IngestService with no router so it falls back to
        // _broadcastToLocalSubscribers — verifies the in-memory fan-out path.
        const httpServer = http.createServer();
        await new Promise<void>((resolve, reject) => {
            httpServer.on('error', reject);
            httpServer.listen(0, '127.0.0.1', () => resolve());
        });

        const addr = httpServer.address() as { port: number };
        let handleRef2: ReturnType<typeof createWsHandler> | null = null;

        const localSvc = new IngestService({
            logger: noopLogger,
            messageRouter: {
                sendToClient: (cid: string, msg: unknown) =>
                    handleRef2?.sendToClient(cid, msg as Record<string, unknown>),
                sendToChannel: () => { throw new Error('sendToChannel should not be called in local mode'); },
                subscribeToChannel: (_cid: string, _ch: string) => Promise.resolve(),
                unsubscribeFromChannel: (_cid: string, _ch: string) => Promise.resolve(),
            },
        });

        // Swap to no router to use local broadcast path.
        // We test emitEvent directly by calling it after subscribe registers the tracker.
        const noRouterSvc = new IngestService({ logger: noopLogger });

        const handle2 = createWsHandler({
            server: httpServer,
            services: { ingest: noRouterSvc } as any,
            pingIntervalMs: 0,
        });
        handleRef2 = handle2;

        // Wire sendToClient manually since no router.
        (noRouterSvc as any).sendToClient = (clientId: string, msg: unknown) =>
            handle2.sendToClient(clientId, msg as Record<string, unknown>);

        const testUrl = `ws://127.0.0.1:${addr.port}`;
        const subscriber = await connectClient(testUrl);

        try {
            // Subscribe so clientChannels tracker has this client.
            subscriber.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            await subscriber.waitFor(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );

            // Emit an event directly.
            await noRouterSvc.emitEvent('ingest:progress', {
                type: 'progress',
                sourceId: 'src-1',
                percent: 42,
            });

            const frame = await subscriber.waitFor(
                (m) => (m as any).type === 'ingest:event',
            );
            expect((frame as any).channel).toBe('ingest:progress');
            expect((frame as any).event.percent).toBe(42);
        } finally {
            await subscriber.close();
            await handle2.dispose();
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer.close(() => { clearTimeout(t); resolve(); });
            });
        }
    });
});
