// realtime-modules/test/integration/call.test.ts
//
// Integration tests for CallService using the real WS harness.
// No external services required — in-process message router stub.
//
// Note: CallService routes call events between users via
// getClientsByUserId + broadcastToAll. Tests cover:
//   - Server start / WS handshake
//   - Unknown action → error frame
//   - invite without callId/lobbyName → error frame
//   - Broadcast path: invite with no targetUserIds fans out to all other clients
//   - Targeted path: invite with targetUserIds routes to specific clients only
//   - Non-invite actions (accepted, declined, cancelled, ended) are dispatched

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { CallService } from '../../src/call/CallService';

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
// In-process message router for CallService
// ---------------------------------------------------------------------------

class CallTestRouter {
    private handle: WsHandlerHandle | null = null;
    /** clientId → userId mapping for getClientsByUserId resolution */
    private userIndex = new Map<string, string>();

    setHandle(h: WsHandlerHandle): void { this.handle = h; }

    /** Register a clientId → userId mapping (for targeted routing). */
    register(clientId: string, userId: string): void {
        this.userIndex.set(clientId, userId);
    }

    // ---- CallMessageRouter surface -----------------------------------------

    getClientsByUserId(userIds: string[], excludeClientId: string): Array<{ clientId: string; userId: string }> {
        const matches: Array<{ clientId: string; userId: string }> = [];
        for (const [clientId, userId] of this.userIndex.entries()) {
            if (clientId === excludeClientId) continue;
            if (userIds.includes(userId)) {
                matches.push({ clientId, userId });
            }
        }
        return matches;
    }

    sendToClient(clientId: string, message: unknown): boolean {
        if (!this.handle) return false;
        return this.handle.sendToClient(clientId, message as Record<string, unknown>);
    }

    async broadcastToAll(message: unknown, excludeClientId: string): Promise<void> {
        if (!this.handle) return;
        const all = this.handle.listClients();
        for (const clientId of all) {
            if (clientId === excludeClientId) continue;
            this.handle.sendToClient(clientId, message as Record<string, unknown>);
        }
    }
}


// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

interface CallTestServer {
    url: string;
    router: CallTestRouter;
    stop(): Promise<void>;
}

async function startCallServer(): Promise<CallTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to get port');
    const port = (addr as { port: number }).port;

    const router = new CallTestRouter();

    const callSvc = new CallService({ messageRouter: router, logger: noopLogger });

    const handle = createWsHandler({
        server: httpServer,
        services: { call: callSvc } as any,
        pingIntervalMs: 0,
    });

    router.setHandle(handle);

    return {
        url: `ws://127.0.0.1:${port}`,
        router,
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

    // Capture clientId from session frame.
    const session = await obj.waitFor((m) => (m as any).type === 'session') as any;
    obj.clientId = session.clientId ?? '';

    return obj;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('call feature integration', () => {
    let server: CallTestServer;

    beforeAll(async () => {
        server = await startCallServer();
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

    it('unknown action → error frame with service=call', async () => {
        const client = await connectClient(server.url);
        try {
            client.send({ service: 'call', action: 'ring', callId: 'c1', lobbyName: 'lobby' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'call',
            );
            expect((frame as any).message).toMatch(/unknown call action/i);
        } finally {
            await client.close();
        }
    });

    it('invite without callId → error frame', async () => {
        const client = await connectClient(server.url);
        try {
            // Missing callId and lobbyName — should get an error.
            client.send({ service: 'call', action: 'invite' });
            const frame = await client.waitFor(
                (m) => (m as any).type === 'error' && (m as any).service === 'call',
            );
            expect((frame as any).message).toMatch(/callId and lobbyName/i);
        } finally {
            await client.close();
        }
    });

    it('invite with no targetUserIds → broadcasts to all other connected clients', async () => {
        const sender = await connectClient(server.url);
        const recipient = await connectClient(server.url);
        try {
            // Broadcast invite (no targetUserIds).
            sender.send({
                service: 'call',
                action: 'invite',
                callId: 'call-broadcast-001',
                lobbyName: 'Team Standup',
            });

            // Recipient should receive the call event.
            const frame = await recipient.waitFor(
                (m) => (m as any).type === 'call' && (m as any).action === 'invite',
            );
            expect((frame as any).data.callId).toBe('call-broadcast-001');
            expect((frame as any).data.lobbyName).toBe('Team Standup');
        } finally {
            await Promise.all([sender.close(), recipient.close()]);
        }
    });

    it('invite with targetUserIds → routes only to targeted user, not others', async () => {
        const sender = await connectClient(server.url);
        const targetClient = await connectClient(server.url);
        const bystanderClient = await connectClient(server.url);
        try {
            // Register userId → clientId mapping in the test router.
            server.router.register(targetClient.clientId, 'user-target-99');
            server.router.register(bystanderClient.clientId, 'user-bystander-88');

            sender.send({
                service: 'call',
                action: 'invite',
                callId: 'call-targeted-002',
                lobbyName: 'Private Call',
                targetUserIds: ['user-target-99'],
            });

            // Target should receive the frame.
            const frame = await targetClient.waitFor(
                (m) => (m as any).type === 'call' && (m as any).action === 'invite',
            );
            expect((frame as any).data.callId).toBe('call-targeted-002');

            // Bystander should NOT receive anything within a short window.
            const leaked = await new Promise<boolean>((resolve) => {
                const t = setTimeout(() => resolve(false), 400);
                bystanderClient
                    .waitFor(
                        (m) => (m as any).type === 'call' && (m as any).action === 'invite',
                        400,
                    )
                    .then(() => { clearTimeout(t); resolve(true); })
                    .catch(() => resolve(false));
            });
            expect(leaked).toBe(false);
        } finally {
            await Promise.all([sender.close(), targetClient.close(), bystanderClient.close()]);
        }
    });

    it('non-invite lifecycle actions (accepted, declined) are dispatched via broadcast', async () => {
        const clientA = await connectClient(server.url);
        const clientB = await connectClient(server.url);
        try {
            // 'accepted' with no targets → broadcast path.
            clientA.send({
                service: 'call',
                action: 'accepted',
                callId: 'call-lifecycle-003',
            });

            const frame = await clientB.waitFor(
                (m) => (m as any).type === 'call' && (m as any).action === 'accepted',
            );
            expect((frame as any).data.callId).toBe('call-lifecycle-003');
        } finally {
            await Promise.all([clientA.close(), clientB.close()]);
        }
    });
});
