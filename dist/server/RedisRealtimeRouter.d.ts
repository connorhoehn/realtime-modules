import type { WsAuthContext, WsHandlerHandle } from '../server-ws/types';
import { type RealtimeRouter, type ChannelAuthorize, type ClientMessageFilter, type FeaturePlugin, type RouterLogger } from './router';
import { type ChannelAccessKind, type ChannelAccessOpts } from '../server-ws/channelAccess';
import type { CallCrossNodePubSub } from '../call/types';
/** Connected command/publish and dedicated subscriber clients. The host owns
 * connection setup, TLS/credentials, reconnect policy and final client close.
 * Ports deliberately avoid a mandatory Redis client dependency. */
export interface RealtimeClusterRedis {
    command(...args: string[]): Promise<unknown>;
    publish(topic: string, payload: string): Promise<unknown>;
    subscribe(topic: string, receive: (payload: string) => void): Promise<() => Promise<void> | void>;
}
/** Namespace-scoped invalidation events from trusted application replicas.
 * Payloads are hints: handlers must reread their durable authority. Delivery
 * is best effort and duplicate-suppressed; there is no replay or receipt. */
export interface RealtimePeerEvents {
    publish(topic: string, payload: string): Promise<void>;
    subscribe(topic: string, handler: (payload: string) => void | Promise<void>): () => void;
}
export interface RedisRealtimeRouterOptions {
    redis: RealtimeClusterRedis;
    /** Separate applications/environments must use separate namespaces. */
    namespace: string;
    /** Unique among live replicas. A second live owner is rejected. */
    nodeId: string;
    authorize?: ChannelAuthorize;
    filterClientMessage?: ClientMessageFilter;
    plugins?: FeaturePlugin[];
    logger?: RouterLogger;
    leaseMs?: number;
    requestTimeoutMs?: number;
    maxFrameBytes?: number;
    maxPendingRequests?: number;
    maxSeenFrames?: number;
}
/** Opt-in Redis peer transport. Each destination uses LocalRealtimeRouter's
 * current recipient authorization/context/subscription fences. Directory
 * records come exclusively from the authenticated connection lifecycle;
 * outbound frames never supply or replace a recipient's auth context.
 * This carries routing, not service-state replication (presence/CRDT/etc.). */
export declare class RedisRealtimeRouter implements RealtimeRouter {
    private readonly opts;
    readonly redisAvailable = true;
    readonly nodeId: string;
    readonly instance: `${string}-${string}-${string}-${string}-${string}`;
    private readonly local;
    private readonly log;
    private readonly prefix;
    private readonly leaseMs;
    private readonly timeoutMs;
    private readonly maxBytes;
    private readonly maxPending;
    private readonly maxSeen;
    private handle;
    private deadline;
    private stopped;
    private started;
    private fenced;
    private timer;
    private renewing;
    private readonly unsubs;
    private readonly registrations;
    private readonly remote;
    private readonly pending;
    private readonly seen;
    private activeDeliveries;
    private readonly cleanup;
    private readonly callHandlers;
    private readonly peerHandlers;
    readonly peerEvents: RealtimePeerEvents;
    private validateEventTopic;
    /** False permanently after ownership expires or renewal fails. Hosts can
     * remove an unhealthy replica from admission without knowing Redis keys. */
    isReady(): boolean;
    /** Ready with start(), namespace-scoped and checked against the origin's
     * live ownership lease. CallService's sync subscription has no async gap. */
    readonly crossNodePubSub: CallCrossNodePubSub;
    constructor(opts: RedisRealtimeRouterOptions);
    private nodeKey;
    private clientKey;
    private userKey;
    private topic;
    private live;
    private source;
    private current;
    private validSource;
    private ownerAlive;
    start(): Promise<void>;
    _setHandle(handle: WsHandlerHandle): void;
    onClientConnect(clientId: string, ctx: WsAuthContext): Promise<void>;
    private renew;
    private registration;
    getClientData(clientId: string): {
        userContext?: WsAuthContext;
    } | null;
    resolveClientData(clientId: string): Promise<{
        userContext?: WsAuthContext;
    } | null>;
    getUserIdForClient(clientId: string): string | undefined;
    isClientLive(clientId: string): boolean | null;
    isClientAlive(clientId: string): Promise<boolean>;
    getClientsByUserId(userIds: string[], excludeClientId?: string): Promise<{
        clientId: string;
        userId: string;
    }[]>;
    private encode;
    private publish;
    sendToClient(clientId: string, message: unknown): Promise<boolean>;
    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean>;
    hasChannelAuthorize(): boolean;
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): Promise<boolean>;
    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    unsubscribeFromChannel(clientId: string, channel: string): void;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
    }): Promise<void>;
    broadcastToAll(message: unknown, excludeClientId?: string): Promise<void>;
    private receive;
    private deliver;
    removeClient(clientId: string): void;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=RedisRealtimeRouter.d.ts.map