// realtime-modules/test/integration/pipeline-ws.test.ts
//
// Integration tests for PipelineWsRouter using the real WS harness.
// No external services required — in-process message router stub.
//
// Covers:
//   - Server start / WS handshake
//   - Subscribe to pipeline:all → subscribed ack
//   - Subscribe to pipeline:approvals → subscribed ack
//   - Subscribe to pipeline:run:{runId} → subscribed ack
//   - Subscribe with invalid channel → error frame
//   - Unsubscribe → unsubscribed ack
//   - emitEvent → local subscribers receive pipeline:event frame
//   - Unknown action → error frame

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';

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
// In-process message router for PipelineWsRouter
// ---------------------------------------------------------------------------

class PipelineTestRouter {
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

interface PipelineTestServer {
    url: string;
    pipelineSvc: PipelineWsRouter;
    stop(): Promise<void>;
}

async function startPipelineServer(): Promise<PipelineTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    const router = new PipelineTestRouter();

    const pipelineSvc = new PipelineWsRouter({ logger: noopLogger, messageRouter: router });

    const handle = createWsHandler({
        server: httpServer,
        // Note: manifest name is 'pipeline-ws' but the WS service key is 'pipeline'
        // (the gateway routes { service: 'pipeline', action: 'subscribe' }).
        services: { pipeline: pipelineSvc } as any,
        pingIntervalMs: 0,
    });

    router.setHandle(handle);

    return {
        url: `ws://127.0.0.1:${port}`,
        pipelineSvc,
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

describe('pipeline-ws feature integration', () => {
    let server: PipelineTestServer;

    beforeAll(async () => {
        server = await startPipelineServer();
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

    it('subscribe to pipeline:all → subscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await client.close();
        }
    });

    it('subscribe to pipeline:approvals → subscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:approvals' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('pipeline:approvals');
        } finally {
            await client.close();
        }
    });

    it('subscribe to pipeline:run:{runId} → subscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            const channel = 'pipeline:run:run-uuid-9876';
            client.send({ service: 'pipeline', action: 'subscribe', channel });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe(channel);
        } finally {
            await client.close();
        }
    });

    it('subscribe with invalid channel format → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'not-a-pipeline-channel' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'pipeline',
            );
            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('pipeline');
        } finally {
            await client.close();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            await client.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:all' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'unsubscribed',
            );
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await client.close();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'pipeline', action: 'trigger', runId: 'r1' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'pipeline',
            );
            expect((frame as any).message).toMatch(/unknown pipeline action/i);
        } finally {
            await client.close();
        }
    });

    it('emitEvent → subscribed clients receive pipeline:event frame (local broadcast)', async () => {
        // Spin up a separate server with no messageRouter so emitEvent falls back
        // to _broadcastToLocalSubscribers, testing the in-memory fan-out path.
        const httpServer2 = http.createServer();
        await new Promise<void>((resolve, reject) => {
            httpServer2.on('error', reject);
            httpServer2.listen(0, '127.0.0.1', () => resolve());
        });

        const addr2 = httpServer2.address() as { port: number };

        const localRouter = new PipelineWsRouter({ logger: noopLogger });

        const handle2 = createWsHandler({
            server: httpServer2,
            services: { pipeline: localRouter } as any,
            pingIntervalMs: 0,
        });

        // Patch sendToClient on the local router so it can reach the WS handle.
        (localRouter as any).sendToClient = (clientId: string, msg: unknown) =>
            handle2.sendToClient(clientId, msg as Record<string, unknown>);

        const url2 = `ws://127.0.0.1:${addr2.port}`;
        const subscriber = await connectClient(url2);

        try {
            subscriber.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            await subscriber.waitFor(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );

            await localRouter.emitEvent('pipeline:all', 'pipeline.run.completed', {
                runId: 'run-abc',
                status: 'success',
            });

            const frame = await subscriber.waitFor(
                (m) => (m as any).type === 'pipeline:event',
            );
            expect((frame as any).eventType).toBe('pipeline.run.completed');
            expect((frame as any).payload.runId).toBe('run-abc');
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await subscriber.close();
            await handle2.dispose();
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer2.close(() => { clearTimeout(t); resolve(); });
            });
        }
    });
});
