// realtime-modules/test/integration/social.test.ts
//
// Integration tests for SocialService using the shared harness.
// No external services required — in-process message router backed by
// startTestServer({ features: ['social'] }).

import { startTestServer, connectTestClient } from './harness';
import type { TestServer } from './harness';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('social feature integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['social'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections', async () => {
        expect(server).toBeDefined();
        const client = await connectTestClient(server.url);
        // Server emits a session frame on connect.
        const frame = await client.waitForMessage((m) => (m as any).type === 'session');
        expect((frame as any).type).toBe('session');
        await client.disconnect();
    });

    it('subscribe → receives subscribed ack with correct channelId', async () => {
        const client = await connectTestClient(server.url);
        try {
            // Drain session frame.
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: 'room-abc' });

            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'social' && (m as any).action === 'subscribed',
            );

            expect((frame as any).channelId).toBe('room-abc');
            expect(typeof (frame as any).timestamp).toBe('string');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe then unsubscribe → receives unsubscribed ack', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: 'room-xyz' });
            await client.waitForMessage(
                (m) => (m as any).type === 'social' && (m as any).action === 'subscribed',
            );

            client.send({ service: 'social', action: 'unsubscribe', channelId: 'room-xyz' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'social' && (m as any).action === 'unsubscribed',
            );

            expect((frame as any).channelId).toBe('room-xyz');
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe with missing channelId → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            // No channelId supplied.
            client.send({ service: 'social', action: 'subscribe' });

            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).type).toBe('error');
            expect((frame as any).service).toBe('social');
        } finally {
            await client.disconnect();
        }
    });

    it('unknown action → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'follow', channelId: 'ch' });

            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).message).toMatch(/unknown social action/i);
        } finally {
            await client.disconnect();
        }
    });

    it('subscribe with empty channelId string → error frame', async () => {
        const client = await connectTestClient(server.url);
        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'social', action: 'subscribe', channelId: '' });

            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'social',
            );

            expect((frame as any).type).toBe('error');
        } finally {
            await client.disconnect();
        }
    });
});
