// realtime-modules/test/integration/harness.test.ts
//
// Smoke test — verifies the integration harness itself.
// Wave 3 agents write feature-specific integration tests using the
// startTestServer / connectTestClient helpers exported from ./harness.

import WebSocket from 'ws';
import { startTestServer, connectTestClient } from './harness';

describe('integration harness', () => {
    it('starts a server and accepts a WebSocket connection', async () => {
        const server = await startTestServer({ features: ['chat', 'presence'] });
        const client = await connectTestClient(server.url);
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
        await client.disconnect();
        await server.stop();
    });

    it('sends a session frame on connect', async () => {
        const server = await startTestServer({ features: ['chat', 'presence'] });
        const client = await connectTestClient(server.url);

        const session = await client.waitForMessage(
            (m) => (m as any).type === 'session',
        );
        expect((session as any).type).toBe('session');
        expect((session as any).status).toBe('connected');
        expect(typeof (session as any).clientId).toBe('string');

        await client.disconnect();
        await server.stop();
    });

    it('routes a chat message and receives an error for unknown channel', async () => {
        const server = await startTestServer({ features: ['chat'] });
        const client = await connectTestClient(server.url);

        // Consume session frame.
        await client.waitForMessage((m) => (m as any).type === 'session');

        // Try to send without joining — ChatService rejects it.
        client.send({ service: 'chat', action: 'send', channel: 'general', message: 'hi' });

        const errFrame = await client.waitForMessage(
            (m) => (m as any).type === 'error' && (m as any).service === 'chat',
        );
        expect((errFrame as any).type).toBe('error');

        await client.disconnect();
        await server.stop();
    });

    it('supports multiple concurrent clients on the same server', async () => {
        const server = await startTestServer({ features: ['chat'] });

        const [c1, c2] = await Promise.all([
            connectTestClient(server.url),
            connectTestClient(server.url),
        ]);

        expect(c1.ws.readyState).toBe(WebSocket.OPEN);
        expect(c2.ws.readyState).toBe(WebSocket.OPEN);

        await c1.disconnect();
        await c2.disconnect();
        await server.stop();
    });

    it('stop() closes the server cleanly', async () => {
        const server = await startTestServer({ features: [] });
        await server.stop();

        // Attempting to connect after stop should fail.
        await expect(
            connectTestClient(server.url),
        ).rejects.toThrow();
    });
});
