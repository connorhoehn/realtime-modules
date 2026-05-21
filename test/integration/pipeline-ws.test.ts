// realtime-modules/test/integration/pipeline-ws.test.ts
//
// Integration tests for PipelineWsRouter using the shared harness.
// No external services required — startTestServer({ features: ['pipeline'] })
// provides a real WS server with in-process message routing.
//
// Most tests use startTestServer + connectTestClient from the harness.
// The emitEvent local-broadcast test spins up its own minimal server
// because it deliberately bypasses the message router to test the
// _broadcastToLocalSubscribers fallback path.
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

import { startTestServer, connectTestClient } from './harness';
import { createWsHandler } from '../../src/server-ws/createWsHandler';
import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';
import type { TestServer } from './harness';

// ---------------------------------------------------------------------------
// Noop logger (for the inline emitEvent test only)
// ---------------------------------------------------------------------------

const noopLogger = {
    debug(): void { /* noop */ },
    info(): void { /* noop */ },
    warn(): void { /* noop */ },
    error(): void { /* noop */ },
};

// ---------------------------------------------------------------------------
// Tests using the shared harness
// ---------------------------------------------------------------------------

describe('pipeline-ws feature integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['pipeline'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections with session handshake', async () => {
        expect(server).toBeDefined();
        const client = await connectTestClient(server.url);
        const session = await client.waitForMessage((m) => (m as any).type === 'session');
        expect((session as any).clientId).toMatch(/^c_/);
        await client.disconnect();
    });

    it('subscribe to pipeline:all → subscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe to pipeline:approvals → subscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:approvals' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('pipeline:approvals');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe to pipeline:run:{runId} → subscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            const channel = 'pipeline:run:run-uuid-9876';
            client.send({ service: 'pipeline', action: 'subscribe', channel });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe(channel);
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe with invalid channel format → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'not-a-pipeline-channel' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'pipeline',
            );
            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('pipeline');
        } finally {
            await client.disconnect();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            await client.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:all' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'unsubscribed',
            );
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await client.disconnect();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'pipeline', action: 'trigger', runId: 'r1' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'pipeline',
            );
            expect((frame as any).message).toMatch(/unknown pipeline action/i);
        } finally {
            await client.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // emitEvent local-broadcast test
    //
    // Spins up a standalone minimal server with no messageRouter so
    // emitEvent falls back to _broadcastToLocalSubscribers — verifies
    // the in-memory fan-out path. Uses a local inline harness because
    // the test must patch sendToClient directly on the service instance.
    // -----------------------------------------------------------------------

    it('emitEvent → subscribed clients receive pipeline:event frame (local broadcast)', async () => {
        const httpServer2 = http.createServer();
        await new Promise<void>((resolve, reject) => {
            httpServer2.on('error', reject);
            httpServer2.listen(0, '127.0.0.1', () => resolve());
        });

        const addr2 = httpServer2.address() as { port: number };

        // No messageRouter → router uses _broadcastToLocalSubscribers.
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
        const subscriber = await connectTestClient(url2);

        try {
            await subscriber.waitForMessage((m) => (m as any).type === 'session');

            subscriber.send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
            await subscriber.waitForMessage(
                (m) => (m as any).type === 'pipeline' && (m as any).action === 'subscribed',
            );

            await localRouter.emitEvent('pipeline:all', 'pipeline.run.completed', {
                runId: 'run-abc',
                status: 'success',
            });

            const frame = await subscriber.waitForMessage(
                (m) => (m as any).type === 'pipeline:event',
            );
            expect((frame as any).eventType).toBe('pipeline.run.completed');
            expect((frame as any).payload.runId).toBe('run-abc');
            expect((frame as any).channel).toBe('pipeline:all');
        } finally {
            await subscriber.disconnect();
            await handle2.dispose();
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer2.close(() => { clearTimeout(t); resolve(); });
            });
        }
    });
});
