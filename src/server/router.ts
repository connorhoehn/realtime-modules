// realtime-modules/src/server/router.ts
//
// The router contract every feature plugs into, plus the zero-config
// single-process implementation.
//
// `RealtimeRouter` is the UNION of the narrow per-service router contracts
// (ChatMessageRouter, RoomMessageRouter, CallMessageRouter, …). Each service
// still declares only the slice it needs — this interface exists so that
// (a) `attachRealtime` can hand ONE object to every feature, and (b)
// alternative transports can be swapped in wholesale: a Redis-backed
// multi-node router (the websocket-gateway pattern) satisfies this contract
// and drops into `attachRealtime({ router })` unchanged. That swap is the
// designed graduation path from single-process to multi-node.
//
// LocalRealtimeRouter is deliberately single-process: channel membership in
// Maps, fan-out by iteration, identity from the WS auth context. It exists
// so one feature — or all thirteen — can be attached to an existing
// http.Server with zero infrastructure.

import type { WsHandlerHandle, WsAuthContext } from '../server-ws/types';
import { channelDeniedFrame, type ChannelAccessKind, type ChannelAccessOpts } from '../server-ws/channelAccess';
import { scopeFor, sharePublishProof, publishProofStartedAt, type AuthorityScope } from '../server-ws/authorityScope';

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
    onConnect?: (info: { clientId: string; channelId: string; userId?: string; scope?: AuthorityScope }) => void | Promise<void>;
    onDisconnect?: (info: { clientId: string; channels: string[] }) => void | Promise<void>;
    onMessage?: (info: { clientId: string; channelId: string; message: unknown; userId?: string; scope?: AuthorityScope }) => void | Promise<void>;
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
export const PLUGIN_SCOPE_RETAIN_MAX_MS = 30_000;

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
    sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null; scope?: AuthorityScope },
    ): Promise<void> | void;
    /**
     * Subscribe a client to a channel. Returns `false` when authz denies —
     * M3-aware services suppress their local subscription and success ack.
     */
    subscribeToChannel?(
        clientId: string,
        channel: string,
        opts?: ChannelAccessOpts,
    ): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    /** Current readable subscription, fenced across actor replacement,
     * disconnect and unsubscribe/resubscribe. Peer transports may await it. */
    isClientSubscribed?(clientId: string, channel: string, opts?: { scope?: AuthorityScope }): boolean | Promise<boolean>;
    /**
     * Ask the channel authz without subscribing or publishing — services run
     * it before a write (presence `set`, reaction `send`, chat `send`) or a
     * read that hands channel state back (presence `get`, chat `history`).
     * Returns false on refusal and tells the client (AUTHZ_CHANNEL_DENIED).
     * A router without it is treated as allow-all by the services, which
     * leaves enforcement to its `sendToChannel`.
     */
    checkChannel?(
        kind: ChannelAccessKind,
        clientId: string,
        channel: string,
        opts?: ChannelAccessOpts,
    ): boolean | Promise<boolean>;
    /** Whether an `authorize` hook is configured (services skip by-id read scoping without one). */
    hasChannelAuthorize?(): boolean;
    /** Auth context accessor — `{ userContext }` shape services expect. */
    getClientData?(clientId: string): { userContext?: WsAuthContext } | null;
    /** Uploader/identity attribution (fileupload). */
    getUserIdForClient?(clientId: string): string | undefined;
    /** User-targeted routing (call). */
    getClientsByUserId?(userIds: string[], excludeClientId?: string): { clientId: string; userId: string }[] | Promise<{ clientId: string; userId: string }[]>;
    /** Fresh cluster lookup. Local getClientData remains synchronous for
     * inbound identity fences; REST-originated readers can await this seam. */
    resolveClientData?(clientId: string): Promise<{ userContext?: WsAuthContext } | null>;
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

function firePlugin(name: string, fn: () => void | Promise<void>, scope?: AuthorityScope): void {
    // A plugin observing a scoped operation keeps the scope open until its
    // own promise settles (bounded), so its reads share the operation's
    // proofs; it never holds the scope past that.
    let release: (() => void) | null = scope?.active ? scope.retain() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        const r = release; release = null; r?.();
    };
    try {
        const r = fn();
        if (r && typeof (r as Promise<void>).then === 'function') {
            if (release) {
                timer = setTimeout(done, PLUGIN_SCOPE_RETAIN_MAX_MS);
                (timer as { unref?: () => void }).unref?.();
            }
            (r as Promise<void>).then(done, done);
            return;
        }
    } catch {
        /* plugin errors never propagate */
    }
    done();
}

/** `scope` only while it is open — a closed scope is never handed out. */
function liveScope(scope: AuthorityScope | null | undefined): { scope: AuthorityScope } | Record<string, never> {
    return scope?.active ? { scope } : {};
}

/**
 * Single-process router: in-memory channel membership, identity from the WS
 * auth context, optional channel authz, plugin lifecycle hooks. The handle
 * is attached lazily (it is created after the services that hold the
 * router), so pre-connection sends are no-ops by design.
 */
export class LocalRealtimeRouter implements RealtimeRouter {
    /** channel → Set<clientId> */
    private readonly channelMembers = new Map<string, Set<string>>();
    /** clientId → Set<channel> — mirror for disconnect notification */
    private readonly clientChannels = new Map<string, Set<string>>();
    /** A fresh token for each admission, including a re-subscribe. */
    private readonly subscriptionTokens = new Map<string, Map<string, object>>();
    private handleRef: WsHandlerHandle | null = null;
    private readonly plugins: FeaturePlugin[];
    private readonly authorize: ChannelAuthorize | null;
    private readonly filterClientMessage: ClientMessageFilter | null;
    private readonly logger: RouterLogger;
    /** In-flight admissions are cancelled by an unsubscribe/disconnect. */
    private readonly pendingSubscriptions = new Map<string, Map<string, Set<{ cancelled: boolean }>>>();
    /** 0.109 publish proofs (see authorityScope.ts P1-P5); 0 = off. */
    readonly publishProofMaxAgeMs: number;

    readonly redisAvailable = false;
    readonly nodeId = 'local';

    constructor(opts: {
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
    } = {}) {
        const maxAge = opts.publishProofMaxAgeMs ?? 0;
        if (!Number.isFinite(maxAge) || maxAge < 0) throw new Error('publishProofMaxAgeMs must be a non-negative number');
        this.publishProofMaxAgeMs = maxAge;
        this.plugins = opts.plugins ?? [];
        this.authorize = opts.authorize ?? null;
        this.filterClientMessage = opts.filterClientMessage ?? null;
        this.logger = opts.logger ?? {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        };
    }

    _setHandle(handle: WsHandlerHandle): void {
        this.handleRef = handle;
    }

    // ---- identity --------------------------------------------------------

    private ctxOf(clientId: string): WsAuthContext | null {
        return this.handleRef?.getClientContext(clientId) ?? null;
    }

    getClientData(clientId: string): { userContext?: WsAuthContext } | null {
        const ctx = this.ctxOf(clientId);
        return ctx ? { userContext: ctx } : null;
    }

    getUserIdForClient(clientId: string): string | undefined {
        const uid = this.ctxOf(clientId)?.userId;
        return typeof uid === 'string' && uid.length > 0 ? uid : undefined;
    }

    getClientsByUserId(userIds: string[], excludeClientId?: string): { clientId: string; userId: string }[] {
        if (!this.handleRef) return [];
        const wanted = new Set(userIds);
        const out: { clientId: string; userId: string }[] = [];
        for (const clientId of this.handleRef.listClients()) {
            if (clientId === excludeClientId) continue;
            const uid = this.getUserIdForClient(clientId);
            if (uid && wanted.has(uid)) out.push({ clientId, userId: uid });
        }
        return out;
    }

    /** Single process: a client not connected here is not connected. */
    isClientLive(clientId: string): boolean | null {
        if (!this.handleRef) return null;
        return this.handleRef.getClientContext(clientId) != null;
    }

    // ---- sends -----------------------------------------------------------

    sendToClient(clientId: string, message: unknown): boolean | Promise<boolean> {
        return this.sendFiltered(clientId, message);
    }

    private sendFiltered(clientId: string, message: unknown, stillCurrent: () => boolean = () => true): boolean | Promise<boolean> {
        const handle = this.handleRef;
        if (!handle) return false;
        if (!this.filterClientMessage) return stillCurrent() && handle.sendToClient(clientId, message as Record<string, unknown>);
        const context = this.ctxOf(clientId);
        if (!context) return false;
        const deliver = (filtered: unknown): boolean => {
            if (filtered == null || this.handleRef !== handle || this.ctxOf(clientId) !== context || !stillCurrent()) return false;
            return handle.sendToClient(clientId, filtered as Record<string, unknown>);
        };
        try {
            const filtered = this.filterClientMessage({ clientId, message, ctx: context });
            if (filtered && typeof (filtered as Promise<unknown>).then === 'function') {
                return Promise.resolve(filtered).then(deliver, () => false);
            }
            return deliver(filtered);
        } catch { return false; }
    }

    sendToLocalClient(clientId: string, message: unknown): boolean | Promise<boolean> {
        return this.sendToClient(clientId, message);
    }

    async broadcastToAll(message: unknown, excludeClientId?: string): Promise<void> {
        if (!this.handleRef) return;
        await Promise.all(this.handleRef.listClients().filter(clientId => clientId !== excludeClientId)
            .map(clientId => this.sendToClient(clientId, message)));
    }

    async sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null; scope?: AuthorityScope },
    ): Promise<void> {
        const { scope, owned } = scopeFor(opts?.scope, 'fanout');
        try {
            await this.sendToChannelScoped(channel, message, excludeClientId, opts?.publisherClientId ?? null, scope);
        } finally {
            if (owned) scope.close();
        }
    }

    private async sendToChannelScoped(
        channel: string,
        message: unknown,
        excludeClientId: string | null | undefined,
        publisher: string | null,
        scope: AuthorityScope,
    ): Promise<void> {
        // M3 publish authz: runs whenever a publisher is named, independent
        // of echo exclusion.
        const publisherContext = publisher ? this.ctxOf(publisher) : null;
        if (publisher && !(await this.allows('publish', publisher, channel, scope))) {
            this.logger.info(`[realtime] publish to ${channel} denied for ${publisher}`);
            return;
        }
        if (publisher && this.ctxOf(publisher) !== publisherContext) return;

        const senderClientId = publisher ?? excludeClientId ?? null;
        const senderId = senderClientId ?? 'server';
        if (this.plugins.length > 0) {
            const userId = senderClientId ? this.getUserIdForClient(senderClientId) : undefined;
            for (const plugin of this.plugins) {
                if (plugin.onMessage) {
                    firePlugin(plugin.name, () =>
                        plugin.onMessage!({ clientId: senderId, channelId: channel, message, userId, ...liveScope(scope) }),
                    scope);
                }
            }
        }

        await this.sendToLocalChannel(channel, message, excludeClientId, scope);
    }

    /** Trusted peer fanout: local recipient authorization and generation
     * fences still run; origin plugins/publish hooks are not fired twice.
     * Every recipient check of one fan-out shares one authority scope. */
    async sendToLocalChannel(channel: string, message: unknown, excludeClientId?: string | null, scopeIn?: AuthorityScope): Promise<void> {
        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0) return;
        const { scope, owned } = scopeFor(scopeIn, 'fanout');
        try {
            await this.fanOut(channel, message, members, excludeClientId, scope);
        } finally {
            if (owned) scope.close();
        }
    }

    private async fanOut(channel: string, message: unknown, members: Set<string>, excludeClientId: string | null | undefined, scope: AuthorityScope): Promise<void> {
        // Admission is not a lasting grant. Recheck every recipient, even for
        // server-originated updates, and do not revive a subscription removed
        // while asynchronous authorization was resolving.
        await Promise.all([...members].map(async clientId => {
            if (clientId === excludeClientId) return;
            const context = this.ctxOf(clientId);
            const token = this.subscriptionTokens.get(channel)?.get(clientId);
            if (!(await this.allows('subscribe', clientId, channel, scope))) return;
            if (this.ctxOf(clientId) !== context || !token || this.subscriptionTokens.get(channel)?.get(clientId) !== token) return;
            await this.sendFiltered(clientId, message, () => this.ctxOf(clientId) === context
                && this.subscriptionTokens.get(channel)?.get(clientId) === token);
        }));
    }

    // ---- authz -----------------------------------------------------------

    /** Preserve synchronous decisions; rejected async decisions fail closed. */
    private allows(kind: ChannelAccessKind, clientId: string, channel: string, scope?: AuthorityScope): boolean | Promise<boolean> {
        if (!this.authorize) return true;
        const context = this.ctxOf(clientId);
        const handle = this.handleRef;
        try {
            const authorize = this.authorize;
            const ask = () => authorize(scope?.active
                ? { kind, clientId, channel, ctx: context, scope }
                : { kind, clientId, channel, ctx: context });
            // Only the sender-side publish decision is shared (P1); the
            // fences below still run for this check.
            const decision = kind === 'publish' && this.publishProofMaxAgeMs > 0 && scope?.active && context
                ? sharePublishProof(scope, clientId, channel, context, this.publishProofMaxAgeMs, ask)
                : ask();
            if (typeof decision === 'boolean') return decision;
            return Promise.resolve(decision).then(
                allowed => allowed === true && this.handleRef === handle && (!handle || (context !== null && this.ctxOf(clientId) === context)),
                err => { this.logger.warn(`[realtime] authorize rejected for ${kind} ${channel}; refusing`, err); return false; },
            );
        } catch (err) {
            this.logger.warn(`[realtime] authorize threw for ${kind} ${channel}; refusing`, err);
            return false;
        }
    }

    hasChannelAuthorize(): boolean {
        return this.authorize !== null;
    }

    /** P5: the start time of this operation's live allowed publish proof. */
    publishProofAt(scope: AuthorityScope | null | undefined, clientId: string, channel: string): number | null {
        return publishProofStartedAt(scope, clientId, channel, this.publishProofMaxAgeMs);
    }

    /**
     * The check every service runs before acting on a channel. On refusal
     * the client is told (AUTHZ_CHANNEL_DENIED) and false comes back.
     */
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts: ChannelAccessOpts = {}): boolean | Promise<boolean> {
        const decision = this.allows(kind, clientId, channel, opts.scope);
        return typeof decision === 'boolean' ? this.channelDecision(decision, kind, clientId, channel, opts)
            : decision.then(allowed => this.channelDecision(allowed, kind, clientId, channel, opts));
    }

    private channelDecision(allowed: boolean, kind: ChannelAccessKind, clientId: string, channel: string, opts: ChannelAccessOpts): boolean {
        if (allowed) return true;
        this.logger.info(`[realtime] ${kind} to ${channel} denied for ${clientId}`);
        if (opts.silent) return false;
        this.sendToClient(clientId, channelDeniedFrame({
            kind,
            channel: opts.clientChannel ?? channel,
            service: opts.service,
        }));
        return false;
    }

    // ---- membership ------------------------------------------------------

    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean> {
        // M3: on false, services suppress the local subscription and the ack.
        const context = this.ctxOf(clientId);
        const decision = this.checkChannel('subscribe', clientId, channel, opts);
        if (typeof decision === 'boolean') return decision && this.addSubscription(clientId, channel, opts?.scope);
        const pending = { cancelled: false };
        const channels = this.pendingSubscriptions.get(clientId) ?? new Map();
        const requests = channels.get(channel) ?? new Set();
        requests.add(pending); channels.set(channel, requests); this.pendingSubscriptions.set(clientId, channels);
        return decision.then(allowed => allowed && !pending.cancelled && this.ctxOf(clientId) === context && this.addSubscription(clientId, channel, opts?.scope)).finally(() => {
            requests.delete(pending);
            if (!requests.size) channels.delete(channel);
            if (!channels.size) this.pendingSubscriptions.delete(clientId);
        });
    }

    async isClientSubscribed(clientId: string, channel: string, opts: { scope?: AuthorityScope } = {}): Promise<boolean> {
        const context = this.ctxOf(clientId);
        const token = this.subscriptionTokens.get(channel)?.get(clientId);
        if (!context || !token) return false;
        const allowed = await this.checkChannel('subscribe', clientId, channel, { silent: true, ...(opts.scope ? { scope: opts.scope } : {}) });
        return allowed && this.ctxOf(clientId) === context
            && this.subscriptionTokens.get(channel)?.get(clientId) === token;
    }

    private addSubscription(clientId: string, channel: string, scope?: AuthorityScope): boolean {
        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);
        const tokens = this.subscriptionTokens.get(channel) ?? new Map();
        tokens.set(clientId, {}); this.subscriptionTokens.set(channel, tokens);

        let channels = this.clientChannels.get(clientId);
        if (!channels) {
            channels = new Set();
            this.clientChannels.set(clientId, channels);
        }
        channels.add(channel);

        const userId = this.plugins.length > 0 ? this.getUserIdForClient(clientId) : undefined;
        for (const plugin of this.plugins) {
            if (plugin.onConnect) {
                firePlugin(plugin.name, () => plugin.onConnect!({ clientId, channelId: channel, userId, ...liveScope(scope) }), scope);
            }
        }
        return true;
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
        for (const pending of this.pendingSubscriptions.get(clientId)?.get(channel) ?? []) pending.cancelled = true;
        const tokens = this.subscriptionTokens.get(channel);
        tokens?.delete(clientId);
        if (tokens?.size === 0) this.subscriptionTokens.delete(channel);
        const members = this.channelMembers.get(channel);
        if (members) {
            members.delete(clientId);
            if (members.size === 0) this.channelMembers.delete(channel);
        }
        const channels = this.clientChannels.get(clientId);
        if (channels) {
            channels.delete(channel);
            if (channels.size === 0) {
                this.clientChannels.delete(clientId);
                for (const plugin of this.plugins) {
                    if (plugin.onDisconnect) {
                        firePlugin(plugin.name, () => plugin.onDisconnect!({ clientId, channels: [channel] }));
                    }
                }
            }
        }
    }

    removeClient(clientId: string): void {
        for (const requests of this.pendingSubscriptions.get(clientId)?.values() ?? []) {
            for (const pending of requests) pending.cancelled = true;
        }
        const channels = this.clientChannels.get(clientId);
        const channelList = channels ? [...channels] : [];
        for (const channel of channelList) {
            const tokens = this.subscriptionTokens.get(channel);
            tokens?.delete(clientId);
            if (tokens?.size === 0) this.subscriptionTokens.delete(channel);
            const members = this.channelMembers.get(channel);
            if (members) {
                members.delete(clientId);
                if (members.size === 0) this.channelMembers.delete(channel);
            }
        }
        this.clientChannels.delete(clientId);
        if (channelList.length > 0) {
            for (const plugin of this.plugins) {
                if (plugin.onDisconnect) {
                    firePlugin(plugin.name, () => plugin.onDisconnect!({ clientId, channels: channelList }));
                }
            }
        }
    }
}
