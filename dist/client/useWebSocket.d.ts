import type { GatewayMessage, UseWebSocketReturn } from './types';
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
    /**
     * How long (ms) to wait after socket open for the server's
     * `{ type: 'session' }` handshake frame before assuming the server is a
     * plain (non-gateway) WS backend that never sends one. When the timer
     * fires, the hook logs a console.warn, transitions to 'connected'
     * anyway, and flushes any queued sends — preserving the legacy
     * open-means-connected behavior for plain servers. Default 3000.
     *
     * Against a real gateway the session frame arrives well within this
     * window, so the fallback never fires.
     */
    sessionTimeoutMs?: number;
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
export declare function useWebSocket(opts: UseWebSocketOptions): UseWebSocketHookReturn;
//# sourceMappingURL=useWebSocket.d.ts.map