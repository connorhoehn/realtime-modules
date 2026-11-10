import type { IncomingMessage } from 'http';
/**
 * Minimal service shape required by createWsHandler.
 *
 * Any class that implements `handleAction(clientId, action, data)`
 * fulfills this — chat / presence / reactions / crdt already do.
 *
 * Optional lifecycle hooks `onClientConnect` / `onClientDisconnect`
 * are called when set so services can track presence-style state
 * tied to the underlying connection.
 */
export interface WsService {
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void> | void;
    onClientConnect?(clientId: string): Promise<void> | void;
    onClientDisconnect?(clientId: string): Promise<void> | void;
}
/**
 * Auth callback. Resolves a userId (or anything else) from the upgrade
 * request — token in Sec-WebSocket-Protocol header, cookie, query
 * string. Throwing or rejecting causes the upgrade to be rejected
 * with 401.
 */
export type WsAuthFn = (req: IncomingMessage) => Promise<WsAuthContext> | WsAuthContext;
export interface WsAuthContext {
    userId?: string;
    [key: string]: unknown;
}
/**
 * The shape of an http.Server / https.Server we touch — kept narrow so
 * consumers don't need @types/node at type-check time.
 */
export interface WsHttpServer {
    on(event: 'upgrade', listener: (req: any, socket: any, head: any) => void): this;
    removeListener?(event: string, listener: (...args: any[]) => void): this;
    off?(event: string, listener: (...args: any[]) => void): this;
}
export interface WsHandlerOptions {
    /** http.Server (or https.Server) to attach the upgrade listener to. */
    server: WsHttpServer;
    /**
     * Map of service-name → service instance. Inbound frames'
     * `service` field selects the target; the frame's `action`
     * + remaining fields are routed to `service.handleAction`.
     */
    services: Record<string, WsService>;
    /**
     * Auth callback. Runs during the HTTP upgrade. If it throws or rejects,
     * the upgrade is denied with 401. 0.147.0: required — the handler throws
     * at construction without it unless `insecureAllowAll` is true — and the
     * context it returns must carry a numeric `exp` (seconds since the
     * epoch): a context without one is treated as expired (401).
     */
    auth?: WsAuthFn;
    /**
     * 0.147.0: the browser origins allowed to open a socket, compared exactly
     * against the upgrade's `Origin` header (`https://app.example.com`, no
     * trailing slash). An upgrade whose `Origin` is not listed is refused
     * with 403. Missing or empty: every request carrying an `Origin` header
     * is refused (non-browser clients send none and are not affected),
     * unless `insecureAllowAll` is true. A host whose rule depends on the
     * request (same host as the upgrade, behind a proxy) passes a predicate
     * `(origin, req) => boolean` instead; a throw refuses.
     */
    allowedOrigins?: readonly string[] | ((origin: string, req: IncomingMessage) => boolean);
    /**
     * 0.147.0: local development only. Start without `auth`, accept any
     * browser origin when `allowedOrigins` is not given, and accept a context
     * without `exp` (never timed out). Logs one warning; throws when
     * NODE_ENV=production. `attachRealtime` passes it to its local router
     * and to every built-in feature too.
     */
    insecureAllowAll?: boolean;
    /** Mandatory registration before service hooks/session readiness.
     * A rejection closes the connection without admitting client actions. */
    beforeConnect?: (clientId: string, ctx: WsAuthContext) => void | Promise<void>;
    /**
     * Fired after a client is fully connected. Since 0.143.0 the `session`
     * frame has already been sent when this runs, so frames it sends reach
     * the client after the handshake (before: they arrived ahead of it).
     */
    onConnect?: (clientId: string, ctx: WsAuthContext) => void;
    /** Fired after a client disconnects (for any reason). */
    onDisconnect?: (clientId: string) => void;
    /**
     * Ping interval in ms. Defaults to 30_000. Set to 0 to disable
     * server-side keepalive pings.
     */
    pingIntervalMs?: number;
    /**
     * Optional generator for client IDs. Defaults to a random base36
     * string + monotonic counter (no dependence on `crypto`).
     */
    generateClientId?: () => string;
    /**
     * Path filter. When set, only upgrade requests whose path equals this or
     * sits under it are handled; everything else returns early and is left
     * for another listener.
     *
     * There is NO default, and the unset behaviour is the sharp edge: with no
     * `path` this listener calls `handleUpgrade` on every WebSocket upgrade
     * the server receives. `attachRealtime` is sold as attaching to an
     * http.Server you already have, so the server that reaches it may already
     * carry a WS endpoint of its own — and that endpoint gets claimed.
     *
     * Pass a path whenever the server is not exclusively realtime's. The
     * recipes use '/realtime'.
     */
    path?: string;
    /**
     * 0.143.0: with `path` set, answer an upgrade on any OTHER path with
     * `404 Not Found` and destroy the socket, instead of returning and leaving
     * it for another listener (with none, it hangs until the client gives
     * up). Default false. Only for a server whose sole WebSocket endpoint is
     * this one: a second upgrade listener (another `attachRealtime`, a dev
     * server's HMR socket) would have its requests refused. Ignored without
     * `path`, which already claims every upgrade.
     */
    rejectUnmatched?: boolean;
    /**
     * Largest inbound frame a client may send, in bytes. A bigger one closes
     * that socket (code 1009) before it is buffered, so one client cannot push
     * the process toward OOM. Default {@link DEFAULT_WS_MAX_PAYLOAD} (1 MiB
     * since 0.146.0; 16 MiB before); `ws` itself would allow 100 MiB. Call
     * signalling, chat and presence frames are a few KB. A host that sends
     * large CRDT snapshots or canvas seeds over the socket raises it.
     */
    maxPayload?: number;
    /**
     * Services whose frames from one connection serialise on their own lane
     * instead of the connection's shared one. Order is still kept WITHIN each
     * lane, and a close still waits for every lane. Default
     * {@link DEFAULT_INDEPENDENT_SERVICES} (`['presence']`): presence frames
     * have no ordering dependency on chat or call frames, and under load a
     * slow presence `set` (authorize + shared store + fan-out per channel)
     * held every later chat `send` on the same socket behind it (measured
     * 0.7–2.4 s p50 of a burst DM delivery). Pass `[]` for one shared lane.
     */
    independentServices?: readonly string[];
    /**
     * A per-connection inbound frame budget (0.119, lane R6; ON by default
     * since 0.146.0). A token bucket refilled at `framesPerSecond` (default
     * 50) holding at most `burst` frames (default twice the rate). A frame
     * that arrives with the bucket empty is dropped before it is parsed or
     * queued, and the client gets ONE `{ type: 'error', code: 'RATE_LIMITED',
     * dropped, retryAfterMs }` frame per `windowMs` (default 1000) however
     * many were dropped in it. The socket stays open. Unset or `true` takes
     * every default; `false` switches the budget off. Counts appear in
     * `stats().inbound`.
     */
    inboundRateLimit?: boolean | InboundRateLimitOptions;
    /**
     * 0.146.0: the most inbound frames one connection may have accepted and
     * not yet finished. Past it the client is sent `{ type: 'error', code:
     * 'QUEUE_FULL' }` and the socket is closed with 1008, so a client that
     * outpaces its handlers cannot grow the process's memory without bound.
     * Default {@link DEFAULT_WS_MAX_QUEUE_DEPTH} (256). `Infinity` disables.
     */
    maxQueueDepth?: number;
    /**
     * 0.146.0: close a connection when its token expires. The handler reads
     * `exp` (seconds since the epoch, the JWT claim) from the context `auth`
     * returned; at `exp` plus this grace it sends `{ type: 'error', code:
     * 'TOKEN_EXPIRED' }` and closes the socket with 4001, and an upgrade whose
     * token is already past it is refused with 401. The client reconnects with
     * a fresh token. 0.147.0: a context with no numeric `exp` is refused like
     * an expired one, except under `insecureAllowAll` (never timed out).
     * Default {@link DEFAULT_TOKEN_EXPIRY_GRACE_MS} (1000 ms) for clock skew.
     */
    tokenExpiryGraceMs?: number;
}
/** {@link WsHandlerOptions.inboundRateLimit}. */
export interface InboundRateLimitOptions {
    /** Sustained frames per second per connection. Default 50. */
    framesPerSecond?: number;
    /** Bucket size: frames a connection may send at once. Default 2 × rate. */
    burst?: number;
    /** At most one RATE_LIMITED frame per connection per window. Default 1000 ms. */
    windowMs?: number;
    /** Observer for each dropped frame (metrics). Never throws into the socket. */
    onLimited?: (clientId: string, info: {
        droppedInWindow: number;
        droppedTotal: number;
    }) => void;
}
/** What `WsHandlerHandle.stats()` reports (0.119, lane R6). */
export interface WsHandlerStats {
    /** Connected clients. */
    connections: number;
    /**
     * Inbound frames accepted but not yet finished, summed over every
     * connection and lane — the handler's work queue depth.
     */
    queueDepth: number;
    /** The deepest single connection queue right now. */
    maxConnectionQueueDepth: number;
    /** The deepest total queue seen since creation (or the last reset). */
    peakQueueDepth: number;
    inbound: {
        /** Frames handed to a lane. */
        accepted: number;
        /** Frames dropped by `inboundRateLimit`. */
        dropped: number;
        /** RATE_LIMITED error frames sent. */
        limitNotices: number;
        /** Connections that are over budget in their current window. */
        limitedConnections: number;
    };
    /** Event-loop delay (ms) since creation or the last reset; null where unsupported. */
    eventLoop: {
        p50Ms: number;
        p99Ms: number;
        maxMs: number;
        meanMs: number;
    } | null;
}
/** Default {@link WsHandlerOptions.independentServices}. */
export declare const DEFAULT_INDEPENDENT_SERVICES: readonly string[];
/** Default `maxPayload` for `createWsHandler` / `attachRealtime`: 1 MiB (16 MiB before 0.146.0). */
export declare const DEFAULT_WS_MAX_PAYLOAD: number;
/** Default {@link WsHandlerOptions.maxQueueDepth} (0.146.0). */
export declare const DEFAULT_WS_MAX_QUEUE_DEPTH = 256;
/** Default {@link WsHandlerOptions.tokenExpiryGraceMs} (0.146.0). */
export declare const DEFAULT_TOKEN_EXPIRY_GRACE_MS = 1000;
export interface WsHandlerHandle {
    /** The underlying `ws.Server` instance. */
    wss: any;
    /** Tear down: close the server, remove the upgrade listener. */
    dispose(): Promise<void>;
    /** Read-only snapshot of currently connected client IDs. */
    listClients(): string[];
    /** Send a JSON frame to one client. Returns false if not connected. */
    sendToClient(clientId: string, frame: Record<string, unknown>): boolean;
    /**
     * Auth context captured for this client at upgrade time (whatever the
     * `auth` callback returned), or null when unknown/disconnected. Lets a
     * router derive user identity locally — presence display names,
     * fileupload's uploader attribution, call's user-targeted routing all
     * read identity through this. Return the same context object for the
     * connection's lifetime; do not mutate identity/actor fields in place.
     * Replacing the context fences pending authorization and sensitive replies.
     */
    getClientContext(clientId: string): WsAuthContext | null;
    /**
     * 0.119 (lane R6): queue depth, inbound budget counters and event-loop
     * delay. `reset` restarts the peak and the event-loop histogram after
     * reading. Optional so hand-written handles (tests, wrappers) still type.
     */
    stats?(opts?: {
        reset?: boolean;
    }): WsHandlerStats;
}
//# sourceMappingURL=types.d.ts.map