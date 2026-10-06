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

function connectPath(p: string): QueuedClient {
    const qc = makeQueuedClient(`ws://127.0.0.1:${port}${p}`);
    openSockets.push(qc.ws);
    return qc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// `path` has no default, and the unset case is the one that surprises: the
// listener calls handleUpgrade on EVERY upgrade the server receives. That
// matters because attachRealtime's whole pitch is attaching to an http.Server
// you already have — one that may already carry a WebSocket endpoint of its
// own. The recipes used to say `/realtime` was the default; it never was.
// An EventEmitter never awaits a listener, so `ws.on('message', async …)`
// started the next frame while the previous one sat in its first await. Two
// frames sent back to back finished in whichever order their awaits resolved.
//
// Every reconnect makes a channel hook send `leave` then `join` back to back.
// If the cheaper leave resolved last, the client ended up un-joined on a
// socket reporting itself connected — the exact silence 0.65.0 was written to
// remove.
describe('createWsHandler — frame ordering', () => {
    /** A service whose per-action delay is dictated by the frame itself. */
    function slowService(log: string[]): WsService {
        return {
            async handleAction(_clientId: string, action: string, data: Record<string, unknown>) {
                log.push(`start:${action}`);
                await new Promise((r) => setTimeout(r, Number(data.ms) || 0));
                log.push(`end:${action}`);
            },
        };
    }

    it('finishes a slow frame before starting the next one', async () => {
        const log: string[] = [];
        handle = createWsHandler({
            server: httpServer,
            services: { probe: slowService(log) },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage(); // session

        // Sent in this order; the first is far slower than the second.
        qc.ws.send(JSON.stringify({ service: 'probe', action: 'leave', ms: 60 }));
        qc.ws.send(JSON.stringify({ service: 'probe', action: 'join', ms: 0 }));

        await new Promise((r) => setTimeout(r, 400));

        expect(log).toEqual(['start:leave', 'end:leave', 'start:join', 'end:join']);
    });

    it('keeps a burst in order', async () => {
        const log: string[] = [];
        handle = createWsHandler({
            server: httpServer,
            services: { probe: slowService(log) },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();

        // Descending delays: without serialisation these finish backwards.
        for (const [action, ms] of [['a', 40], ['b', 25], ['c', 10], ['d', 0]] as const) {
            qc.ws.send(JSON.stringify({ service: 'probe', action, ms }));
        }

        await new Promise((r) => setTimeout(r, 600));

        expect(log.filter((l) => l.startsWith('end:'))).toEqual(['end:a', 'end:b', 'end:c', 'end:d']);
    });

    // The chain must survive a throwing handler, or one bad frame would stall
    // the connection for good.
    it('a frame that throws does not stall the ones behind it', async () => {
        const log: string[] = [];
        const service: WsService = {
            async handleAction(_clientId: string, action: string) {
                if (action === 'boom') throw new Error('nope');
                log.push(action);
            },
        };
        handle = createWsHandler({
            server: httpServer,
            services: { probe: service },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();

        qc.ws.send(JSON.stringify({ service: 'probe', action: 'boom' }));
        qc.ws.send(JSON.stringify({ service: 'probe', action: 'after' }));

        await new Promise((r) => setTimeout(r, 300));

        expect(log).toEqual(['after']);
    });
});

// Under load a presence `set` (authorize, shared store, fan-out per channel)
// took ~0.9 s p50, and every later chat `send` on the same socket waited for
// it: 0.7–2.4 s p50 of a burst DM delivery and ~3 s p95 of a soak were spent
// queued behind presence (aws-agentcore capacity-latency, 2026-10-06).
// Presence frames now keep their own per-connection lane.
describe('createWsHandler — independent service lanes', () => {
    function recorder(name: string, log: string[]): WsService {
        return {
            async handleAction(_clientId: string, action: string, data: Record<string, unknown>) {
                log.push(`start:${name}.${action}`);
                await new Promise((r) => setTimeout(r, Number(data.ms) || 0));
                log.push(`end:${name}.${action}`);
            },
            onClientDisconnect() { log.push(`cleanup:${name}`); },
        };
    }

    it('a slow presence frame does not hold a later chat frame', async () => {
        const log: string[] = [];
        handle = createWsHandler({ server: httpServer, services: { presence: recorder('presence', log), chat: recorder('chat', log) }, pingIntervalMs: 0 });
        const qc = connect(); await qc.open(); await qc.nextMessage();
        qc.ws.send(JSON.stringify({ service: 'presence', action: 'set', ms: 150 }));
        qc.ws.send(JSON.stringify({ service: 'chat', action: 'send', ms: 0 }));
        await new Promise((r) => setTimeout(r, 400));
        expect(log.indexOf('end:chat.send')).toBeLessThan(log.indexOf('end:presence.set'));
    });

    it('keeps order within the presence lane and within the shared lane', async () => {
        const log: string[] = [];
        handle = createWsHandler({ server: httpServer, services: { presence: recorder('presence', log), chat: recorder('chat', log), call: recorder('call', log) }, pingIntervalMs: 0 });
        const qc = connect(); await qc.open(); await qc.nextMessage();
        for (const [service, action, ms] of [['presence', 'subscribe', 60], ['chat', 'join', 50], ['presence', 'set', 0], ['call', 'accepted', 0], ['chat', 'send', 0]] as const) {
            qc.ws.send(JSON.stringify({ service, action, ms }));
        }
        await new Promise((r) => setTimeout(r, 500));
        const ends = log.filter((l) => l.startsWith('end:'));
        expect(ends.filter((l) => l.startsWith('end:presence'))).toEqual(['end:presence.subscribe', 'end:presence.set']);
        // chat and call frames still share one lane, in arrival order.
        expect(ends.filter((l) => !l.startsWith('end:presence'))).toEqual(['end:chat.join', 'end:call.accepted', 'end:chat.send']);
    });

    it('independentServices: [] restores one shared lane', async () => {
        const log: string[] = [];
        handle = createWsHandler({ server: httpServer, services: { presence: recorder('presence', log), chat: recorder('chat', log) }, pingIntervalMs: 0, independentServices: [] });
        const qc = connect(); await qc.open(); await qc.nextMessage();
        qc.ws.send(JSON.stringify({ service: 'presence', action: 'set', ms: 80 }));
        qc.ws.send(JSON.stringify({ service: 'chat', action: 'send', ms: 0 }));
        await new Promise((r) => setTimeout(r, 300));
        expect(log).toEqual(['start:presence.set', 'end:presence.set', 'start:chat.send', 'end:chat.send']);
    });

    it('cleanup still waits for an in-flight presence frame', async () => {
        const log: string[] = [];
        handle = createWsHandler({ server: httpServer, services: { presence: recorder('presence', log), chat: recorder('chat', log) }, pingIntervalMs: 0 });
        const qc = connect(); await qc.open(); await qc.nextMessage();
        qc.ws.send(JSON.stringify({ service: 'presence', action: 'set', ms: 120 }));
        qc.ws.send(JSON.stringify({ service: 'chat', action: 'send', ms: 0 }));
        setTimeout(() => qc.ws.terminate(), 20);
        await new Promise((r) => setTimeout(r, 600));
        const firstCleanup = log.findIndex((l) => l.startsWith('cleanup:'));
        expect(firstCleanup).toBeGreaterThan(log.indexOf('end:presence.set'));
        expect(firstCleanup).toBeGreaterThan(log.indexOf('end:chat.send'));
    });

    it('a throwing presence frame does not stall later presence frames', async () => {
        const log: string[] = [];
        const presence: WsService = {
            async handleAction(_clientId: string, action: string) { if (action === 'boom') throw new Error('nope'); log.push(action); },
        };
        handle = createWsHandler({ server: httpServer, services: { presence }, pingIntervalMs: 0 });
        const qc = connect(); await qc.open(); await qc.nextMessage();
        qc.ws.send(JSON.stringify({ service: 'presence', action: 'boom' }));
        qc.ws.send(JSON.stringify({ service: 'presence', action: 'after' }));
        await new Promise((r) => setTimeout(r, 300));
        expect(log).toEqual(['after']);
    });
});

// A close is another event on the same connection, and it arrived after the
// frames still in flight. Running cleanup first lets a frame complete for a
// client every service has already forgotten — and re-register it.
//
// Presence is where that bites: onClientDisconnect marks the entry offline,
// then the queued presence/set lands and marks it ONLINE again. No further
// close will ever fire for that connection, so it stays in every subscriber's
// roster permanently, and the offline filter cannot catch it because the
// status is online.
describe('createWsHandler — cleanup waits for in-flight frames', () => {
    it('finishes a pending frame before onClientDisconnect', async () => {
        const log: string[] = [];
        const service: WsService = {
            async handleAction(_clientId: string, action: string) {
                log.push(`start:${action}`);
                await new Promise((r) => setTimeout(r, 120));
                log.push(`end:${action}`);
            },
            onClientDisconnect() {
                log.push('cleanup');
            },
        };
        handle = createWsHandler({
            server: httpServer,
            services: { probe: service },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();

        qc.ws.send(JSON.stringify({ service: 'probe', action: 'last-message' }));
        setTimeout(() => qc.ws.terminate(), 20); // drop mid-frame

        await new Promise((r) => setTimeout(r, 600));

        expect(log).toEqual(['start:last-message', 'end:last-message', 'cleanup']);
    });

    it('still cleans up when the pending frame throws', async () => {
        const log: string[] = [];
        const service: WsService = {
            async handleAction() {
                await new Promise((r) => setTimeout(r, 60));
                throw new Error('nope');
            },
            onClientDisconnect() {
                log.push('cleanup');
            },
        };
        handle = createWsHandler({
            server: httpServer,
            services: { probe: service },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();

        qc.ws.send(JSON.stringify({ service: 'probe', action: 'boom' }));
        setTimeout(() => qc.ws.terminate(), 10);

        await new Promise((r) => setTimeout(r, 500));

        expect(log).toEqual(['cleanup']);
    });

    it('cleans up promptly when nothing is in flight', async () => {
        const log: string[] = [];
        handle = createWsHandler({
            server: httpServer,
            services: { probe: { handleAction: () => undefined, onClientDisconnect: () => { log.push('cleanup'); } } },
            pingIntervalMs: 0,
        });

        const qc = connect();
        await qc.open();
        await qc.nextMessage();
        qc.ws.terminate();

        // Well under FRAME_DRAIN_TIMEOUT_MS — an idle queue must not make a
        // closing connection wait out the bound.
        await new Promise((r) => setTimeout(r, 250));
        expect(log).toEqual(['cleanup']);
    });
});

describe('createWsHandler — path filtering', () => {
    it('claims every upgrade when no path is given', async () => {
        handle = createWsHandler({ server: httpServer, services: {}, pingIntervalMs: 0 });

        for (const p of ['/', '/realtime', '/something/else/entirely']) {
            const qc = connectPath(p);
            await qc.open();
            const frame = await qc.nextMessage();
            expect(frame.type).toBe('session');
        }
    });

    // Node runs every 'upgrade' listener — a handler cannot stop another from
    // seeing the request. What it controls is which sockets it CLAIMS by
    // calling handleUpgrade. With a path set it claims only its own, so a
    // co-existing endpoint keeps working.
    it('claims only its own path, leaving another endpoint intact', async () => {
        const theirPath = '/my-own-socket';
        const claimedByThem: string[] = [];
        const otherListener = (req: any, socket: any) => {
            const url = (req.url || '').split('?')[0];
            if (url !== theirPath) return; // not theirs — same discipline
            claimedByThem.push(url);
            socket.destroy();
        };

        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
            path: '/realtime',
        });
        httpServer.on('upgrade', otherListener as any);

        try {
            const mine = connectPath('/realtime');
            await mine.open();
            expect((await mine.nextMessage()).type).toBe('session');
            expect(claimedByThem).toEqual([]);

            // Their endpoint: the handler returns early, so the socket is
            // theirs to answer. It never gets a session frame from us.
            const theirs = connectPath(theirPath);
            let gotSession = false;
            try {
                const msg = await theirs.nextMessage(500);
                if (msg && msg.type === 'session') gotSession = true;
            } catch {
                // expected — we did not claim it
            }
            expect(gotSession).toBe(false);
            expect(claimedByThem).toEqual([theirPath]);
        } finally {
            httpServer.removeListener('upgrade', otherListener as any);
        }
    });

    it('also serves paths nested under the configured one', async () => {
        handle = createWsHandler({
            server: httpServer,
            services: {},
            pingIntervalMs: 0,
            path: '/realtime',
        });

        const qc = connectPath('/realtime/tenant-a');
        await qc.open();
        expect((await qc.nextMessage()).type).toBe('session');
    });
});

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

// Capacity review (aws-agentcore, 2026-10-01, change #10): ws allows 100 MiB
// frames by default, so one client could push the process toward OOM.
describe('createWsHandler — maxPayload', () => {
    let server: http.Server;
    let port: number;
    let handle: WsHandlerHandle | null = null;

    beforeEach(async () => { ({ server, port } = await startHttpServer()); });
    afterEach(async () => {
        if (handle) await handle.dispose();
        handle = null;
        await new Promise<void>((r) => server.close(() => r()));
    });

    const connectAndSend = async (bytes: number) => {
        const seen: string[] = [];
        const svc: WsService = { handleAction: async (_c, action) => { seen.push(action); } };
        handle = createWsHandler({ server, services: { echo: svc }, maxPayload: 1024, pingIntervalMs: 0 });
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.send(JSON.stringify({ service: 'echo', action: 'big', pad: 'x'.repeat(bytes) }));
        ws.send(JSON.stringify({ service: 'echo', action: 'small' }));
        return { ws, seen, closed };
    };

    it('a frame over the limit closes that socket with 1009 and never reaches a service', async () => {
        const { seen, closed } = await connectAndSend(4096);
        expect(await closed).toBe(1009);
        expect(seen).toEqual([]);
    });

    it('frames under the limit are handled as usual', async () => {
        const { ws, seen } = await connectAndSend(100);
        const start = Date.now();
        while (seen.length < 2 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
        expect(seen).toEqual(['big', 'small']);
        ws.close();
    });

    it('defaults to 16 MiB and rejects a nonsense limit', () => {
        handle = createWsHandler({ server, services: {}, pingIntervalMs: 0 });
        expect(handle.wss.options.maxPayload).toBe(16 * 1024 * 1024);
        expect(() => createWsHandler({ server, services: {}, maxPayload: 0 })).toThrow(/maxPayload/);
    });
});
