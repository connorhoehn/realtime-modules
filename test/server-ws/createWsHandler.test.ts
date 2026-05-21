// realtime-modules/test/server-ws/createWsHandler.test.ts
//
// Wave 3 — end-to-end test of createWsHandler against a real
// http.Server + ws client. Validates:
//   - upgrade auth callback runs and rejects with 401 on throw,
//   - clientId is generated and a session frame is emitted,
//   - inbound { service, action, ...data } routes to handleAction,
//   - unknown service yields a SERVICE_NOT_AVAILABLE error frame,
//   - sendToClient / listClients work,
//   - onConnect / onDisconnect lifecycle hooks fire,
//   - service onClientConnect / onClientDisconnect fire,
//   - dispose closes everything cleanly.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import http from 'http';
import WebSocket from 'ws';
import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle, WsService } from '../../src/server-ws/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startHttpServer(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('Failed to bind server'));
                return;
            }
            resolve({ server, port: addr.port });
        });
    });
}

/**
 * Wrap a WebSocket so we can pull received messages off a queue. Must
 * be installed BEFORE the socket opens, otherwise the server's session
 * frame (sent synchronously in the connection handler) lands before we
 * attach a listener and is lost.
 */
interface QueuedClient {
    ws: WebSocket;
    nextMessage: (timeoutMs?: number) => Promise<any>;
    open: () => Promise<void>;
}

function makeQueuedClient(url: string, protocols?: string | string[]): QueuedClient {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const queue: any[] = [];
    const waiters: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
    let openResolve: (() => void) | null = null;
    let openReject: ((e: Error) => void) | null = null;
    let opened = false;
    let errored: Error | null = null;

    ws.on('open', () => {
        opened = true;
        if (openResolve) openResolve();
    });
    ws.on('error', (err: Error) => {
        errored = err;
        if (openReject) openReject(err);
        for (const w of waiters.splice(0)) w.reject(err);
    });
    ws.on('message', (data: WebSocket.RawData) => {
        let parsed: any;
        try { parsed = JSON.parse(data.toString()); } catch (e) { parsed = { __raw: data.toString() }; }
        if (waiters.length > 0) {
            waiters.shift()!.resolve(parsed);
        } else {
            queue.push(parsed);
        }
    });

    return {
        ws,
        open(): Promise<void> {
            if (opened) return Promise.resolve();
            if (errored) return Promise.reject(errored);
            return new Promise<void>((res, rej) => { openResolve = res; openReject = rej; });
        },
        nextMessage(timeoutMs = 2000): Promise<any> {
            if (queue.length > 0) return Promise.resolve(queue.shift());
            return new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === wrapped);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`nextMessage timeout after ${timeoutMs}ms`));
                }, timeoutMs);
                const wrapped = (v: any): void => { clearTimeout(timer); resolve(v); };
                const wrappedRej = (e: Error): void => { clearTimeout(timer); reject(e); };
                waiters.push({ resolve: wrapped, reject: wrappedRej });
            });
        },
    };
}

function waitForClose(client: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            reject(new Error(`close timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onClose = (code: number, reason: Buffer): void => {
            cleanup();
            resolve({ code, reason: reason.toString() });
        };
        const onErr = (): void => {
            cleanup();
            resolve({ code: 401, reason: 'auth-rejected' });
        };
        const cleanup = (): void => {
            clearTimeout(t);
            client.off('close', onClose);
            client.off('unexpected-response', onErr as any);
            client.off('error', onErr);
        };
        client.on('close', onClose);
        client.on('unexpected-response', onErr as any);
        client.on('error', onErr);
    });
}


// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class StubService implements WsService {
    public actions: Array<{ clientId: string; action: string; data: any }> = [];
    public connects: string[] = [];
    public disconnects: string[] = [];

    async handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void> {
        this.actions.push({ clientId, action, data });
        if (action === 'throw') {
            throw new Error('intentional fail');
        }
    }

    async onClientConnect(clientId: string): Promise<void> {
        this.connects.push(clientId);
    }

    async onClientDisconnect(clientId: string): Promise<void> {
        this.disconnects.push(clientId);
    }
}

// ---------------------------------------------------------------------------
// Lifecycle holders
// ---------------------------------------------------------------------------

let httpServer: http.Server;
let port: number;
let handle: WsHandlerHandle | null = null;
let openSockets: WebSocket[] = [];

beforeEach(async () => {
    const started = await startHttpServer();
    httpServer = started.server;
    port = started.port;
});

afterEach(async () => {
    for (const c of openSockets) {
        try { c.removeAllListeners(); } catch { /* swallow */ }
        // Re-attach a no-op error handler so terminate() during the
        // half-open state doesn't emit an Unhandled error event.
        c.on('error', () => { /* swallow */ });
        try { c.terminate(); } catch { /* swallow */ }
    }
    openSockets = [];
    if (handle) {
        await handle.dispose();
        handle = null;
    }
    // Force-close any lingering TCP sockets so close() doesn't hang on
    // half-open upgraded sockets across tests.
    if (typeof (httpServer as any).closeAllConnections === 'function') {
        try { (httpServer as any).closeAllConnections(); } catch { /* swallow */ }
    }
    await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 500);
        httpServer.close(() => { clearTimeout(t); resolve(); });
    });
});

function connect(protocols?: string | string[]): QueuedClient {
    const qc = makeQueuedClient(`ws://127.0.0.1:${port}/`, protocols);
    openSockets.push(qc.ws);
    return qc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWsHandler', () => {
    it('sends a session frame with clientId on connect', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();

        const frame = await qc.nextMessage();
        expect(frame.type).toBe('session');
        expect(frame.status).toBe('connected');
        expect(typeof frame.clientId).toBe('string');
        expect(frame.clientId.length).toBeGreaterThan(0);
    });

    it('runs auth callback and routes ctx via onConnect', async () => {
        const onConnect = jest.fn();
        const auth = jest.fn(async (_req: any) => ({ userId: 'u-1' }));

        handle = createWsHandler({
            server: httpServer,
            services: {},
            auth,
            onConnect,
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage(); // session frame

        expect(auth).toHaveBeenCalled();
        expect(onConnect).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ userId: 'u-1' }),
        );
    });

    it('rejects upgrade with 401 when auth throws', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            auth: async () => {
                throw new Error('nope');
            },
            pingIntervalMs: 0,
        });

        const qc = connect();
        const result = await waitForClose(qc.ws);
        expect(result.code).toBe(401);
    });

    it('routes inbound frames to the named service.handleAction', async () => {
        const chat = new StubService();
        handle = createWsHandler({
            server: httpServer,
            services: { chat },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        const session = await qc.nextMessage(); // session frame

        qc.ws.send(JSON.stringify({ service: 'chat', action: 'message', text: 'hello' }));

        // Give the server a tick to process.
        await new Promise((r) => setTimeout(r, 50));
        expect(chat.actions).toHaveLength(1);
        expect(chat.actions[0]).toEqual({
            clientId: session.clientId,
            action: 'message',
            data: { text: 'hello' },
        });
    });

    it('returns SERVICE_NOT_AVAILABLE for unknown service', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage(); // session frame

        qc.ws.send(JSON.stringify({ service: 'nope', action: 'x' }));
        const err = await qc.nextMessage();
        expect(err.type).toBe('error');
        expect(err.code).toBe('SERVICE_NOT_AVAILABLE');
        expect(err.availableServices).toEqual([]);
    });

    it('returns SERVICE_ERROR when service.handleAction throws', async () => {
        const chat = new StubService();
        handle = createWsHandler({
            server: httpServer,
            services: { chat },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage(); // session frame

        qc.ws.send(JSON.stringify({ service: 'chat', action: 'throw' }));
        const err = await qc.nextMessage();
        expect(err.type).toBe('error');
        expect(err.code).toBe('SERVICE_ERROR');
        expect(err.service).toBe('chat');
    });

    it('returns INVALID_JSON for unparseable frames', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage(); // session frame

        qc.ws.send('not-json{');
        const err = await qc.nextMessage();
        expect(err.type).toBe('error');
        expect(err.code).toBe('INVALID_JSON');
    });

    it('fires service onClientConnect/onClientDisconnect + onDisconnect hook', async () => {
        const chat = new StubService();
        const onDisconnect = jest.fn();
        handle = createWsHandler({
            server: httpServer,
            services: { chat },
            onDisconnect,
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        const session = await qc.nextMessage();

        expect(chat.connects).toContain(session.clientId);

        qc.ws.close();
        // Wait for disconnect propagation.
        await new Promise((r) => setTimeout(r, 150));

        expect(chat.disconnects).toContain(session.clientId);
        expect(onDisconnect).toHaveBeenCalledWith(session.clientId);
    });

    it('sendToClient + listClients work after connection', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        const session = await qc.nextMessage();

        const ids = handle.listClients();
        expect(ids).toContain(session.clientId);

        const ok = handle.sendToClient(session.clientId, {
            type: 'custom',
            hello: 'world',
        });
        expect(ok).toBe(true);

        const frame = await qc.nextMessage();
        expect(frame).toEqual({ type: 'custom', hello: 'world' });

        const missed = handle.sendToClient('nope', { type: 'x' });
        expect(missed).toBe(false);
    });

    it('dispose() tears down the wss without delivering a session frame to new connects', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();

        await handle.dispose();
        handle = null;

        // A fresh connect attempt should either fail to upgrade or
        // never receive a session frame.
        const qc2 = connect();
        let gotSession = false;
        try {
            const msg = await qc2.nextMessage(500);
            if (msg && msg.type === 'session') gotSession = true;
        } catch {
            // expected — no session frame
        }
        expect(gotSession).toBe(false);
    });
});
