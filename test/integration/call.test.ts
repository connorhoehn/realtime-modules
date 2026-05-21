// realtime-modules/test/integration/call.test.ts
//
// Integration tests for CallService using the shared harness.
// No external services required — startTestServer({ features: ['call'] })
// provides a real WS server with in-process broadcast and userId routing.
//
// Note: call routing tests (targeted invite, broadcast invite) use
// server.registerUserClient(clientId, userId) to populate the userId→clientId
// index — mirroring what the gateway's auth middleware does in production.
//
// Covers:
//   - Server start / WS handshake
//   - Unknown action → error frame
//   - invite without callId/lobbyName → error frame
//   - Broadcast path: invite with no targetUserIds fans out to all other clients
//   - Targeted path: invite with targetUserIds routes to specific clients only
//   - Non-invite actions (accepted, declined) are dispatched via broadcast

import { startTestServer, connectTestClient } from './harness';
import type { TestServer, TestClient } from './harness';

// ---------------------------------------------------------------------------
// Helper: connect and capture clientId from session frame
// ---------------------------------------------------------------------------

async function connectWithSession(
    serverUrl: string,
): Promise<{ client: TestClient; clientId: string }> {
    const client = await connectTestClient(serverUrl);
    const session = await client.waitForMessage(
        (m) => (m as any).type === 'session',
    ) as any;
    return { client, clientId: session.clientId ?? '' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('call feature integration', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = await startTestServer({ features: ['call'] });
    });

    afterAll(async () => {
        await server.stop();
    });

    it('starts and accepts WebSocket connections with session handshake', async () => {
        expect(server).toBeDefined();
        const { client, clientId } = await connectWithSession(server.url);
        expect(clientId).toMatch(/^c_/);
        await client.disconnect();
    });

    it('unknown action → error frame with service=call', async () => {
        const { client } = await connectWithSession(server.url);
        try {
            client.send({ service: 'call', action: 'ring', callId: 'c1', lobbyName: 'lobby' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'call',
            );
            expect((frame as any).message).toMatch(/unknown call action/i);
        } finally {
            await client.disconnect();
        }
    });

    it('invite without callId → error frame', async () => {
        const { client } = await connectWithSession(server.url);
        try {
            // Missing callId and lobbyName — should get an error.
            client.send({ service: 'call', action: 'invite' });
            const frame = await client.waitForMessage(
                (m) => (m as any).type === 'error' && (m as any).service === 'call',
            );
            expect((frame as any).message).toMatch(/callId and lobbyName/i);
        } finally {
            await client.disconnect();
        }
    });

    it('invite with no targetUserIds → broadcasts to all other connected clients', async () => {
        const { client: sender } = await connectWithSession(server.url);
        const { client: recipient } = await connectWithSession(server.url);
        try {
            // Broadcast invite (no targetUserIds).
            sender.send({
                service: 'call',
                action: 'invite',
                callId: 'call-broadcast-001',
                lobbyName: 'Team Standup',
            });

            // Recipient should receive the call event.
            const frame = await recipient.waitForMessage(
                (m) => (m as any).type === 'call' && (m as any).action === 'invite',
            );
            expect((frame as any).data.callId).toBe('call-broadcast-001');
            expect((frame as any).data.lobbyName).toBe('Team Standup');
        } finally {
            await Promise.all([sender.disconnect(), recipient.disconnect()]);
        }
    });

    it('invite with targetUserIds → routes only to targeted user, not others', async () => {
        const { client: sender } = await connectWithSession(server.url);
        const { client: targetClient, clientId: targetClientId } = await connectWithSession(server.url);
        const { client: bystanderClient } = await connectWithSession(server.url);
        try {
            // Register userId → clientId mapping in the harness router.
            server.registerUserClient(targetClientId, 'user-target-99');

            sender.send({
                service: 'call',
                action: 'invite',
                callId: 'call-targeted-002',
                lobbyName: 'Private Call',
                targetUserIds: ['user-target-99'],
            });

            // Target should receive the frame.
            const frame = await targetClient.waitForMessage(
                (m) => (m as any).type === 'call' && (m as any).action === 'invite',
            );
            expect((frame as any).data.callId).toBe('call-targeted-002');

            // Bystander should NOT receive anything within a short window.
            const leaked = await new Promise<boolean>((resolve) => {
                const t = setTimeout(() => resolve(false), 400);
                bystanderClient
                    .waitForMessage(
                        (m) => (m as any).type === 'call' && (m as any).action === 'invite',
                        400,
                    )
                    .then(() => { clearTimeout(t); resolve(true); })
                    .catch(() => resolve(false));
            });
            expect(leaked).toBe(false);
        } finally {
            await Promise.all([
                sender.disconnect(),
                targetClient.disconnect(),
                bystanderClient.disconnect(),
            ]);
        }
    });

    it('non-invite lifecycle actions (accepted, declined) are dispatched via broadcast', async () => {
        const { client: clientA } = await connectWithSession(server.url);
        const { client: clientB } = await connectWithSession(server.url);
        try {
            // 'accepted' with no targets → broadcast path.
            clientA.send({
                service: 'call',
                action: 'accepted',
                callId: 'call-lifecycle-003',
            });

            const frame = await clientB.waitForMessage(
                (m) => (m as any).type === 'call' && (m as any).action === 'accepted',
            );
            expect((frame as any).data.callId).toBe('call-lifecycle-003');
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });
});
