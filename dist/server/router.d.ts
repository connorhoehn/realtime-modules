import type { WsHandlerHandle, WsAuthContext } from '../server-ws/types';
import { type ChannelAccessKind, type ChannelAccessOpts } from '../server-ws/channelAccess';
import { type AuthorityScope } from '../server-ws/authorityScope';
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
 * Channel authorization hook for the local router — the one place channel
 * access is decided for every built-in service.
 *
 * `kind` distinguishes reading a channel from writing to it, so a single
 * hook can express read/write asymmetry (announcement channels: anyone
 * subscribes, only moderators publish).
 *
 *   - 'subscribe' — joining a channel's fan-out, and every read that hands
 *     the channel's state back without a subscription: presence `subscribe` /
 *     `get`, reaction `subscribe`, cursor `subscribe` / `get`, chat `join` /
 *     `history` / `members` / `receipts`, and the generic `subscribe` service.
 *   - 'publish' — every write that changes channel state or fans out:
 *     presence `set` (once per channel it names), reaction `send` / `remove`,
 *     cursor `update`, chat `send` / `edit` / `delete` / `typing` / `read` /
 *     `addMembers` / `removeMember`, and the router's own `sendToChannel`
 *     backstop whenever a publisher is named.
 *
 * Predicates may be asynchronous; false, throws and rejected promises deny.
 * The local router also rechecks subscribe access before every recipient
 * delivery, including server-originated fanout.
 *
 * On `false` the service does nothing: no subscription, no ack, no state
 * returned, no stored write, no fan-out. The refused client receives
 * `{ type: 'error', service, code: 'AUTHZ_CHANNEL_DENIED', kind, channel,
 * message, error: { code, message, timestamp } }` (the router's
 * `sendToChannel` backstop drops silently).
 *
 * Channel names. Presence, reactions and cursor wrap the client's channel in
 * a prefix of their own, so the hook sees:
 *
 *   presence  → `presence:<channel>`
 *   reactions → `reactions:<channel>`
 *   cursor    → `cursor:<channel>`
 *
 * Chat, activity, social and crdt pass the client's channel unchanged;
 * typed-documents subscribes `doc:<documentId>` and `doc-comments:<documentId>`;
 * ingest (`ingest:…`) and pipeline (`pipeline:…`) channels are named that way
 * by the client. `splitServiceChannel` strips the service prefix, so a
 * tenant rule reads:
 *
 * ```ts
 * import { attachRealtime, splitServiceChannel } from '@connorhoehn/realtime-modules/server';
 *
 * attachRealtime(server, {
 *     features: [chat(), presence(), reactions(), cursor()],
 *     auth,
 *     authorize: ({ channel, ctx }) =>
 *         !!ctx && splitServiceChannel(channel).channel.startsWith(`${ctx.org}:`),
 * });
 * ```
 *
 * The per-service `authorizeChannel` hooks (`presence({ authorizeChannel })`
 * and friends) are an additional layer: both must pass. When `authorize` is
 * absent everything is allowed — the single-tenant default.
 *
 * `scope` (0.107) names the OPERATION the check belongs to: one channel
 * fan-out (every recipient's `subscribe` check and the publisher's `publish`
 * check share it), or one inbound action (chat's pre-check, membership gate,
 * post-persist publish rechecks, fan-out and unread probes for one send).
 * A host may resolve one proof per channel in `scope.share(key, …)`. The
 * scope is closed when the operation ends and is never a settled cache; a
 * host that memoizes in it must keep each proof revocable for the rest of
 * the operation (see `AuthorityScope`). Ignoring it is always correct.
 */
export type ChannelAuthorize = (args: {
    kind: 'subscribe' | 'publish';
    clientId: string;
    channel: string;
    ctx: WsAuthContext | null;
    scope?: AuthorityScope;
}) => boolean | Promise<boolean>;
/** Last-mile recipient filter for the local router, including direct user
 * delivery, broadcast and channel fanout. Return the original/filtered frame
 * or null to suppress it. Throws and rejected promises suppress delivery.
 * Async results are discarded if the connection's auth context changes.
 * Custom routers must implement this boundary themselves. */
export type ClientMessageFilter = (args: {
    clientId: string;
    message: unknown;
    ctx: WsAuthContext | null;
}) => unknown | Promise<unknown>;
/**
 * Lifecycle plugin hooks (carried over from the v0.6 factory).
 *
 * `userId` (0.99.0) is the AUTHENTICATED user behind `clientId` — the
 * `userId` of the connection's auth context, the same context 0.98.5's
 * sender stamping reads — so a plugin never has to trust a chat-shaped
 * `metadata.userId` in the payload, and presence / reaction publishes carry
 * their sender too. `undefined` for a server-originated publish (a system
 * message, an offline sweep with no publisher) and for an unauthenticated
 * socket.
 */
export interface FeaturePlugin {
    name: string;
    onConnect?: (info: {
        clientId: string;
        channelId: string;
        userId?: string;
        scope?: AuthorityScope;
    }) => void | Promise<void>;
    onDisconnect?: (info: {
        clientId: string;
        channels: string[];
    }) => void | Promise<void>;
    onMessage?: (info: {
        clientId: string;
        channelId: string;
        message: unknown;
        userId?: string;
        scope?: AuthorityScope;
    }) => void | Promise<void>;
}
/**
 * `scope` on plugin hooks (0.108). `onMessage` receives the authority scope
 * of the fan-out it observes — for a chat send, the send's own scope, so a
 * plugin's membership reads (`listMembers(channel, { scope })`) and
 * readable-subscription probes (`isClientSubscribed(id, channel, { scope })`)
 * join the proof the send's authorize checks already resolved. `onConnect`
 * receives the subscribe's scope when the subscribing service passed one.
 *
 * The router RETAINS the scope while the hook's promise is pending (the hook
 * is the operation's tail, like chat's `onChannelMessage`), and releases it
 * when the promise settles or after `PLUGIN_SCOPE_RETAIN_MAX_MS`, whichever
 * is first. After release the scope may close: `share` then computes fresh
 * and stores nothing, so a late plugin read is a fresh read, never a cached
 * one. The scope is absent when the operation had none (or it had already
 * closed); a hook that ignores it keeps the per-recipient behaviour.
 */
export declare const PLUGIN_SCOPE_RETAIN_MAX_MS = 30000;
/**
 * The union router contract. Optional members are capabilities a transport
 * MAY provide; services already treat them as optional (`router.x?.(…)`) or
 * degrade gracefully. A custom router should implement as much of this as
 * its transport supports.
 */
export interface RealtimeRouter {
    /** Optional transport admission health. A leased router stays false once
     * ownership is lost, even if its Redis connection later recovers. */
    isReady?(): boolean;
    sendToClient(clientId: string, message: unknown): void | boolean | Promise<void | boolean>;
    sendToLocalClient?(clientId: string, message: unknown): void | boolean | Promise<void | boolean>;
    /**
     * Publish to a channel. `opts.publisherClientId` names the AUTHZ subject
     * independently of `excludeClientId` (echo control) — the M3 contract:
     * a router that enforces publish authz runs it whenever
     * `publisherClientId` is set, and the sender still receives its echo.
     */
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
        scope?: AuthorityScope;
    }): Promise<void> | void;
    /**
     * Subscribe a client to a channel. Returns `false` when authz denies —
     * M3-aware services suppress their local subscription and success ack.
     */
    subscribeToChannel?(clientId: string, channel: string, opts?: ChannelAccessOpts): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    /** Current readable subscription, fenced across actor replacement,
     * disconnect and unsubscribe/resubscribe. Peer transports may await it. */
    isClientSubscribed?(clientId: string, channel: string, opts?: {
        scope?: AuthorityScope;
    }): boolean | Promise<boolean>;
    /**
     * Ask the channel authz without subscribing or publishing — services run
     * it before a write (presence `set`, reaction `send`, chat `send`) or a
     * read that hands channel state back (presence `get`, chat `history`).
     * Returns false on refusal and tells the client (AUTHZ_CHANNEL_DENIED).
     * A router without it is treated as allow-all by the services, which
     * leaves enforcement to its `sendToChannel`.
     */
    checkChannel?(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    /** Whether an `authorize` hook is configured (services skip by-id read scoping without one). */
    hasChannelAuthorize?(): boolean;
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
    }[] | Promise<{
        clientId: string;
        userId: string;
    }[]>;
    /** Fresh cluster lookup. Local getClientData remains synchronous for
     * inbound identity fences; REST-originated readers can await this seam. */
    resolveClientData?(clientId: string): Promise<{
        userContext?: WsAuthContext;
    } | null>;
    /** true = connected here, false = not connected here, null = unknown
     *  (another replica may hold it). Services use it to tell a live
     *  participant from one whose socket is gone. */
    isClientLive?(clientId: string): boolean | null;
    /** Optional authoritative cluster liveness for call recovery/sweeps. */
    isClientAlive?(clientId: string): boolean | Promise<boolean>;
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
    /** A fresh token for each admission, including a re-subscribe. */
    private readonly subscriptionTokens;
    private handleRef;
    private readonly plugins;
    private readonly authorize;
    private readonly filterClientMessage;
    private readonly logger;
    /** In-flight admissions are cancelled by an unsubscribe/disconnect. */
    private readonly pendingSubscriptions;
    /** 0.109 publish proofs (see authorityScope.ts P1-P5); 0 = off. */
    readonly publishProofMaxAgeMs: number;
    readonly redisAvailable = false;
    readonly nodeId = "local";
    constructor(opts?: {
        plugins?: FeaturePlugin[];
        authorize?: ChannelAuthorize;
        filterClientMessage?: ClientMessageFilter;
        logger?: RouterLogger;
        /**
         * 0.109, opt-in. > 0: one `publish` authorize per (client, channel)
         * per operation scope, reused while younger than this many ms and
         * revocable by the host (`revokePublishProofs`). Recipient
         * `subscribe` checks are never shared. 0 / unset: every publish
         * check asks `authorize`.
         */
        publishProofMaxAgeMs?: number;
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
    /** Single process: a client not connected here is not connected. */
    isClientLive(clientId: string): boolean | null;
    sendToClient(clientId: string, message: unknown): boolean | Promise<boolean>;
    private sendFiltered;
    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean>;
    broadcastToAll(message: unknown, excludeClientId?: string): Promise<void>;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null, opts?: {
        skipCoalesce?: boolean;
        publisherClientId?: string | null;
        scope?: AuthorityScope;
    }): Promise<void>;
    private sendToChannelScoped;
    /** Trusted peer fanout: local recipient authorization and generation
     * fences still run; origin plugins/publish hooks are not fired twice.
     * Every recipient check of one fan-out shares one authority scope. */
    sendToLocalChannel(channel: string, message: unknown, excludeClientId?: string | null, scopeIn?: AuthorityScope): Promise<void>;
    private fanOut;
    /** Preserve synchronous decisions; rejected async decisions fail closed. */
    private allows;
    hasChannelAuthorize(): boolean;
    /** P5: the start time of this operation's live allowed publish proof. */
    publishProofAt(scope: AuthorityScope | null | undefined, clientId: string, channel: string): number | null;
    /**
     * The check every service runs before acting on a channel. On refusal
     * the client is told (AUTHZ_CHANNEL_DENIED) and false comes back.
     */
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    private channelDecision;
    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    isClientSubscribed(clientId: string, channel: string, opts?: {
        scope?: AuthorityScope;
    }): Promise<boolean>;
    private addSubscription;
    unsubscribeFromChannel(clientId: string, channel: string): void;
    removeClient(clientId: string): void;
}
//# sourceMappingURL=router.d.ts.map