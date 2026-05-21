// realtime-modules/test/integration/ingest.test.ts
//
// Integration tests for IngestService using the shared harness.
// No external services required — startTestServer({ features: ['ingest'] })
// provides a real WS server with in-process message routing.
//
// Most tests use startTestServer + connectTestClient from the harness.
// The emitEvent local-broadcast test spins up its own minimal server
// because it deliberately bypasses the message router to test the
// _broadcastToLocalSubscribers fallback path.
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

import { startTestServer, connectTestClient } from './harness';
import { createWsHandler } from '../../src/server-ws/createWsHandler';
import { IngestService } from '../../src/ingest/IngestService';
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

describe('ingest feature integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['ingest'] });
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

    it('subscribe to ingest:progress → subscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('ingest:progress');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe to ingest:source:{id} → subscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:source:datasource-42' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );
            expect((frame as any).channel).toBe('ingest:source:datasource-42');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe with invalid channel format → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'ingest', action: 'subscribe', channel: 'not-a-valid-ingest-channel' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'ingest',
            );
            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('ingest');
        } finally {
            await client.disconnect();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            await client.waitForMessage(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'ingest', action: 'unsubscribe', channel: 'ingest:progress' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'unsubscribed',
            );
            expect((frame as any).channel).toBe('ingest:progress');
        } finally {
            await client.disconnect();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');
            client.send({ service: 'ingest', action: 'publish', channel: 'ingest:progress' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'ingest',
            );
            expect((frame as any).message).toMatch(/unknown ingest action/i);
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

    it('emitEvent → subscribed clients receive ingest:event frame', async () => {
        const httpServer = http.createServer();
        await new Promise<void>((resolve, reject) => {
            httpServer.on('error', reject);
            httpServer.listen(0, '127.0.0.1', () => resolve());
        });

        const addr = httpServer.address() as { port: number };

        // No messageRouter → service uses _broadcastToLocalSubscribers.
        const noRouterSvc = new IngestService({ logger: noopLogger });

        const handle2 = createWsHandler({
            server: httpServer,
            services: { ingest: noRouterSvc } as any,
            pingIntervalMs: 0,
        });

        // Patch sendToClient so the service can reach the WS handle.
        (noRouterSvc as any).sendToClient = (clientId: string, msg: unknown) =>
            handle2.sendToClient(clientId, msg as Record<string, unknown>);

        const testUrl = `ws://127.0.0.1:${addr.port}`;
        const subscriber = await connectTestClient(testUrl);

        try {
            await subscriber.waitForMessage((m) => (m as any).type === 'session');

            // Subscribe so clientChannels tracker has this client.
            subscriber.send({ service: 'ingest', action: 'subscribe', channel: 'ingest:progress' });
            await subscriber.waitForMessage(
                (m) => (m as any).type === 'ingest' && (m as any).action === 'subscribed',
            );

            // Emit an event directly.
            await noRouterSvc.emitEvent('ingest:progress', {
                type: 'progress',
                sourceId: 'src-1',
                percent: 42,
            });

            const frame = await subscriber.waitForMessage(
                (m) => (m as any).type === 'ingest:event',
            );
            expect((frame as any).channel).toBe('ingest:progress');
            expect((frame as any).event.percent).toBe(42);
        } finally {
            await subscriber.disconnect();
            await handle2.dispose();
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer.close(() => { clearTimeout(t); resolve(); });
            });
        }
    });
});
