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

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  ConnectionState,
  GatewayError,
  GatewayMessage,
  UseWebSocketReturn,
} from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Opt-in session persistence config.
 *
 * Mirrors gateway's `sessionStorage.getItem('ws_session_token'|'ws_client_id')`
 * dance: read on init, write on session-handshake frame, clear on
 * intentional disconnect.
 */
export interface UseWebSocketPersistConfig {
  /** Storage to use (typically `window.sessionStorage`). */
  storage: Storage;
  /** Key prefix; defaults to `ws_` to mirror gateway. */
  keyPrefix?: string;
}

export interface UseWebSocketOptions {
  url: string;
  authToken?: string;
  /** Initial reconnect delay in ms. Default 1000. */
  reconnectMs?: number;
  /** Cap for exponential backoff in ms. Default 30000. */
  maxReconnectMs?: number;
  /**
   * Cap on reconnect attempts. Default `Infinity` (unbounded — preserves
   * v1 behavior). When exceeded, hook transitions to `disconnected` and
   * emits a terminal `RECONNECT_EXHAUSTED` error.
   */
  maxRetries?: number;
  /**
   * Seed value for `currentChannel`. Lets feature hooks (`usePresence`,
   * `useChat`, etc.) observe a non-empty channel on first render.
   * Default `''`.
   */
  defaultChannel?: string;
  /**
   * Opt-in session persistence across page reloads. Reads
   * `sessionToken`/`clientId` from storage on init, writes them on the
   * gateway's session-handshake frame, clears them on intentional
   * `disconnect()`.
   */
  persist?: UseWebSocketPersistConfig;
  /**
   * Auto-resubscribe tracked channels on reconnect. Default `false` —
   * gateway's pull model leaves subscribe lifecycle to feature hooks.
   * Set `true` only when this hook owns the subscribe API.
   */
  autoResubscribe?: boolean;
  onMessage?: (message: GatewayMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * Return shape — superset of UseWebSocketReturn.
 *
 * The contract type adds `subscribe` / `unsubscribe` / `publish` /
 * convenience `send` so consumers don't have to assemble subscribe
 * frames manually.
 */
export interface UseWebSocketHookReturn extends UseWebSocketReturn {
  /** Send an arbitrary message frame. */
  send: (message: Record<string, unknown>) => void;
  /**
   * Subscribe to a channel. Tracked locally so reconnects re-issue
   * the subscribe automatically (when `autoResubscribe: true`).
   * Idempotent.
   */
  subscribe: (channel: string) => void;
  /** Unsubscribe from a channel and stop tracking it. Idempotent. */
  unsubscribe: (channel: string) => void;
  /**
   * Publish a frame onto a channel. Merges `{ channel }` into the
   * payload — caller supplies `service` / `action` / data.
   */
  publish: (channel: string, frame: Record<string, unknown>) => void;
}

// -----------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------

const DEFAULT_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const AUTH_SUBPROTOCOL_PREFIX = 'bearer-token-v1';
const DEFAULT_PERSIST_PREFIX = 'ws_';

type WSCtor = typeof WebSocket;

/**
 * Resolve a WebSocket constructor. Falls back to `globalThis.WebSocket`
 * but allows tests to inject one via an attached property.
 */
function getWebSocketCtor(): WSCtor | null {
  const g = globalThis as unknown as { WebSocket?: WSCtor };
  return g.WebSocket ?? null;
}

function persistKeys(cfg: UseWebSocketPersistConfig): {
  sessionTokenKey: string;
  clientIdKey: string;
} {
  const prefix = cfg.keyPrefix ?? DEFAULT_PERSIST_PREFIX;
  return {
    sessionTokenKey: `${prefix}session_token`,
    clientIdKey: `${prefix}client_id`,
  };
}

/** Safe read — storage access can throw (privacy mode, cross-origin). */
function safeStorageGet(
  cfg: UseWebSocketPersistConfig | undefined,
  key: string,
): string | null {
  if (!cfg) return null;
  try {
    return cfg.storage.getItem(key);
  } catch {
    return null;
  }
}

/** Safe write — storage access can throw (quota, privacy mode). */
function safeStorageSet(
  cfg: UseWebSocketPersistConfig | undefined,
  key: string,
  value: string,
): void {
  if (!cfg) return;
  try {
    cfg.storage.setItem(key, value);
  } catch {
    // swallow
  }
}

function safeStorageRemove(
  cfg: UseWebSocketPersistConfig | undefined,
  key: string,
): void {
  if (!cfg) return;
  try {
    cfg.storage.removeItem(key);
  } catch {
    // swallow
  }
}

export function useWebSocket(opts: UseWebSocketOptions): UseWebSocketHookReturn {
  const {
    url,
    authToken,
    reconnectMs = DEFAULT_RECONNECT_MS,
    maxReconnectMs = DEFAULT_MAX_RECONNECT_MS,
    maxRetries = Infinity,
    defaultChannel = '',
    persist,
    autoResubscribe = false,
    onMessage,
    onConnect,
    onDisconnect,
  } = opts;

  // Persisted session keys — recomputed if `persist` changes identity.
  const persistKeysRef = useRef<ReturnType<typeof persistKeys> | null>(
    persist ? persistKeys(persist) : null,
  );
  // Keep the persist config in a ref so callbacks (disconnect, message
  // handler) can read the latest without re-binding.
  const persistRef = useRef<UseWebSocketPersistConfig | undefined>(persist);
  useEffect(() => {
    persistRef.current = persist;
    persistKeysRef.current = persist ? persistKeys(persist) : null;
  }, [persist]);

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [lastError, setLastError] = useState<GatewayError | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    const keys = persistKeysRef.current;
    return keys ? safeStorageGet(persist, keys.sessionTokenKey) : null;
  });
  const [clientId, setClientId] = useState<string | null>(() => {
    const keys = persistKeysRef.current;
    return keys ? safeStorageGet(persist, keys.clientIdKey) : null;
  });
  const [currentChannel, setCurrentChannel] = useState<string>(defaultChannel);

  // Stable refs for handlers + retry state — keeps the connect()
  // closure from going stale across reconnects.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const authTokenRef = useRef(authToken);
  const channelsRef = useRef<Set<string>>(new Set());
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const autoResubscribeRef = useRef(autoResubscribe);
  const maxRetriesRef = useRef(maxRetries);

  // Keep callback refs current without re-triggering connect.
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    onConnectRef.current = onConnect;
  }, [onConnect]);
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);
  useEffect(() => {
    autoResubscribeRef.current = autoResubscribe;
  }, [autoResubscribe]);
  useEffect(() => {
    maxRetriesRef.current = maxRetries;
  }, [maxRetries]);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  // --- Send helpers (stable across renders) -----------------------------
  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      // Silent no-op; reconnect logic will catch up.
      return;
    }
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // swallow — connection likely closing
    }
  }, []);

  const sendMessage = useCallback(
    (msg: Record<string, unknown>) => send(msg),
    [send],
  );

  const subscribe = useCallback(
    (channel: string) => {
      channelsRef.current.add(channel);
      send({
        service: 'subscribe',
        action: 'subscribe',
        channel,
      } satisfies ClientFramePayload<'client.subscribe.subscribe'>);
    },
    [send],
  );

  const unsubscribe = useCallback(
    (channel: string) => {
      channelsRef.current.delete(channel);
      send({
        service: 'subscribe',
        action: 'unsubscribe',
        channel,
      } satisfies ClientFramePayload<'client.subscribe.unsubscribe'>);
    },
    [send],
  );

  const publish = useCallback(
    (channel: string, frame: Record<string, unknown>) => {
      send({ ...frame, channel });
    },
    [send],
  );

  const switchChannel = useCallback((channel: string) => {
    setCurrentChannel(channel);
  }, []);

  // --- Connection lifecycle --------------------------------------------
  // `connect` is defined inside an effect so it captures the latest
  // url/token, but exposed via a ref for `reconnect()` / `disconnect()`.
  const connectFnRef = useRef<() => void>(() => {});
  const disconnectFnRef = useRef<() => void>(() => {});

  // Read sessionToken inside the connect closure for query-string reuse.
  const sessionTokenRef = useRef<string | null>(sessionToken);
  useEffect(() => {
    sessionTokenRef.current = sessionToken;
  }, [sessionToken]);

  useEffect(() => {
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

      let ws: WebSocket;
      try {
        const protocols = authTokenRef.current
          ? [AUTH_SUBPROTOCOL_PREFIX, authTokenRef.current]
          : undefined;
        ws = protocols ? new Ctor(url, protocols) : new Ctor(url);
      } catch (err) {
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
        if (wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setConnectionState('connected');
        setLastError(null);

        // G5: only auto-resubscribe when caller opts in. Gateway's pull
        // model leaves subscribe lifecycle to feature hooks.
        if (autoResubscribeRef.current) {
          for (const channel of channelsRef.current) {
            try {
              ws.send(JSON.stringify({
                service: 'subscribe',
                action: 'subscribe',
                channel,
              } satisfies ClientFramePayload<'client.subscribe.subscribe'>));
            } catch {
              // swallow — close handler will pick it up
            }
          }
        }

        try {
          onConnectRef.current?.();
        } catch {
          // user handler errors must not break socket lifecycle
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        // G4: ignore events from stale sockets
        if (wsRef.current !== ws) return;

        let parsed: GatewayMessage;
        try {
          parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return; // ignore unparseable frames
        }

        // Capture session handshake fields.
        if (parsed && parsed.type === 'session') {
          const raw = parsed as Record<string, unknown>;
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
        }

        // Capture gateway error frames for visibility.
        if (parsed && parsed.type === 'error') {
          const raw = parsed as Record<string, unknown>;
          setLastError({
            code: typeof raw.code === 'string' ? raw.code : 'UNKNOWN',
            message: typeof raw.message === 'string' ? raw.message : 'Gateway error',
            timestamp:
              typeof raw.timestamp === 'string'
                ? raw.timestamp
                : new Date().toISOString(),
          });
        }

        try {
          onMessageRef.current?.(parsed);
        } catch {
          // user handler errors must not break socket lifecycle
        }
      };

      ws.onerror = () => {
        // G4: ignore errors from stale sockets
        if (wsRef.current !== ws) return;
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
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        try {
          onDisconnectRef.current?.();
        } catch {
          // user handler errors must not break socket lifecycle
        }
        scheduleReconnect();
      };
    };

    const disconnect = () => {
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null; // null BEFORE close so onclose stale guard returns early
      if (ws) {
        try {
          ws.close();
        } catch {
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
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          // swallow
        }
      }
    };
    // Reconnect when url or auth changes.
  }, [url, authToken, reconnectMs, maxReconnectMs]);

  const disconnect = useCallback(() => {
    disconnectFnRef.current();
  }, []);

  const reconnect = useCallback(() => {
    // Force a fresh attempt — close existing socket, reset backoff.
    reconnectAttemptRef.current = 0;
    const ws = wsRef.current;
    wsRef.current = null; // null before close so onclose stale guard returns early
    if (ws) {
      try {
        ws.close();
      } catch {
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
