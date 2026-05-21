// realtime-modules/test/integration/typed-documents.test.ts
//
// Integration tests for DocumentEventsService using the shared harness.
// No external services required — in-process message router backed by
// startTestServer({ features: ['typed-documents'] }).
//
// Note: the WS wire key is 'document-events' (what clients send as
// { service: 'document-events', ... }). The harness handles the mapping
// from the manifest name 'typed-documents' to the correct wire key.
//
// Covers:
//   - Server start / WS handshake
//   - subscribe with documentId → subscribed ack (subscribes to both channels)
//   - subscribe with missing documentId → error frame
//   - subscribe with empty documentId string → error frame
//   - unsubscribe → unsubscribed ack
//   - unknown action → error frame
//   - multiple clients can subscribe to the same document independently

import { startTestServer, connectTestClient } from './harness';
import type { TestServer } from './harness';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('typed-documents feature integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['typed-documents'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections with session handshake', async () => {
        expect(server).toBeDefined();
        const client = await connectTestClient(server.url);
        const session = await client.waitForMessage((m) => (m as any).type === 'session');
        expect((session as any).type).toBe('session');
        expect(typeof (session as any).clientId).toBe('string');
        expect((session as any).clientId).toMatch(/^c_/);
        await client.disconnect();
    });

    it('subscribe with documentId → subscribed ack with correct documentId', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({
                service: 'document-events',
                action: 'subscribe',
                documentId: 'doc-001',
            });

            const frame = await client.waitForMessage(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'subscribed',
            );

            expect((frame as any).documentId).toBe('doc-001');
            expect(typeof (frame as any).timestamp).toBe('string');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe without documentId → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'document-events', action: 'subscribe' });

            const frame = await client.waitForMessage(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('document-events');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe with empty documentId string → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'document-events', action: 'subscribe', documentId: '' });

            const frame = await client.waitForMessage(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).type).toBe('error');
        } finally {
            await client.disconnect();
        }
    });

    it('unsubscribe → unsubscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({
                service: 'document-events',
                action: 'subscribe',
                documentId: 'doc-002',
            });
            await client.waitForMessage(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'subscribed',
            );

            client.send({
                service: 'document-events',
                action: 'unsubscribe',
                documentId: 'doc-002',
            });

            const frame = await client.waitForMessage(
                (m) =>
                    (m as any).type === 'document-events' &&
                    (m as any).action === 'unsubscribed',
            );

            expect((frame as any).documentId).toBe('doc-002');
        } finally {
            await client.disconnect();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({
                service: 'document-events',
                action: 'publish',
                documentId: 'doc-003',
            });

            const frame = await client.waitForMessage(
                (m) =>
                    (m as any).type === 'error' &&
                    (m as any).service === 'document-events',
            );

            expect((frame as any).message).toMatch(/unknown document-events action/i);
        } finally {
            await client.disconnect();
        }
    });

    it('multiple clients can subscribe to the same document independently', async () => {
        const [clientA, clientB] = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);
        try {
            await Promise.all([
                (async () => {
                    await clientA.waitForMessage((m) => (m as any).type === 'session');
                    clientA.send({ service: 'document-events', action: 'subscribe', documentId: 'shared-doc' });
                    return clientA.waitForMessage(
                        (m) =>
                            (m as any).type === 'document-events' &&
                            (m as any).action === 'subscribed' &&
                            (m as any).documentId === 'shared-doc',
                    );
                })(),
                (async () => {
                    await clientB.waitForMessage((m) => (m as any).type === 'session');
                    clientB.send({ service: 'document-events', action: 'subscribe', documentId: 'shared-doc' });
                    return clientB.waitForMessage(
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
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });
});
