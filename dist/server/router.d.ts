import type { WsHandlerHandle, WsAuthContext } from '../server-ws/types';
/**
 * Logger contract shared by the router and every feature. All four methods
 * are required — services declare their own narrower logger types and some
 * require `debug`, so the shared contract is the strictest union member.
 * `console` satisfies it structurally.
 */
export interface RouterLogger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}
/**
 * Channel authorization hook for the local router.
 *
 * `kind` distinguishes a subscribe attempt from a publish attempt so a
 * single hook can express read/write asymmetry (e.g. announcement channels:
 * anyone subscribes, only moderators publish). Returning `false`:
 *   - on 'subscribe' → subscribeToChannel returns false, which M3-aware
 *     services (ChatService) honour by suppressing the local subscription
 *     and the joined ack;
 *   - on 'publish' → the frame is dropped before fan-out.
 * When the hook is absent everything is allowed — single-tenant default.
 */
export type ChannelAuthorize = (args: {
    kind: 'subscribe' | 'publish';
    clientId: string;
    channel: string;
    ctx: WsAuthContext | null;
}) => boolean;
/** Lifecycle plugin hooks (carried over from the v0.6 factory, unchanged). */
export interface FeaturePlugin {
    name: string;
    onConnect?: (info: {
        clientId: string;
        channelId: string;
    }) => void | Promise<void>;
    onDisconnect?: (info: {
        clientId: string;
        channels: string[];
    }) => void | Promise<void>;
    onMessage?: (info: {
        clientId: string;
        channelId: string;
        message: unknown;
    }) => void | Promise<void>;
}
/**
 * The union router contract. Optional members are capabilities a transport
 * MAY provide; services already treat them as optional (`router.x?.(…)`) or
 * degrade gracefully. A custom router should implement as much of this as
 * its transport supports.
 */
export interface RealtimeRouter {
    sendToClient(clientId: string, message: unknown): void | boolean | Promise<void | boolean>;
    sendToLocalClient?(clientId: string, message: unknown): void;
    /**
     * Publish to a channel. `opts.publisherClientId` names the AUTHZ subject
     * independently of `excludeClientId` (echo control) — the M3 contract:
     * a router that enforces publish authz runs it whenever
     * `publisherClientId` is set, and the sender still receives its echo.
     */
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
    }): Promise<void> | void;
    /**
     * Subscribe a client to a channel. Returns `false` when authz denies —
     * M3-aware services suppress their local subscription and success ack.
     */
    subscribeToChannel?(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    /** Auth context accessor — `{ userContext }` shape services expect. */
    getClientData?(clientId: string): {
        userContext?: WsAuthContext;
    } | null;
    /** Uploader/identity attribution (fileupload). */
    getUserIdForClient?(clientId: string): string | undefined;
    /** User-targeted routing (call). */
    getClientsByUserId?(userIds: string[], excludeClientId?: string): {
        clientId: string;
        userId: string;
    }[];
    /** Broadcast to every connected client (call's no-target fallback). */
    broadcastToAll?(message: unknown, excludeClientId?: string): Promise<void> | void;
    /** Remove a client from all channels (disconnect path). */
    removeClient?(clientId: string): void;
    /** Transport hints some services read. */
    readonly redisAvailable?: boolean;
    readonly nodeId?: string;
}
/**
 * Single-process router: in-memory channel membership, identity from the WS
 * auth context, optional channel authz, plugin lifecycle hooks. The handle
 * is attached lazily (it is created after the services that hold the
 * router), so pre-connection sends are no-ops by design.
 */
export declare class LocalRealtimeRouter implements RealtimeRouter {
    /** channel → Set<clientId> */
    private readonly channelMembers;
    /** clientId → Set<channel> — mirror for disconnect notification */
    private readonly clientChannels;
    private handleRef;
    private readonly plugins;
    private readonly authorize;
    private readonly logger;
    readonly redisAvailable = false;
    readonly nodeId = "local";
    constructor(opts?: {
        plugins?: FeaturePlugin[];
        authorize?: ChannelAuthorize;
        logger?: RouterLogger;
    });
    _setHandle(handle: WsHandlerHandle): void;
    private ctxOf;
    getClientData(clientId: string): {
        userContext?: WsAuthContext;
    } | null;
    getUserIdForClient(clientId: string): string | undefined;
    getClientsByUserId(userIds: string[], excludeClientId?: string): {
        clientId: string;
        userId: string;
    }[];
    sendToClient(clientId: string, message: unknown): void;
    sendToLocalClient(clientId: string, message: unknown): void;
    broadcastToAll(message: unknown, excludeClientId?: string): Promise<void>;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
    }): Promise<void>;
    subscribeToChannel(clientId: string, channel: string): boolean;
    unsubscribeFromChannel(clientId: string, channel: string): void;
    removeClient(clientId: string): void;
}
//# sourceMappingURL=router.d.ts.map