// realtime-modules/test/integration/harness.ts
//
// Real WebSocket integration test harness.
//
// Starts a genuine http.Server + ws.WebSocketServer (via createWsHandler),
// wires optional features (chat / presence / cursor / reactions / activity /
// social / call / ingest / pipeline / typed-documents) with their in-memory
// store implementations, and hands back a TestServer + TestClient pair that
// test authors can use without any external services.
//
// Design goals:
//   - Zero external services required (no DDB-local, no Redis).
//   - All 10 features are wired with in-memory stores + a simple
//     in-process MessageRouter stub so both services operate correctly.
//   - Ping/keepalive is disabled (pingIntervalMs=0) so tests don't need
//     to worry about timer interactions.
//   - TestClient.waitForMessage lets tests wait for a specific frame
//     without ordering noise from session/join frames they don't care about.
//   - TestServer.getService<T>(name) provides typed access to a service
//     instance for tests that call methods like emitEvent() directly.
//   - TestServer.registerUserClient(clientId, userId) supports targeted
//     call routing tests without duplicating router logic in each test.

import * as http from 'http';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import PresenceService from '../../src/presence/PresenceService';
import { SocialService } from '../../src/social/SocialService';
import { CallService } from '../../src/call/CallService';
import { IngestService } from '../../src/ingest/IngestService';
import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';
import { DocumentEventsService } from '../../src/typed-documents/DocumentEventsService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureName =
    | 'chat'
    | 'presence'
    | 'cursor'
    | 'reactions'
    | 'activity'
    | 'social'
    | 'call'
    | 'ingest'
    | 'pipeline'
    | 'typed-documents';

export interface TestServer {
    /** ws://127.0.0.1:{port} */
    url: string;
    /** http://127.0.0.1:{port} */
    httpUrl: string;
    /**
     * Returns the instantiated service for the given feature name.
     * Use this to call service methods directly (e.g. emitEvent) from tests.
     * Returns undefined if the feature was not wired.
     */
    getService<T = unknown>(name: string): T | undefined;
    /**
     * Register a clientId → userId mapping for the call feature's targeted
     * routing. Only meaningful when 'call' is in the features list.
     */
    registerUserClient(clientId: string, userId: string): void;
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
// Minimal in-process MessageRouter used by chat + presence + social services.
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
// In-process call router — extends InProcessMessageRouter with broadcastToAll
// and getClientsByUserId for targeted call signaling tests.
// ---------------------------------------------------------------------------

class CallTestMessageRouter extends InProcessMessageRouter {
    /** clientId → userId — populated via registerUserClient() */
    private userIndex = new Map<string, string>();

    register(clientId: string, userId: string): void {
        this.userIndex.set(clientId, userId);
    }

    getClientsByUserId(
        userIds: string[],
        excludeClientId: string,
    ): Array<{ clientId: string; userId: string }> {
        const matches: Array<{ clientId: string; userId: string }> = [];
        for (const [clientId, userId] of this.userIndex.entries()) {
            if (clientId === excludeClientId) continue;
            if (userIds.includes(userId)) {
                matches.push({ clientId, userId });
            }
        }
        return matches;
    }

    /** Fans out to every client tracked by the WsHandlerHandle. */
    async broadcastToAll(message: unknown, excludeClientId: string): Promise<void> {
        const handle = (this as any).handle as WsHandlerHandle | null;
        if (!handle) return;
        const all = handle.listClients();
        for (const clientId of all) {
            if (clientId === excludeClientId) continue;
            handle.sendToClient(clientId, message as Record<string, unknown>);
        }
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
    features: FeatureName[];
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
    const callRouter = new CallTestMessageRouter();

    // All instantiated services, keyed by WS service name (what clients send
    // as { service: '...' }). Note: typed-documents sends 'document-events'.
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

    if (options.features.includes('activity')) {
        // Lazy-require to mirror factory pattern — avoids loading heavy deps
        // unless actually requested.
        const { ActivityService } = await import('../../src/activity/ActivityService');
        const { InMemoryActivityHistoryStore } = await import('../../src/activity/ActivityHistoryStore');
        const actSvc = new ActivityService({
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                sendToChannel: (channel, msg) => router.sendToChannel(channel, msg),
                subscribeToChannel: (clientId, channel) => router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
            },
            logger: noopLogger,
            historyStore: new InMemoryActivityHistoryStore(),
        });
        services['activity'] = actSvc;
    }

    if (options.features.includes('social')) {
        const socialSvc = new SocialService({
            logger: noopLogger,
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                subscribeToChannel: (clientId, channel) =>
                    router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
            },
        });
        services['social'] = socialSvc;
    }

    if (options.features.includes('call')) {
        const callSvc = new CallService({
            messageRouter: callRouter,
            logger: noopLogger,
        });
        services['call'] = callSvc;
    }

    if (options.features.includes('ingest')) {
        const ingestSvc = new IngestService({
            logger: noopLogger,
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                sendToChannel: (channel, msg) => router.sendToChannel(channel, msg),
                subscribeToChannel: (clientId, channel) =>
                    router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
            },
        });
        // WS service key is 'ingest' — matches what clients send.
        services['ingest'] = ingestSvc;
    }

    if (options.features.includes('pipeline')) {
        const pipelineSvc = new PipelineWsRouter({
            logger: noopLogger,
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                sendToChannel: (channel, msg) => router.sendToChannel(channel, msg),
                subscribeToChannel: (clientId, channel) =>
                    router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
            },
        });
        // WS service key is 'pipeline' — matches what clients send:
        // { service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' }
        services['pipeline'] = pipelineSvc;
    }

    if (options.features.includes('typed-documents')) {
        const docSvc = new DocumentEventsService({
            logger: noopLogger,
            messageRouter: {
                sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
                subscribeToChannel: (clientId, channel) =>
                    router.subscribeToChannel(clientId, channel),
                unsubscribeFromChannel: (clientId, channel) =>
                    router.unsubscribeFromChannel(clientId, channel),
            },
        });
        // WS service key MUST be 'document-events' — that is what clients send:
        // { service: 'document-events', action: 'subscribe', documentId: '...' }
        // (The feature manifest name is 'typed-documents'; the wire name differs.)
        services['document-events'] = docSvc;
    }

    const handle = createWsHandler({
        server: httpServer,
        services: services as any,
        pingIntervalMs: 0, // disable keepalive pings for test determinism
    });

    // Wire the shared router to the handle so sendToClient/sendToChannel work.
    router.setHandle(handle);
    // Wire the call router too (it inherits InProcessMessageRouter but needs
    // its own handle reference for broadcastToAll).
    callRouter.setHandle(handle);

    const url = `ws://127.0.0.1:${port}`;
    const httpUrl = `http://127.0.0.1:${port}`;

    return {
        url,
        httpUrl,

        getService<T = unknown>(name: string): T | undefined {
            // Accept both the manifest name and the WS wire key.
            // 'typed-documents' → 'document-events' on the wire.
            const wireKey = name === 'typed-documents' ? 'document-events' : name;
            return services[wireKey] as T | undefined;
        },

        registerUserClient(clientId: string, userId: string): void {
            callRouter.register(clientId, userId);
        },

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
