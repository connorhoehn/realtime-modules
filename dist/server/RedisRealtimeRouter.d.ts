import { type FenceEvent, type FencedOwner } from 'distributed-core/cluster/leases';
import type { WsAuthContext, WsHandlerHandle } from '../server-ws/types';
import { type RealtimeRouter, type ChannelAuthorize, type ClientMessageFilter, type FeaturePlugin, type RouterLogger } from './router';
import { type ChannelAccessKind, type ChannelAccessOpts } from '../server-ws/channelAccess';
import type { CallCrossNodePubSub } from '../call/types';
import { type AuthorityScope } from '../server-ws/authorityScope';
/** Connected command/publish and dedicated subscriber clients. The host owns
 * connection setup, TLS/credentials, reconnect policy and final client close.
 * Ports deliberately avoid a mandatory Redis client dependency. */
export interface RealtimeClusterRedis {
    command(...args: string[]): Promise<unknown>;
    publish(topic: string, payload: string): Promise<unknown>;
    subscribe(topic: string, receive: (payload: string) => void): Promise<() => Promise<void> | void>;
    /** Notify an established connection loss, including a subscriber/publisher
     * loss while command leases still renew. Reconnect cannot revive that
     * router incarnation. The returned function removes the listener. */
    onUnavailable?(handler: () => void): () => void;
}
/** Namespace-scoped invalidation events from trusted application replicas.
 * Payloads are hints: handlers must reread their durable authority. Delivery
 * is best effort and duplicate-suppressed; there is no replay or receipt. */
export interface RealtimePeerEvents {
    publish(topic: string, payload: string): Promise<void>;
    subscribe(topic: string, handler: (payload: string) => void | Promise<void>): () => void;
}
/** Structural view of distributed-core's `LeaseGroup` (any copy of it). The
 * router adds its ownership lease on start; the first member to fence
 * retires (fences and releases) every sibling. */
export interface RealtimeLeaseGroup {
    add(member: FencedOwner): () => void;
}
/** A host membership cache whose committed writes other replicas must drop.
 * The router publishes each committed channel as a peer event and calls
 * `invalidate` for channels committed on peers. Hints only: the store must
 * reread its durable authority after an invalidation. */
export interface RealtimeMembershipInvalidation {
    invalidate(channel: string): void;
    onCommittedWrite(observer: (channel: string) => void): () => void;
}
export interface RedisRealtimeRouterOptions {
    /** The existing port, or distributed-core's `BoundedRedis`
     * (`createBoundedRedis(url, { timeoutMs })`), which satisfies it and
     * bounds every reply after the socket write. */
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
    /**
     * 0.109, opt-in (authorityScope.ts P1-P5). > 0: one sender-side publish
     * authorize per (client, channel) per operation on this node, and a
     * content-free proof time carried to peers; a peer with its own value
     * > 0 skips only the redundant publisher re-check while that time is
     * younger than ITS max age. Recipient checks always run on every node.
     */
    publishProofMaxAgeMs?: number;
    /**
     * 0.110, opt-in (authorityScope.ts P6). > 0: frames one origin operation
     * sends to a peer (its `subscription-check` probes and its `channel`
     * fan-out) carry a content-free operation number, and the peer runs
     * them under ONE authority scope per (origin instance, operation),
     * kept open at most this many ms after its last frame finishes. Every
     * check still asks `authorize`; only host-shared proofs (one membership
     * read per channel) are reused. 0 (default): one scope per frame, as
     * before, and no operation number on the wire. Max 2000.
     */
    peerOperationLingerMs?: number;
    /**
     * 0.117: fence together with sibling owners in the same process (e.g. a
     * `/ws` router and a cookie `/realtime` router). Pass a distributed-core
     * `LeaseGroup`; the router joins it once its lease is acquired. When any
     * member fences, every other member is fenced and released, so no lease
     * outlives the node's 503. A router joining a retired group fails start.
     * `shutdown()` leaves the group before releasing its lease, so a
     * deliberate shutdown (or a failed start) does not retire siblings; a
     * fence always does.
     */
    leaseGroup?: RealtimeLeaseGroup;
    /**
     * 0.117: cross-replica invalidation for a membership cache. Committed
     * writes are published on `membershipEventTopic` (default
     * `chat:membership`) and peers call `invalidate(channel)`.
     */
    membershipStore?: RealtimeMembershipInvalidation;
    /** Peer event topic for `membershipStore`. Default `chat:membership`. */
    membershipEventTopic?: string;
    /** Peer-supplied channels this node will invalidate. Default: any non-empty string up to 512 bytes. */
    acceptMembershipChannel?: (channel: string) => boolean;
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
    private stopped;
    private started;
    /** The node ownership lease (0.117: distributed-core `FencedLease`).
     * Its owner is this router's boot `instance`; it renews this node's
     * client registrations (and their user index) as attached keys. */
    private readonly ownership;
    private readonly membershipTopic;
    private readonly unsubs;
    private readonly registrations;
    private readonly remote;
    private readonly pending;
    private readonly seen;
    private activeDeliveries;
    private readonly peerLingerMs;
    private readonly peerOps;
    private readonly cleanup;
    private readonly callHandlers;
    private readonly peerHandlers;
    readonly peerEvents: RealtimePeerEvents;
    private validateEventTopic;
    /** False permanently after ownership expires or renewal fails. Hosts can
     * remove an unhealthy replica from admission without knowing Redis keys. */
    isReady(): boolean;
    /** Same as `isReady()`; with `onFence` this makes the router a
     * distributed-core `ReadinessGate` owner. */
    isLive(): boolean;
    /** Called once when routing stops being live: the lease fenced (expired,
     * renewal failed/refused, connection unavailable, sibling, manual) or was
     * released at shutdown (`reason: 'released'`). */
    onFence(handler: (event: FenceEvent) => void): () => void;
    /** The ownership lease, for a host `LeaseGroup` or `ReadinessGate`. */
    get lease(): FencedOwner;
    /** The lease's monotonic fencing token (0 before start). */
    get fencingToken(): number;
    /** Ready with start(), namespace-scoped and checked against the origin's
     * live ownership lease. CallService's sync subscription has no async gap. */
    readonly crossNodePubSub: CallCrossNodePubSub;
    constructor(opts: RedisRealtimeRouterOptions);
    private nodeKey;
    private clientKey;
    private userKey;
    private topic;
    private live;
    /** The lease stopped being live. It never revives (the lease logs why). */
    private fenced;
    /** Renewed atomically with the owner key: each current registration's
     * client key (while it still holds this registration) and its user index. */
    private attachments;
    private source;
    private current;
    private validSource;
    private ownerAlive;
    start(): Promise<void>;
    _setHandle(handle: WsHandlerHandle): void;
    onClientConnect(clientId: string, ctx: WsAuthContext): Promise<void>;
    private wireMembership;
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
    private request;
    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean>;
    hasChannelAuthorize(): boolean;
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): Promise<boolean>;
    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    unsubscribeFromChannel(clientId: string, channel: string): void;
    isClientSubscribed(clientId: string, channel: string, opts?: {
        scope?: AuthorityScope;
    }): Promise<boolean>;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
        scope?: AuthorityScope;
    }): Promise<void>;
    private sendToChannelScoped;
    broadcastToAll(message: unknown, excludeClientId?: string): Promise<void>;
    private receive;
    private deliver;
    /** P6, origin side: the operation number a peer frame carries, opted in. */
    private operationOf;
    /**
     * P6, peer side: one scope per (origin instance, operation) while any of
     * its frames runs, closed `peerLingerMs` after the last one finishes.
     * Null when off, unnumbered or over the bound (callers then use their
     * own per-frame scope, as before 0.110).
     */
    private acquirePeerOperation;
    private closePeerOps;
    removeClient(clientId: string): void;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=RedisRealtimeRouter.d.ts.map