// realtime-modules/src/server-ws/types.ts
//
// Contract types for the createWsHandler factory. Service classes
// already shipped by this package (PresenceService, ChatService,
// ReactionsService, CRDTService, ...) fulfill WsService structurally
// via their existing `handleAction(clientId, action, data)` method.
//
// The handler does not depend on Node's `http` types directly (avoids a
// hard @types/node import in package consumers); instead it accepts a
// minimal `WsHttpServer` shape that real `http.Server` + `https.Server`
// instances satisfy.

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
    handleAction(
        clientId: string,
        action: string,
        data: Record<string, unknown>,
    ): Promise<void> | void;

    onClientConnect?(clientId: string): Promise<void> | void;
    onClientDisconnect?(clientId: string): Promise<void> | void;
}

/**
 * Auth callback. Resolves a userId (or anything else) from the upgrade
 * request — token in Sec-WebSocket-Protocol header, cookie, query
 * string. Throwing or rejecting causes the upgrade to be rejected
 * with 401.
 */
export type WsAuthFn = (
    req: IncomingMessage,
) => Promise<WsAuthContext> | WsAuthContext;

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
     * Optional auth callback. Runs during the HTTP upgrade. If it
     * throws or rejects, the upgrade is denied with 401.
     */
    auth?: WsAuthFn;
    /** Fired after a client is fully connected. */
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
     * Path filter. If set, only upgrade requests for `req.url`
     * starting with this path are handled. Defaults to accept all.
     */
    path?: string;
}

export interface WsHandlerHandle {
    /** The underlying `ws.Server` instance. */
    wss: any;
    /** Tear down: close the server, remove the upgrade listener. */
    dispose(): Promise<void>;
    /** Read-only snapshot of currently connected client IDs. */
    listClients(): string[];
    /** Send a JSON frame to one client. Returns false if not connected. */
    sendToClient(clientId: string, frame: Record<string, unknown>): boolean;
}
