// realtime-modules/test/integration/social.test.ts
//
// Integration tests for SocialService using the real WS harness.
// No external services required — in-process message router stub
// backed by createWsHandler directly (no Redis, no DDB).

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import { SocialService } from '../../src/social/SocialService';

// ---------------------------------------------------------------------------
// Minimal harness helpers (inline — keeps tests self-contained)
// ---------------------------------------------------------------------------

const noopLogger = {
    debug(): void { /* noop */ },
    info(): void { /* noop */ },
    warn(): void { /* noop */ },
    error(): void { /* noop */ },
};

interface MinimalTestServer {
    url: string;
    stop(): Promise<void>;
}

async function startSocialServer(): Promise<MinimalTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    // Deferred handle reference so the router can reach sendToClient.
    let handleRef: ReturnType<typeof createWsHandler> | null = null;

    const socialSvc = new SocialService({
        logger: noopLogger,
        messageRouter: {
            sendToClient: (clientId: string, msg: unknown) => {
                handleRef?.sendToClient(clientId, msg as Record<string, unknown>);
            },
            subscribeToChannel: (_clientId: string, _channel: string): Promise<void> =>
                Promise.resolve(),
            unsubscribeFromChannel: (_clientId: string, _channel: string): Promise<void> =>
                Promise.resolve(),
        },
    });

    const handle = createWsHandler({
        server: httpServer,
        services: { social: socialSvc } as any,
        pingIntervalMs: 0,
    });
    handleRef = handle;

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

async function connectClient(url: string): Promise<{
    ws: WebSocket;
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

    return {
        ws,
        send(msg: object) { ws.send(JSON.stringify(msg)); },
        waitFor(predicate, timeoutMs = 3_000) {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('social feature integration', () => {
    let server: MinimalTestServer;

    beforeAll(async () => {
        server = await startSocialServer();
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections', async () => {
        expect(server).toBeDefined();
        const client = await connectClient(server.url);
        // Server emits a session frame on connect.
        const frame = await client.waitFor((m) => (m as any).type === 'session');
        expect((frame as any).type).toBe('session');
        await client.close();
    });

    it('subscribe → receives subscribed ack with correct channelId', async () => {
        const client = await connectClient(server.url);
        try {
            // Drain session frame.
            await client.waitFor((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: 'room-abc' });

            const frame = await client.waitFor(
                (m) => (m as any).type === 'social' && (m as any).action === 'subscribed',
            );

            expect((frame as any).channelId).toBe('room-abc');
            expect(typeof (frame as any).timestamp).toBe('string');
        } finally {
            await client.close();
        }
    });

    it('subscribe then unsubscribe → receives unsubscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            await client.waitFor((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: 'room-xyz' });
            await client.waitFor(
                (m) => (m as any).type === 'social' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'social', action: 'unsubscribe', channelId: 'room-xyz' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'social' && (m as any).action === 'unsubscribed',
            );

            expect((frame as any).channelId).toBe('room-xyz');
        } finally {
            await client.close();
        }
    });

    it('subscribe with missing channelId → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            await client.waitFor((m) => (m as any).type === 'session');

            // No channelId supplied.
            client.send({ service: 'social', action: 'subscribe' });

            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('social');
        } finally {
            await client.close();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            await client.waitFor((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'follow', channelId: 'ch' });

            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).message).toMatch(/unknown social action/i);
        } finally {
            await client.close();
        }
    });

    it('subscribe with empty channelId string → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            await client.waitFor((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: '' });

            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).type).toBe('error');
        } finally {
            await client.close();
        }
    });
});
