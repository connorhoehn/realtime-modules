"use strict";
// realtime-modules/src/client/useWebSocket.ts
//
// Wave 3 — useWebSocket hook (v2).
//
// Lifts transport / reconnect / session handling out of the host app so
// consumers no longer need to reimplement the gateway WS protocol.
// Closes the ADOPTION-GUIDE §4 gap: "There is no useWebSocket hook
// exported from ./client" (Wave 3 TODO).
//
// What it does:
//   - Opens a WebSocket to `opts.url` with optional `bearer-token-v1`
//     subprotocol carrying `opts.authToken`.
//   - Tracks `connectionState` (idle | connecting | connected | reconnecting
//     | disconnected) and `lastError`.
//   - **Session-gated connect (EKS finding #9, 2026-06-11):** the gateway
//     silently DROPS inbound frames that arrive before its per-connection
//     session bootstrap completes. So `connectionState` does NOT flip to
//     'connected' on socket open — it stays 'connecting' until the
//     `{ type: 'session', ... }` handshake frame arrives. Frames passed to
//     `send()` while the socket is open but the session is not yet
//     established are queued (bounded, drop-oldest) and flushed in order
//     on session arrival. The same gating applies on every reconnect.
//   - **Plain-server fallback:** servers that never send a session frame
//     (non-gateway `WsService` backends) would otherwise hang in
//     'connecting' forever. If no session frame arrives within
//     `sessionTimeoutMs` (default 3000) of socket open, the hook warns,
//     transitions to 'connected' anyway, and flushes the queue —
//     preserving the old open-means-connected behavior for plain servers.
//   - Captures `sessionToken` + `clientId` from the gateway's
//     `{ type: 'session', ... }` handshake frame.
//   - Reconnects with exponential backoff (capped at `maxReconnectMs`).
//   - Optionally caps reconnect attempts at `maxRetries`; on exhaustion
//     emits `RECONNECT_EXHAUSTED` and transitions to `disconnected`.
//   - Optionally persists session across page reloads via `persist`.
//   - Optionally auto-resubscribes tracked channels on reconnect via
//     `autoResubscribe`.
//   - Guards every socket handler against stale sockets (React StrictMode
//     double-mount safety).
//   - Exposes `send(message)` for arbitrary frames, plus convenience
//     `subscribe(channel)`, `unsubscribe(channel)`, and
//     `publish(channel, frame)` helpers.
//
// Wire protocol (mirrors GatewayProvider expectations):
//   outbound: { service, action, channel?, ...data }
//   inbound : { type, action?, channel?, ... }
//
// Returns a superset of UseWebSocketReturn — so it drops into existing
// hook plumbing (useYjsDoc / useCRDT / etc.) unchanged.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWebSocket = useWebSocket;
const react_1 = require("react");
// -----------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------
const DEFAULT_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const AUTH_SUBPROTOCOL_PREFIX = 'bearer-token-v1';
const DEFAULT_PERSIST_PREFIX = 'ws_';
/** Fallback window for servers that never send a `{type:'session'}` frame. */
const DEFAULT_SESSION_TIMEOUT_MS = 3000;
/** Cap on frames queued between socket open and session establishment. */
const MAX_PRE_SESSION_QUEUE = 100;
/**
 * Resolve a WebSocket constructor. Falls back to `globalThis.WebSocket`
 * but allows tests to inject one via an attached property.
 */
function getWebSocketCtor() {
    const g = globalThis;
    return g.WebSocket ?? null;
}
function persistKeys(cfg) {
    const prefix = cfg.keyPrefix ?? DEFAULT_PERSIST_PREFIX;
    return {
        sessionTokenKey: `${prefix}session_token`,
        clientIdKey: `${prefix}client_id`,
    };
}
/** Safe read — storage access can throw (privacy mode, cross-origin). */
function safeStorageGet(cfg, key) {
    if (!cfg)
        return null;
    try {
        return cfg.storage.getItem(key);
    }
    catch {
        return null;
    }
}
/** Safe write — storage access can throw (quota, privacy mode). */
function safeStorageSet(cfg, key, value) {
    if (!cfg)
        return;
    try {
        cfg.storage.setItem(key, value);
    }
    catch {
        // swallow
    }
}
function safeStorageRemove(cfg, key) {
    if (!cfg)
        return;
    try {
        cfg.storage.removeItem(key);
    }
    catch {
        // swallow
    }
}
function useWebSocket(opts) {
    const { url, authToken, reconnectMs = DEFAULT_RECONNECT_MS, maxReconnectMs = DEFAULT_MAX_RECONNECT_MS, maxRetries = Infinity, defaultChannel = '', persist, autoResubscribe = false, sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS, onMessage, onConnect, onDisconnect, } = opts;
    // Persisted session keys — recomputed if `persist` changes identity.
    const persistKeysRef = (0, react_1.useRef)(persist ? persistKeys(persist) : null);
    // Keep the persist config in a ref so callbacks (disconnect, message
    // handler) can read the latest without re-binding.
    const persistRef = (0, react_1.useRef)(persist);
    (0, react_1.useEffect)(() => {
        persistRef.current = persist;
        persistKeysRef.current = persist ? persistKeys(persist) : null;
    }, [persist]);
    const [connectionState, setConnectionState] = (0, react_1.useState)('idle');
    const [lastError, setLastError] = (0, react_1.useState)(null);
    const [sessionToken, setSessionToken] = (0, react_1.useState)(() => {
        const keys = persistKeysRef.current;
        return keys ? safeStorageGet(persist, keys.sessionTokenKey) : null;
    });
    const [clientId, setClientId] = (0, react_1.useState)(() => {
        const keys = persistKeysRef.current;
        return keys ? safeStorageGet(persist, keys.clientIdKey) : null;
    });
    const [currentChannel, setCurrentChannel] = (0, react_1.useState)(defaultChannel);
    // Stable refs for handlers + retry state — keeps the connect()
    // closure from going stale across reconnects.
    const wsRef = (0, react_1.useRef)(null);
    const reconnectTimerRef = (0, react_1.useRef)(null);
    const reconnectAttemptRef = (0, react_1.useRef)(0);
    const authTokenRef = (0, react_1.useRef)(authToken);
    const channelsRef = (0, react_1.useRef)(new Set());
    const onMessageRef = (0, react_1.useRef)(onMessage);
    const onConnectRef = (0, react_1.useRef)(onConnect);
    const onDisconnectRef = (0, react_1.useRef)(onDisconnect);
    const autoResubscribeRef = (0, react_1.useRef)(autoResubscribe);
    const maxRetriesRef = (0, react_1.useRef)(maxRetries);
    const sessionTimeoutMsRef = (0, react_1.useRef)(sessionTimeoutMs);
    // --- Session gating (EKS finding #9) ----------------------------------
    // The gateway drops inbound frames received before its per-connection
    // session bootstrap completes (it signals readiness with the
    // `{ type: 'session' }` frame). These refs gate `send()` and the
    // 'connected' state transition on session establishment.
    //
    // `sessionEstablishedRef` — true once the current socket has either
    //   received a session frame or hit the `sessionTimeoutMs` fallback.
    //   Reset on every (re)connect attempt.
    // `pendingSendsRef` — serialized frames queued while the socket is OPEN
    //   but the session is not yet established. Flushed in order on
    //   establishment; bounded at MAX_PRE_SESSION_QUEUE (drop-oldest).
    //   Cleared on close/disconnect/new-connect — connected-gated effects in
    //   feature hooks re-issue their subscribes on the next 'connected'
    //   transition, so replaying a dead socket's queue would double-send.
    // `sessionFallbackTimerRef` — pending plain-server fallback timer.
    const sessionEstablishedRef = (0, react_1.useRef)(false);
    const pendingSendsRef = (0, react_1.useRef)([]);
    const sessionFallbackTimerRef = (0, react_1.useRef)(null);
    // Keep callback refs current without re-triggering connect.
    (0, react_1.useEffect)(() => {
        onMessageRef.current = onMessage;
    }, [onMessage]);
    (0, react_1.useEffect)(() => {
        onConnectRef.current = onConnect;
    }, [onConnect]);
    (0, react_1.useEffect)(() => {
        onDisconnectRef.current = onDisconnect;
    }, [onDisconnect]);
    (0, react_1.useEffect)(() => {
        autoResubscribeRef.current = autoResubscribe;
    }, [autoResubscribe]);
    (0, react_1.useEffect)(() => {
        maxRetriesRef.current = maxRetries;
    }, [maxRetries]);
    (0, react_1.useEffect)(() => {
        authTokenRef.current = authToken;
    }, [authToken]);
    (0, react_1.useEffect)(() => {
        sessionTimeoutMsRef.current = sessionTimeoutMs;
    }, [sessionTimeoutMs]);
    // --- Send helpers (stable across renders) -----------------------------
    const send = (0, react_1.useCallback)((message) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== 1 /* OPEN */) {
            // Silent no-op; reconnect logic will catch up.
            return;
        }
        let payload;
        try {
            payload = JSON.stringify(message);
        }
        catch {
            return; // unserializable frame — drop
        }
        // EKS finding #9: the gateway silently drops frames received before its
        // session bootstrap completes. Queue sends made in the open-but-no-
        // session window; establishSession flushes them in order.
        if (!sessionEstablishedRef.current) {
            const queue = pendingSendsRef.current;
            if (queue.length >= MAX_PRE_SESSION_QUEUE) {
                queue.shift();
                // eslint-disable-next-line no-console
                console.warn(`[useWebSocket] pre-session send queue full (${MAX_PRE_SESSION_QUEUE}); dropping oldest frame`);
            }
            queue.push(payload);
            return;
        }
        try {
            ws.send(payload);
        }
        catch {
            // swallow — connection likely closing
        }
    }, []);
    const sendMessage = (0, react_1.useCallback)((msg) => send(msg), [send]);
    const subscribe = (0, react_1.useCallback)((channel) => {
        channelsRef.current.add(channel);
        send({
            service: 'subscribe',
            action: 'subscribe',
            channel,
        });
    }, [send]);
    const unsubscribe = (0, react_1.useCallback)((channel) => {
        channelsRef.current.delete(channel);
        send({
            service: 'subscribe',
            action: 'unsubscribe',
            channel,
        });
    }, [send]);
    const publish = (0, react_1.useCallback)((channel, frame) => {
        send({ ...frame, channel });
    }, [send]);
    const switchChannel = (0, react_1.useCallback)((channel) => {
        setCurrentChannel(channel);
    }, []);
    // --- Connection lifecycle --------------------------------------------
    // `connect` is defined inside an effect so it captures the latest
    // url/token, but exposed via a ref for `reconnect()` / `disconnect()`.
    const connectFnRef = (0, react_1.useRef)(() => { });
    const disconnectFnRef = (0, react_1.useRef)(() => { });
    // Read sessionToken inside the connect closure for query-string reuse.
    const sessionTokenRef = (0, react_1.useRef)(sessionToken);
    (0, react_1.useEffect)(() => {
        sessionTokenRef.current = sessionToken;
    }, [sessionToken]);
    (0, react_1.useEffect)(() => {
        const Ctor = getWebSocketCtor();
        if (!Ctor) {
            setLastError({
                code: 'NO_WEBSOCKET',
                message: 'WebSocket constructor unavailable in this environment',
                timestamp: new Date().toISOString(),
            });
            return;
        }
        const clearReconnectTimer = () => {
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
        };
        const clearSessionFallbackTimer = () => {
            if (sessionFallbackTimerRef.current) {
                clearTimeout(sessionFallbackTimerRef.current);
                sessionFallbackTimerRef.current = null;
            }
        };
        // Session establishment — the ONLY place connectionState flips to
        // 'connected'. Invoked from the `{ type: 'session' }` frame handler
        // (gateway path) or the sessionTimeoutMs fallback (plain-server path).
        // Idempotent per socket; stale-socket guarded.
        const establishSession = (ws) => {
            if (wsRef.current !== ws)
                return; // G4: stale socket
            if (sessionEstablishedRef.current)
                return; // already established
            sessionEstablishedRef.current = true;
            clearSessionFallbackTimer();
            reconnectAttemptRef.current = 0;
            setConnectionState('connected');
            setLastError(null);
            // G5: only auto-resubscribe when caller opts in. Gateway's pull
            // model leaves subscribe lifecycle to feature hooks. Runs here (not
            // onopen) so resubscribes land AFTER the gateway session bootstrap —
            // pre-session frames are silently dropped server-side (EKS #9).
            if (autoResubscribeRef.current) {
                for (const channel of channelsRef.current) {
                    try {
                        ws.send(JSON.stringify({
                            service: 'subscribe',
                            action: 'subscribe',
                            channel,
                        }));
                    }
                    catch {
                        // swallow — close handler will pick it up
                    }
                }
            }
            // Flush frames queued during the open-but-no-session window, in order.
            const queued = pendingSendsRef.current;
            pendingSendsRef.current = [];
            for (const payload of queued) {
                try {
                    ws.send(payload);
                }
                catch {
                    // swallow — close handler will pick it up
                }
            }
            try {
                onConnectRef.current?.();
            }
            catch {
                // user handler errors must not break socket lifecycle
            }
        };
        const scheduleReconnect = () => {
            const attempt = reconnectAttemptRef.current;
            const cap = maxRetriesRef.current;
            // G2: terminal RECONNECT_EXHAUSTED when caller opts into a finite cap.
            if (Number.isFinite(cap) && attempt >= cap) {
                setConnectionState('disconnected');
                setLastError({
                    code: 'RECONNECT_EXHAUSTED',
                    message: `Lost connection to gateway after ${cap} retries`,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            // Exponential backoff: 1000, 2000, 4000, ... capped at max.
            const delay = Math.min(reconnectMs * Math.pow(2, attempt), maxReconnectMs);
            reconnectAttemptRef.current = attempt + 1;
            setConnectionState('reconnecting');
            clearReconnectTimer();
            reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null;
                connect();
            }, delay);
        };
        const connect = () => {
            setConnectionState('connecting');
            // Fresh attempt — session must be re-established per connection
            // (reconnects re-gate exactly like the first connect). Drop any
            // queue left over from a previous socket: feature hooks re-issue
            // their subscribes when connectionState transitions to 'connected'.
            sessionEstablishedRef.current = false;
            pendingSendsRef.current = [];
            clearSessionFallbackTimer();
            let ws;
            try {
                const protocols = authTokenRef.current
                    ? [AUTH_SUBPROTOCOL_PREFIX, authTokenRef.current]
                    : undefined;
                ws = protocols ? new Ctor(url, protocols) : new Ctor(url);
            }
            catch (err) {
                setLastError({
                    code: 'CONSTRUCT_FAILED',
                    message: err instanceof Error ? err.message : String(err),
                    timestamp: new Date().toISOString(),
                });
                scheduleReconnect();
                return;
            }
            wsRef.current = ws;
            ws.onopen = () => {
                // G4: ignore events from stale sockets (React StrictMode double-mount)
                if (wsRef.current !== ws)
                    return;
                // EKS finding #9: do NOT flip to 'connected' here. The gateway
                // drops every inbound frame until its per-connection session
                // bootstrap completes (signaled by the `{ type: 'session' }`
                // frame). connectionState stays 'connecting' until that frame
                // arrives — establishSession() owns the transition. A fallback
                // timer covers plain WS servers that never send a session frame.
                clearSessionFallbackTimer();
                const timeoutMs = sessionTimeoutMsRef.current;
                sessionFallbackTimerRef.current = setTimeout(() => {
                    sessionFallbackTimerRef.current = null;
                    if (wsRef.current !== ws || sessionEstablishedRef.current)
                        return;
                    // eslint-disable-next-line no-console
                    console.warn(`[useWebSocket] no { type: 'session' } frame within ${timeoutMs}ms of open — ` +
                        "assuming a plain (non-gateway) WS server and transitioning to 'connected'. " +
                        'Tune via the sessionTimeoutMs option.');
                    establishSession(ws);
                }, timeoutMs);
            };
            ws.onmessage = (ev) => {
                // G4: ignore events from stale sockets
                if (wsRef.current !== ws)
                    return;
                let parsed;
                try {
                    parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
                }
                catch {
                    return; // ignore unparseable frames
                }
                // Capture session handshake fields.
                if (parsed && parsed.type === 'session') {
                    const raw = parsed;
                    if (typeof raw.sessionToken === 'string') {
                        setSessionToken(raw.sessionToken);
                        sessionTokenRef.current = raw.sessionToken;
                        // G1: persist for page-refresh recovery (opt-in).
                        const keys = persistKeysRef.current;
                        if (keys) {
                            safeStorageSet(persistRef.current, keys.sessionTokenKey, raw.sessionToken);
                        }
                    }
                    if (typeof raw.clientId === 'string') {
                        setClientId(raw.clientId);
                        const keys = persistKeysRef.current;
                        if (keys) {
                            safeStorageSet(persistRef.current, keys.clientIdKey, raw.clientId);
                        }
                    }
                    // EKS finding #9: the session frame is the server's signal that
                    // its per-connection bootstrap is complete and inbound frames
                    // will no longer be dropped. Flip to 'connected' and flush the
                    // pre-session send queue HERE — not in onopen.
                    establishSession(ws);
                }
                // Capture gateway error frames for visibility.
                if (parsed && parsed.type === 'error') {
                    const raw = parsed;
                    setLastError({
                        code: typeof raw.code === 'string' ? raw.code : 'UNKNOWN',
                        message: typeof raw.message === 'string' ? raw.message : 'Gateway error',
                        timestamp: typeof raw.timestamp === 'string'
                            ? raw.timestamp
                            : new Date().toISOString(),
                    });
                }
                try {
                    onMessageRef.current?.(parsed);
                }
                catch {
                    // user handler errors must not break socket lifecycle
                }
            };
            ws.onerror = () => {
                // G4: ignore errors from stale sockets
                if (wsRef.current !== ws)
                    return;
                // The 'error' event predates 'close' and carries no useful
                // detail in the browser. Record a generic error and let
                // onclose drive the reconnect.
                setLastError({
                    code: 'SOCKET_ERROR',
                    message: 'WebSocket error',
                    timestamp: new Date().toISOString(),
                });
            };
            ws.onclose = () => {
                // G4: ignore close events from stale sockets (React StrictMode
                // double-mount). Without this, ws1's late onclose clobbers
                // ws2's 'connected' state. This guard also handles intentional
                // disconnects — disconnect() nulls wsRef before calling close().
                if (wsRef.current !== ws)
                    return;
                wsRef.current = null;
                // Session gating teardown — pre-session frames queued against this
                // socket die with it (feature hooks re-subscribe on the next
                // 'connected' transition).
                clearSessionFallbackTimer();
                sessionEstablishedRef.current = false;
                pendingSendsRef.current = [];
                try {
                    onDisconnectRef.current?.();
                }
                catch {
                    // user handler errors must not break socket lifecycle
                }
                scheduleReconnect();
            };
        };
        const disconnect = () => {
            clearReconnectTimer();
            clearSessionFallbackTimer();
            sessionEstablishedRef.current = false;
            pendingSendsRef.current = [];
            const ws = wsRef.current;
            wsRef.current = null; // null BEFORE close so onclose stale guard returns early
            if (ws) {
                try {
                    ws.close();
                }
                catch {
                    // swallow
                }
            }
            setConnectionState('disconnected');
            // G1: clear persisted session on intentional disconnect.
            const keys = persistKeysRef.current;
            if (keys) {
                safeStorageRemove(persistRef.current, keys.sessionTokenKey);
                safeStorageRemove(persistRef.current, keys.clientIdKey);
            }
        };
        connectFnRef.current = connect;
        disconnectFnRef.current = disconnect;
        connect();
        return () => {
            // Internal teardown only — no session clear. Keeps persisted session
            // intact across token refreshes and React StrictMode double-mounts.
            clearReconnectTimer();
            clearSessionFallbackTimer();
            sessionEstablishedRef.current = false;
            pendingSendsRef.current = [];
            const ws = wsRef.current;
            wsRef.current = null;
            if (ws) {
                try {
                    ws.close();
                }
                catch {
                    // swallow
                }
            }
        };
        // Reconnect when url or auth changes.
    }, [url, authToken, reconnectMs, maxReconnectMs]);
    const disconnect = (0, react_1.useCallback)(() => {
        disconnectFnRef.current();
    }, []);
    const reconnect = (0, react_1.useCallback)(() => {
        // Force a fresh attempt — close existing socket, reset backoff.
        reconnectAttemptRef.current = 0;
        const ws = wsRef.current;
        wsRef.current = null; // null before close so onclose stale guard returns early
        if (ws) {
            try {
                ws.close();
            }
            catch {
                // swallow
            }
        }
        connectFnRef.current();
    }, []);
    return {
        connectionState,
        lastError,
        sessionToken,
        clientId,
        currentChannel,
        switchChannel,
        sendMessage,
        disconnect,
        reconnect,
        send,
        subscribe,
        unsubscribe,
        publish,
    };
}
//# sourceMappingURL=useWebSocket.js.map