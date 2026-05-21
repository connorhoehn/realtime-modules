// realtime-modules/test/integration/typed-documents.test.ts
//
// Integration tests for DocumentEventsService using the real WS harness.
// No external services required — in-process message router stub.
//
// Covers:
//   - Server start / WS handshake
//   - subscribe with documentId → subscribed ack (subscribes to both channels)
//   - subscribe with missing documentId → error frame
//   - subscribe with empty documentId string → error frame
//   - unsubscribe → unsubscribed ack
//   - unknown action → error frame

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { DocumentEventsService } from '../../src/typed-documents/DocumentEventsService';

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
// In-process message router for DocumentEventsService
// ---------------------------------------------------------------------------

class DocumentEventsTestRouter {
    private handle: WsHandlerHandle | null = null;
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

interface DocEventsTestServer {
    url: string;
    stop(): Promise<void>;
}

async function startDocEventsServer(): Promise<DocEventsTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    const router = new DocumentEventsTestRouter();

    const docSvc = new DocumentEventsService({ logger: noopLogger, messageRouter: router });

    const handle = createWsHandler({
        server: httpServer,
        // The WS service key must match what clients send as `service`.
        // Gateway uses 'document-events' (same as the service name in the manifest).
        services: { 'document-events': docSvc } as any,
        pingIntervalMs: 0,
    });

    router.setHandle(handle);

    return {
        url: `ws://127.0.0.1:${port}`,
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

describe('typed-documents feature integration', () => {
    let server: DocEventsTestServer;

    beforeAll(async () => {
        server = await startDocEventsServer();
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

    it('subscribe with documentId → subscribed ack with correct documentId', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({
                service: 'document-events',
                action: 'subscribe',
                documentId: 'doc-001',
            });

            const frame = await client.waitFor(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'subscribed',
            );

            expect((frame as any).documentId).toBe('doc-001');
            expect(typeof (frame as any).timestamp).toBe('string');
        } finally {
            await client.close();
        }
    });

    it('subscribe without documentId → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'document-events', action: 'subscribe' });

            const frame = await client.waitFor(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('document-events');
        } finally {
            await client.close();
        }
    });

    it('subscribe with empty documentId string → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'document-events', action: 'subscribe', documentId: '' });

            const frame = await client.waitFor(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).type).toBe('error');
        } finally {
            await client.close();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({
                service: 'document-events',
                action: 'subscribe',
                documentId: 'doc-002',
            });
            await client.waitFor(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'subscribed',
            );

            client.send({
                service: 'document-events',
                action: 'unsubscribe',
                documentId: 'doc-002',
            });

            const frame = await client.waitFor(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'unsubscribed',
            );

            expect((frame as any).documentId).toBe('doc-002');
        } finally {
            await client.close();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({
                service: 'document-events',
                action: 'publish',
                documentId: 'doc-003',
            });

            const frame = await client.waitFor(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).message).toMatch(/unknown document-events action/i);
        } finally {
            await client.close();
        }
    });

    it('multiple clients can subscribe to the same document independently', async () => {
        const [clientA, clientB] = await Promise.all([
            connectClient(server.url),
            connectClient(server.url),
        ]);
        try {
            await Promise.all([
                (async () => {
                    clientA.send({ service: 'document-events', action: 'subscribe', documentId: 'shared-doc' });
                    return clientA.waitFor(
                        (m) =>
                            (m as any).type === 'document-events' &&
                            (m as any).action === 'subscribed' &&
                            (m as any).documentId === 'shared-doc',
                    );
                })(),
                (async () => {
                    clientB.send({ service: 'document-events', action: 'subscribe', documentId: 'shared-doc' });
                    return clientB.waitFor(
                        (m) =>
                            (m as any).type === 'document-events' &&
                            (m as any).action === 'subscribed' &&
                            (m as any).documentId === 'shared-doc',
                    );
                })(),
            ]);

            // Both should have received subscribed ack — if we reach here, the test passes.
            expect(true).toBe(true);
        } finally {
            await Promise.all([clientA.close(), clientB.close()]);
        }
    });
});
