// realtime-modules/src/server-ws/createWsHandler.ts
//
// Wave 3 — server-side WS handler factory.
//
// Provides the matching server-side counterpart to ./client/useWebSocket:
// a thin wrapper around `ws.Server` that
//   - attaches itself to a host http.Server via the upgrade event,
//   - runs an optional auth callback during the handshake,
//   - issues each connected client an ID + a `{ type: 'session', ... }`
//     handshake frame,
//   - routes inbound frames `{ service, action, ...data }` to the named
//     service's `handleAction(clientId, action, data)`,
//   - tracks connections + drives ping/pong keepalive,
//   - exposes `sendToClient` and `listClients` for ad-hoc use.
//
// Consumers wire it as:
//
//   const handle = createWsHandler({
//     server: httpServer,
//     services: { chat: chatSvc, presence: presSvc, crdt: crdtSvc },
//     auth: async (req) => ({ userId: extractFromCookie(req) }),
//   });
//
// Returns the `ws.Server` instance + a `dispose()` for tear-down. The
// package does NOT consume `ws` as a direct dependency — consumers must
// install `ws` themselves (peerDep style).

import { attachWsHeartbeat, wsSend } from 'distributed-core/transport';
import { DEFAULT_WS_MAX_PAYLOAD, DEFAULT_INDEPENDENT_SERVICES } from './types';
import type {
    InboundRateLimitOptions,
    WsHandlerStats,
    WsAuthContext,
    WsHandlerHandle,
    WsHandlerOptions,
    WsService,
} from './types';

const DEFAULT_PING_INTERVAL_MS = 30_000;

let _idCounter = 0;
function defaultGenerateClientId(): string {
    _idCounter = (_idCounter + 1) >>> 0;
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}_${_idCounter.toString(36)}`;
}

function safeParse(raw: unknown): Record<string, unknown> | null {
    try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * How long a closing connection waits for its own in-flight frames before
 * cleanup runs regardless. Generous: any sane handler settles far inside it,
 * and the only thing it guards against is one that never does.
 */
const FRAME_DRAIN_TIMEOUT_MS = 5_000;

/** {@link InboundRateLimitOptions} defaults (lane R6). */
export const DEFAULT_INBOUND_FRAMES_PER_SECOND = 50;

type RateLimit = { rate: number; burst: number; windowMs: number; onLimited?: InboundRateLimitOptions['onLimited'] };

function resolveRateLimit(option: boolean | InboundRateLimitOptions | undefined): RateLimit | null {
    if (!option) return null;
    const o: InboundRateLimitOptions = option === true ? {} : option;
    const rate = o.framesPerSecond ?? DEFAULT_INBOUND_FRAMES_PER_SECOND;
    const burst = o.burst ?? rate * 2;
    const windowMs = o.windowMs ?? 1000;
    if (!(Number.isFinite(rate) && rate > 0)) throw new Error(`createWsHandler: inboundRateLimit.framesPerSecond must be a positive number (got ${rate})`);
    if (!(Number.isFinite(burst) && burst >= 1)) throw new Error(`createWsHandler: inboundRateLimit.burst must be at least 1 (got ${burst})`);
    if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error(`createWsHandler: inboundRateLimit.windowMs must be positive (got ${windowMs})`);
    return { rate, burst, windowMs, onLimited: o.onLimited };
}

/** A lazily-required event-loop delay histogram; null where perf_hooks lacks it. */
function eventLoopMonitor(): { enable(): void; disable(): void; reset(): void; percentile(p: number): number; max: number; mean: number } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { monitorEventLoopDelay } = require('perf_hooks');
        if (typeof monitorEventLoopDelay !== 'function') return null;
        const h = monitorEventLoopDelay({ resolution: 10 });
        h.enable();
        return h;
    } catch {
        return null;
    }
}

export function createWsHandler(opts: WsHandlerOptions): WsHandlerHandle {
    // Lazy-require ws so consumers without server-side code never load it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WebSocketServer } = require('ws');

    const {
        server,
        services,
        auth,
        onConnect,
        beforeConnect,
        onDisconnect,
        pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
        generateClientId = defaultGenerateClientId,
        path,
        maxPayload = DEFAULT_WS_MAX_PAYLOAD,
        independentServices: independentServiceNames = DEFAULT_INDEPENDENT_SERVICES,
        inboundRateLimit,
    } = opts;
    const independentServices = new Set(independentServiceNames);
    const rateLimit = resolveRateLimit(inboundRateLimit);

    if (!(Number.isFinite(maxPayload) && maxPayload > 0)) {
        throw new Error(`createWsHandler: maxPayload must be a positive number of bytes (got ${maxPayload})`);
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload });

    /** clientId -> { ws, ctx } */
    const clients = new Map<string, { ws: any; ctx: WsAuthContext }>();
    /** ws -> clientId — for lookups in the 'close' handler. */
    const wsToId = new WeakMap<object, string>();
    /** heartbeat cleanup functions keyed by clientId. */
    const cleanupFns = new Map<string, () => void>();
    /** Async disconnect hooks must finish before a host closes shared ports. */
    const closing = new Set<Promise<void>>();
    /** clientId -> inbound frames accepted and not yet finished (lane R6). */
    const queueDepths = new Map<string, number>();
    /** clientId -> the end of the window it is currently over budget in. */
    const limitedUntil = new Map<string, number>();
    const counters = { accepted: 0, dropped: 0, limitNotices: 0, queued: 0, peak: 0 };
    const loop = eventLoopMonitor();

    const denyUpgrade = (socket: any, status: number, reason: string): void => {
        try {
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        } catch {
            // swallow
        }
        try {
            socket.destroy();
        } catch {
            // swallow
        }
    };

    const upgradeListener = async (req: any, socket: any, head: any): Promise<void> => {
        if (path) {
            const reqPath = (req.url || '').split('?')[0];
            if (reqPath !== path && !reqPath.startsWith(path + '/')) {
                // Not for us — let other listeners (or the default) handle.
                return;
            }
        }

        let ctx: WsAuthContext = {};
        if (auth) {
            try {
                ctx = (await auth(req)) || {};
            } catch {
                denyUpgrade(socket, 401, 'Unauthorized');
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws: any) => {
            wss.emit('connection', ws, req, ctx);
        });
    };

    server.on('upgrade', upgradeListener);

    wss.on('connection', async (ws: any, _req: any, ctx: WsAuthContext = {}) => {
        const clientId = generateClientId();
        if (clients.has(clientId)) {
            ws.once('error', () => undefined);
            ws.close(1011, 'Duplicate connection identity');
            return;
        }
        clients.set(clientId, { ws, ctx });
        wsToId.set(ws, clientId);
        // An async registration may outlive a socket error; keep that error
        // from becoming an unhandled EventEmitter event during bootstrap.
        ws.once('error', () => undefined);
        // Clients may subscribe on TCP open, before the session handshake.
        // Retain those frames in arrival order while registration runs, with
        // both a count and aggregate-byte bound. They enter the same service
        // queue only after the authenticated connection is ready.
        const initialFrames: unknown[] = [];
        let initialBytes = 0;
        const bufferInitialFrame = (raw: unknown) => {
            const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.isBuffer(raw) ? raw.length : maxPayload;
            if (initialFrames.length >= 32 || initialBytes + bytes > maxPayload) {
                ws.close(1009, 'Connection initialization queue full'); return;
            }
            initialFrames.push(raw); initialBytes += bytes;
        };
        ws.on('message', bufferInitialFrame);
        const connectedServices: WsService[] = [];
        const rollback = async () => {
            clients.delete(clientId); wsToId.delete(ws);
            ws.off('message', bufferInitialFrame); initialFrames.length = 0;
            for (const service of connectedServices) {
                try { await service.onClientDisconnect?.(clientId); } catch { /* rollback best effort */ }
            }
            try { await onDisconnect?.(clientId); } catch { /* rollback best effort */ }
            ws.close(1011, 'Connection registration failed');
        };

        try {
            await beforeConnect?.(clientId, ctx);
            if (ws.readyState !== 1) throw new Error('Connection closed during registration');
        } catch {
            await rollback();
            return;
        }

        // Fire optional service-level connect hooks (presence-style).
        for (const [name, svc] of Object.entries(services)) {
            if (typeof svc.onClientConnect === 'function') {
                connectedServices.push(svc);
                try {
                    await svc.onClientConnect(clientId);
                } catch (err) {
                    // best-effort — don't break the connection
                    // eslint-disable-next-line no-console
                    console.warn(`[realtime-modules] service '${name}' onClientConnect failed`, err);
                }
            }
            if (ws.readyState !== 1) { await rollback(); return; }
        }

        // User connect hook last so it sees a fully-registered client.
        try {
            onConnect?.(clientId, ctx);
        } catch {
            // swallow
        }

        // Send session handshake — matches gateway frontend useWebSocket
        // expectations (sessionToken/clientId fields).
        wsSend(ws, JSON.stringify({
            type: 'session',
            status: 'connected',
            clientId,
            timestamp: new Date().toISOString(),
        }));

        // Keepalive heartbeat — DC primitive handles pong tracking + zombie detection.
        if (pingIntervalMs > 0) {
            const cleanupHeartbeat = attachWsHeartbeat(ws, pingIntervalMs);
            cleanupFns.set(clientId, cleanupHeartbeat);
        }

        // Frames from ONE connection are handled in the order they arrived.
        //
        // `ws.on('message', async …)` does not do that: an EventEmitter never
        // awaits a listener, so the next frame starts while the previous one
        // is still inside its first await. Two frames sent back to back then
        // finish in whichever order their awaits happen to resolve.
        //
        // That is not theoretical. Every reconnect makes a channel hook send
        // `leave` then `join` back to back, and if the cheaper `leave`
        // resolves last the client ends up un-joined — silently, on a socket
        // that reports itself connected. Two sends in quick succession can be
        // stored in the wrong order for the same reason.
        //
        // A per-connection promise chain is the narrowest fix: this client's
        // frames serialise, other clients stay concurrent. The websocket
        // delivered them in order; honouring that is the service's job.
        //
        // `independentServices` (default presence) get a lane of their own:
        // still ordered among themselves, but a slow presence `set` no longer
        // holds this connection's next chat `send` behind it.
        let frameQueue: Promise<void> = Promise.resolve();
        const lanes = new Map<string, Promise<void>>();

        const handleFrame = async (msg: Record<string, unknown> | null): Promise<void> => {
            if (!msg) {
                wsSend(ws, JSON.stringify({
                    type: 'error',
                    code: 'INVALID_JSON',
                    message: 'Could not parse message as JSON',
                    timestamp: new Date().toISOString(),
                }));
                return;
            }

            const serviceName = typeof msg.service === 'string' ? msg.service : '';
            const action = typeof msg.action === 'string' ? msg.action : '';
            const svc: WsService | undefined = services[serviceName];

            if (!svc) {
                wsSend(ws, JSON.stringify({
                    type: 'error',
                    code: 'SERVICE_NOT_AVAILABLE',
                    message: `Service '${serviceName}' not available`,
                    availableServices: Object.keys(services),
                    timestamp: new Date().toISOString(),
                }));
                return;
            }

            // Strip { service, action } from the data payload —
            // matches gateway behaviour.
            const data: Record<string, unknown> = { ...msg };
            delete data.service;
            delete data.action;

            try {
                await svc.handleAction(clientId, action, data);
            } catch (err) {
                wsSend(ws, JSON.stringify({
                    type: 'error',
                    code: 'SERVICE_ERROR',
                    message: err instanceof Error ? err.message : 'Failed to process message',
                    service: serviceName,
                    action,
                    timestamp: new Date().toISOString(),
                }));
            }
        };

        // Inbound budget (lane R6): a token bucket per connection, checked
        // before the frame is parsed or queued, so a runaway tab costs a
        // counter increment per frame instead of a parse, a queue slot and a
        // service call (one distillation tab measured ~4,600 frames/s).
        let tokens = rateLimit?.burst ?? 0;
        let refilledAt = Date.now();
        let windowEnd = 0;
        let droppedInWindow = 0;
        let droppedTotal = 0;
        const admitFrame = (): boolean => {
            if (!rateLimit) return true;
            const now = Date.now();
            tokens = Math.min(rateLimit.burst, tokens + ((now - refilledAt) / 1000) * rateLimit.rate);
            refilledAt = now;
            if (tokens >= 1) { tokens -= 1; return true; }
            counters.dropped++; droppedTotal++;
            if (now >= windowEnd) {
                // First drop of a new window: one notice, then silence until it ends.
                windowEnd = now + rateLimit.windowMs;
                droppedInWindow = 0;
                limitedUntil.set(clientId, windowEnd);
                counters.limitNotices++;
                wsSend(ws, JSON.stringify({
                    type: 'error',
                    code: 'RATE_LIMITED',
                    message: `Inbound frame budget exceeded (${rateLimit.rate}/s); frames are being dropped`,
                    retryAfterMs: Math.ceil(((1 - tokens) / rateLimit.rate) * 1000),
                    windowMs: rateLimit.windowMs,
                    timestamp: new Date().toISOString(),
                }));
            }
            droppedInWindow++;
            try { rateLimit.onLimited?.(clientId, { droppedInWindow, droppedTotal }); } catch { /* observer only */ }
            return false;
        };

        const settled = () => {
            counters.queued--;
            const left = (queueDepths.get(clientId) ?? 1) - 1;
            if (left > 0) queueDepths.set(clientId, left); else queueDepths.delete(clientId);
        };
        const enqueueFrame = (raw: unknown) => {
            if (!admitFrame()) return;
            counters.accepted++;
            counters.queued++;
            if (counters.queued > counters.peak) counters.peak = counters.queued;
            queueDepths.set(clientId, (queueDepths.get(clientId) ?? 0) + 1);
            const msg = safeParse(raw);
            const lane = msg && typeof msg.service === 'string' && independentServices.has(msg.service) ? msg.service : null;
            // A rejected frame must not poison the chain for the next one.
            if (lane === null) {
                frameQueue = frameQueue.then(() => handleFrame(msg)).catch(() => undefined).finally(settled);
                return;
            }
            lanes.set(lane, (lanes.get(lane) ?? Promise.resolve()).then(() => handleFrame(msg)).catch(() => undefined).finally(settled));
        };
        ws.off('message', bufferInitialFrame);
        ws.on('message', enqueueFrame);
        for (const raw of initialFrames.splice(0)) enqueueFrame(raw);

        const handleClose = async (): Promise<void> => {
            const id = wsToId.get(ws);
            if (!id) return;
            wsToId.delete(ws);

            // Let this client's in-flight frames finish before tearing it
            // down. A close is just another event, and it arrived after those
            // frames — running cleanup first means a frame completes for a
            // client every service has already forgotten, and re-registers it.
            //
            // Presence shows the cost plainly: onClientDisconnect marks the
            // entry offline and schedules eviction, then the queued
            // presence/set lands and re-registers the client as ONLINE. No
            // further close will ever fire for that connection, so it sits in
            // every subscriber's roster forever — and the offline filter
            // added in 0.66.0 cannot help, because the status is online.
            //
            // Bounded, because a handler that never settles must not hold a
            // connection's cleanup open with it. Past the bound we tear down
            // anyway and accept the interleaving.
            await Promise.race([
                Promise.all([frameQueue, ...lanes.values()]).catch(() => undefined),
                new Promise<void>((resolve) => {
                    const t = setTimeout(resolve, FRAME_DRAIN_TIMEOUT_MS);
                    if (typeof t === 'object' && typeof t.unref === 'function') t.unref();
                }),
            ]);

            clients.delete(id);
            limitedUntil.delete(id);
            const cleanup = cleanupFns.get(id);
            if (cleanup) {
                cleanup();
                cleanupFns.delete(id);
            }
            for (const [name, svc] of Object.entries(services)) {
                if (typeof svc.onClientDisconnect === 'function') {
                    try {
                        await svc.onClientDisconnect(id);
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(`[realtime-modules] service '${name}' onClientDisconnect failed`, err);
                    }
                }
            }
            try {
                await onDisconnect?.(id);
            } catch {
                // swallow
            }
        };

        const close = () => {
            const task = handleClose();
            closing.add(task);
            void task.finally(() => closing.delete(task));
        };
        ws.on('close', close);
        ws.on('error', close);
    });

    return {
        wss,
        listClients(): string[] {
            return Array.from(clients.keys());
        },
        sendToClient(clientId: string, frame: Record<string, unknown>): boolean {
            const entry = clients.get(clientId);
            if (!entry || entry.ws.readyState !== 1) return false;
            wsSend(entry.ws, JSON.stringify(frame));
            return true;
        },
        getClientContext(clientId: string) {
            const entry = clients.get(clientId);
            return entry?.ws.readyState === 1 ? entry.ctx : null;
        },
        stats(statsOpts?: { reset?: boolean }): WsHandlerStats {
            const now = Date.now();
            let limitedConnections = 0;
            for (const [id, until] of limitedUntil) {
                if (until > now) limitedConnections++; else limitedUntil.delete(id);
            }
            let maxConnectionQueueDepth = 0;
            for (const depth of queueDepths.values()) if (depth > maxConnectionQueueDepth) maxConnectionQueueDepth = depth;
            const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
            const out: WsHandlerStats = {
                connections: clients.size,
                queueDepth: counters.queued,
                maxConnectionQueueDepth,
                peakQueueDepth: counters.peak,
                inbound: {
                    accepted: counters.accepted,
                    dropped: counters.dropped,
                    limitNotices: counters.limitNotices,
                    limitedConnections,
                },
                eventLoop: loop ? {
                    p50Ms: ms(loop.percentile(50)),
                    p99Ms: ms(loop.percentile(99)),
                    maxMs: ms(loop.max),
                    meanMs: ms(Number.isFinite(loop.mean) ? loop.mean : 0),
                } : null,
            };
            if (statsOpts?.reset) {
                counters.peak = counters.queued;
                loop?.reset();
            }
            return out;
        },
        async dispose(): Promise<void> {
            loop?.disable();
            // Remove our upgrade listener (best-effort across http.Server APIs).
            const removeFn = (server as any).removeListener || (server as any).off;
            if (typeof removeFn === 'function') {
                removeFn.call(server, 'upgrade', upgradeListener);
            }
            for (const cleanup of cleanupFns.values()) {
                cleanup();
            }
            cleanupFns.clear();
            for (const { ws } of clients.values()) {
                try {
                    ws.terminate();
                } catch {
                    // swallow
                }
            }
            clients.clear();
            await new Promise<void>((resolve) => {
                try {
                    wss.close(() => resolve());
                } catch {
                    resolve();
                }
            });
            await Promise.all([...closing]);
        },
    };
}
