// realtime-modules/test/integration/harness.ts
//
// Real WebSocket integration test harness.
//
// Starts a genuine http.Server + ws.WebSocketServer (via createWsHandler),
// wires optional features (chat / presence) with their in-memory store
// implementations, and hands back a TestServer + TestClient pair that
// Wave 3 test authors can use without any external services.
//
// Design goals:
//   - Zero external services required (no DDB-local, no Redis).
//   - chat and presence are wired with in-memory stores + a simple
//     in-process MessageRouter stub so both services operate correctly.
//   - Ping/keepalive is disabled (pingIntervalMs=0) so tests don't need
//     to worry about timer interactions.
//   - TestClient.waitForMessage lets tests wait for a specific frame
//     without ordering noise from session/join frames they don't care about.

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import PresenceService from '../../src/presence/PresenceService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestServer {
    /** ws://127.0.0.1:{port} */
    url: string;
    /** http://127.0.0.1:{port} */
    httpUrl: string;
    stop(): Promise<void>;
}

export interface TestClient {
    ws: WebSocket;
    /** Send an object as a JSON frame. */
    send(msg: object): void;
    /**
     * Wait for the next message that satisfies `predicate`.
     * Messages that do not match are buffered and will be re-checked on
     * subsequent waitForMessage calls. Rejects after `timeoutMs` (default 3s).
     */
    waitForMessage(predicate: (msg: object) => boolean, timeoutMs?: number): Promise<object>;
    disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Minimal in-process MessageRouter used by chat + presence services.
//
// The gateway wires Redis pub/sub here; for integration tests we fan out
// directly to the WsHandlerHandle so messages actually reach the client.
// ---------------------------------------------------------------------------

class InProcessMessageRouter {
    /** Set after createWsHandler returns. */
    private handle: WsHandlerHandle | null = null;

    /** clientId -> Set<channel> subscriptions */
    private subs = new Map<string, Set<string>>();

    /** channel -> Set<clientId> reverse index */
    private channelMembers = new Map<string, Set<string>>();

    setHandle(h: WsHandlerHandle): void {
        this.handle = h;
    }

    // PresenceMessageRouter surface
    nodeId = 'test-node';
    redisAvailable = false; // suppress any "redis unavailable" warnings

    sendToClient(clientId: string, message: unknown): void {
        this.handle?.sendToClient(clientId, message as Record<string, unknown>);
    }

    sendToChannel(channel: string, message: unknown, excludeClientId?: string): void {
        const members = this.channelMembers.get(channel);
        if (!members) return;
        for (const clientId of members) {
            if (clientId === excludeClientId) continue;
            this.sendToClient(clientId, message);
        }
    }

    subscribeToChannel(clientId: string, channel: string): void {
        if (!this.subs.has(clientId)) this.subs.set(clientId, new Set());
        this.subs.get(clientId)!.add(channel);

        if (!this.channelMembers.has(channel)) this.channelMembers.set(channel, new Set());
        this.channelMembers.get(channel)!.add(clientId);
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
        this.subs.get(clientId)?.delete(channel);
        this.channelMembers.get(channel)?.delete(clientId);
    }

    getClientData(_clientId: string): null {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Noop logger (suppresses service log noise during tests)
// ---------------------------------------------------------------------------

const noopLogger = {
    debug(): void { /* noop */ },
    info(): void { /* noop */ },
    warn(): void { /* noop */ },
    error(): void { /* noop */ },
};

// ---------------------------------------------------------------------------
// startTestServer
// ---------------------------------------------------------------------------

export async function startTestServer(options: {
    features: ('chat' | 'presence' | 'cursor' | 'reactions')[];
}): Promise<TestServer> {
    const httpServer = http.createServer();

    // Bind to an OS-assigned port on loopback.
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
        throw new Error('integration harness: failed to get bound port');
    }
    const port = addr.port;

    const router = new InProcessMessageRouter();
    const services: Record<string, { handleAction: Function; onClientConnect?: Function; onClientDisconnect?: Function }> = {};

    // ---- Wire requested features -------------------------------------------

    if (options.features.includes('chat')) {
        const chatSvc = new ChatService({
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                sendToChannel: (channel, msg) => router.sendToChannel(channel, msg),
                subscribeToChannel: (clientId, channel) => router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
                redisAvailable: false,
            },
            logger: noopLogger,
            chatStore: new InMemoryChatStore(),
            // Very short cache sweep so tests don't leave timers running long.
            cacheCleanupIntervalMs: 60_000,
        });
        services['chat'] = chatSvc;
    }

    if (options.features.includes('presence')) {
        const presSvc = new PresenceService(
            {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                sendToChannel: (channel, msg, exclude) =>
                    router.sendToChannel(channel, msg, exclude),
                subscribeToChannel: (clientId, channel) =>
                    router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
                nodeId: router.nodeId,
                redisAvailable: false,
            },
            noopLogger,
            {
                // Accelerate internal timers so tests don't run long.
                heartbeatIntervalMs: 60_000,
                cleanupIntervalMs: 60_000,
                disconnectDelayMs: 50,
            },
        );
        services['presence'] = presSvc;
    }

    // cursor / reactions: stubs (no real service extracted yet) — accept all
    // actions silently so clients can send without service errors.
    for (const feat of options.features) {
        if (feat === 'cursor' || feat === 'reactions') {
            if (!services[feat]) {
                services[feat] = {
                    handleAction: async (_clientId: string, _action: string, _data: unknown) => {
                        // no-op stub
                    },
                };
            }
        }
    }

    const handle = createWsHandler({
        server: httpServer,
        services: services as any,
        pingIntervalMs: 0, // disable keepalive pings for test determinism
    });

    // Wire the router to the handle so sendToClient/sendToChannel work.
    router.setHandle(handle);

    const url = `ws://127.0.0.1:${port}`;
    const httpUrl = `http://127.0.0.1:${port}`;

    return {
        url,
        httpUrl,
        async stop(): Promise<void> {
            // Shut down services that have a lifecycle.
            for (const svc of Object.values(services)) {
                if (typeof (svc as any).shutdown === 'function') {
                    try { await (svc as any).shutdown(); } catch { /* swallow */ }
                }
            }

            await handle.dispose();

            // Close the HTTP server; force-terminate any lingering sockets.
            if (typeof (httpServer as any).closeAllConnections === 'function') {
                try { (httpServer as any).closeAllConnections(); } catch { /* swallow */ }
            }
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer.close(() => { clearTimeout(t); resolve(); });
            });
        },
    };
}

// ---------------------------------------------------------------------------
// connectTestClient
// ---------------------------------------------------------------------------

export async function connectTestClient(
    serverUrl: string,
    options?: { channelId?: string; userId?: string; token?: string },
): Promise<TestClient> {
    const url = buildUrl(serverUrl, options);

    const ws = new WebSocket(url);

    // Per-client message buffer + waiters — supports waitForMessage with a
    // predicate so callers can skip noise frames (session, history, etc.)
    // without caring about ordering.
    const buffer: object[] = [];
    const waiters: Array<{
        predicate: (msg: object) => boolean;
        resolve: (msg: object) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    ws.on('message', (raw) => {
        let parsed: object;
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            parsed = { __raw: raw.toString() };
        }

        // Check if any waiter's predicate matches this message.
        const idx = waiters.findIndex((w) => w.predicate(parsed));
        if (idx !== -1) {
            const w = waiters.splice(idx, 1)[0];
            clearTimeout(w.timer);
            w.resolve(parsed);
        } else {
            buffer.push(parsed);
        }
    });

    // Wait for the socket to open.
    await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        // Catch upgrade rejections (e.g. 401).
        ws.once('unexpected-response', (_req, res) => {
            reject(new Error(`WS upgrade rejected: HTTP ${res.statusCode}`));
        });
    });

    return {
        ws,

        send(msg: object): void {
            ws.send(JSON.stringify(msg));
        },

        waitForMessage(predicate, timeoutMs = 3_000): Promise<object> {
            // Check already-buffered messages first.
            const bufferedIdx = buffer.findIndex((m) => predicate(m));
            if (bufferedIdx !== -1) {
                return Promise.resolve(buffer.splice(bufferedIdx, 1)[0]);
            }

            return new Promise<object>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                waiters.push({ predicate, resolve, reject, timer });
            });
        },

        disconnect(): Promise<void> {
            return new Promise<void>((resolve) => {
                if (ws.readyState === WebSocket.CLOSED) {
                    resolve();
                    return;
                }
                ws.once('close', () => resolve());
                ws.close();
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildUrl(
    base: string,
    opts?: { channelId?: string; userId?: string; token?: string },
): string {
    if (!opts) return base;
    const params = new URLSearchParams();
    if (opts.channelId) params.set('channelId', opts.channelId);
    if (opts.userId) params.set('userId', opts.userId);
    if (opts.token) params.set('token', opts.token);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}
