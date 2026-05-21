"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWsHandler = createWsHandler;
const DEFAULT_PING_INTERVAL_MS = 30_000;
let _idCounter = 0;
function defaultGenerateClientId() {
    _idCounter = (_idCounter + 1) >>> 0;
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}_${_idCounter.toString(36)}`;
}
function safeParse(raw) {
    try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
function createWsHandler(opts) {
    // Lazy-require ws so consumers without server-side code never load it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WebSocketServer } = require('ws');
    const { server, services, auth, onConnect, onDisconnect, pingIntervalMs = DEFAULT_PING_INTERVAL_MS, generateClientId = defaultGenerateClientId, path, } = opts;
    const wss = new WebSocketServer({ noServer: true });
    /** clientId -> { ws, ctx } */
    const clients = new Map();
    /** ws -> clientId — for lookups in the 'close' handler. */
    const wsToId = new WeakMap();
    /** active ping timers keyed by clientId. */
    const pingTimers = new Map();
    /** liveness tracking — pongs reset isAlive=true. */
    const aliveFlags = new Map();
    const denyUpgrade = (socket, status, reason) => {
        try {
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        }
        catch {
            // swallow
        }
        try {
            socket.destroy();
        }
        catch {
            // swallow
        }
    };
    const upgradeListener = async (req, socket, head) => {
        if (path) {
            const reqPath = (req.url || '').split('?')[0];
            if (reqPath !== path && !reqPath.startsWith(path + '/')) {
                // Not for us — let other listeners (or the default) handle.
                return;
            }
        }
        let ctx = {};
        if (auth) {
            try {
                ctx = (await auth(req)) || {};
            }
            catch {
                denyUpgrade(socket, 401, 'Unauthorized');
                return;
            }
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, ctx);
        });
    };
    server.on('upgrade', upgradeListener);
    wss.on('connection', async (ws, _req, ctx = {}) => {
        const clientId = generateClientId();
        clients.set(clientId, { ws, ctx });
        wsToId.set(ws, clientId);
        aliveFlags.set(clientId, true);
        // Fire optional service-level connect hooks (presence-style).
        for (const [name, svc] of Object.entries(services)) {
            if (typeof svc.onClientConnect === 'function') {
                try {
                    await svc.onClientConnect(clientId);
                }
                catch (err) {
                    // best-effort — don't break the connection
                    // eslint-disable-next-line no-console
                    console.warn(`[realtime-modules] service '${name}' onClientConnect failed`, err);
                }
            }
        }
        // User connect hook last so it sees a fully-registered client.
        try {
            onConnect?.(clientId, ctx);
        }
        catch {
            // swallow
        }
        // Send session handshake — matches gateway frontend useWebSocket
        // expectations (sessionToken/clientId fields).
        try {
            ws.send(JSON.stringify({
                type: 'session',
                status: 'connected',
                clientId,
                timestamp: new Date().toISOString(),
            }));
        }
        catch {
            // swallow
        }
        // Keepalive ping loop.
        if (pingIntervalMs > 0) {
            const timer = setInterval(() => {
                if (aliveFlags.get(clientId) === false) {
                    // No pong since last ping — terminate.
                    try {
                        ws.terminate();
                    }
                    catch {
                        // swallow
                    }
                    return;
                }
                aliveFlags.set(clientId, false);
                try {
                    ws.ping();
                }
                catch {
                    // swallow
                }
            }, pingIntervalMs);
            pingTimers.set(clientId, timer);
        }
        ws.on('pong', () => {
            aliveFlags.set(clientId, true);
        });
        ws.on('message', async (raw) => {
            const msg = safeParse(raw);
            if (!msg) {
                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        code: 'INVALID_JSON',
                        message: 'Could not parse message as JSON',
                        timestamp: new Date().toISOString(),
                    }));
                }
                catch {
                    // swallow
                }
                return;
            }
            const serviceName = typeof msg.service === 'string' ? msg.service : '';
            const action = typeof msg.action === 'string' ? msg.action : '';
            const svc = services[serviceName];
            if (!svc) {
                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        code: 'SERVICE_NOT_AVAILABLE',
                        message: `Service '${serviceName}' not available`,
                        availableServices: Object.keys(services),
                        timestamp: new Date().toISOString(),
                    }));
                }
                catch {
                    // swallow
                }
                return;
            }
            // Strip { service, action } from the data payload —
            // matches gateway behaviour.
            const data = { ...msg };
            delete data.service;
            delete data.action;
            try {
                await svc.handleAction(clientId, action, data);
            }
            catch (err) {
                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        code: 'SERVICE_ERROR',
                        message: err instanceof Error ? err.message : 'Failed to process message',
                        service: serviceName,
                        action,
                        timestamp: new Date().toISOString(),
                    }));
                }
                catch {
                    // swallow
                }
            }
        });
        const handleClose = async () => {
            const id = wsToId.get(ws);
            if (!id)
                return;
            wsToId.delete(ws);
            clients.delete(id);
            aliveFlags.delete(id);
            const timer = pingTimers.get(id);
            if (timer) {
                clearInterval(timer);
                pingTimers.delete(id);
            }
            for (const [name, svc] of Object.entries(services)) {
                if (typeof svc.onClientDisconnect === 'function') {
                    try {
                        await svc.onClientDisconnect(id);
                    }
                    catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(`[realtime-modules] service '${name}' onClientDisconnect failed`, err);
                    }
                }
            }
            try {
                onDisconnect?.(id);
            }
            catch {
                // swallow
            }
        };
        ws.on('close', handleClose);
        ws.on('error', handleClose);
    });
    return {
        wss,
        listClients() {
            return Array.from(clients.keys());
        },
        sendToClient(clientId, frame) {
            const entry = clients.get(clientId);
            if (!entry)
                return false;
            try {
                entry.ws.send(JSON.stringify(frame));
                return true;
            }
            catch {
                return false;
            }
        },
        async dispose() {
            // Remove our upgrade listener (best-effort across http.Server APIs).
            const removeFn = server.removeListener || server.off;
            if (typeof removeFn === 'function') {
                removeFn.call(server, 'upgrade', upgradeListener);
            }
            for (const timer of pingTimers.values()) {
                clearInterval(timer);
            }
            pingTimers.clear();
            for (const { ws } of clients.values()) {
                try {
                    ws.terminate();
                }
                catch {
                    // swallow
                }
            }
            clients.clear();
            aliveFlags.clear();
            await new Promise((resolve) => {
                try {
                    wss.close(() => resolve());
                }
                catch {
                    resolve();
                }
            });
        },
    };
}
//# sourceMappingURL=createWsHandler.js.map