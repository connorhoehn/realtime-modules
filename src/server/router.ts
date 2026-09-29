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
    onConnect?: (info: { clientId: string; channelId: string }) => void | Promise<void>;
    onDisconnect?: (info: { clientId: string; channels: string[] }) => void | Promise<void>;
    onMessage?: (info: { clientId: string; channelId: string; message: unknown }) => void | Promise<void>;
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
    sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null },
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
    /** Auth context accessor — `{ userContext }` shape services expect. */
    getClientData?(clientId: string): { userContext?: WsAuthContext } | null;
    /** Uploader/identity attribution (fileupload). */
    getUserIdForClient?(clientId: string): string | undefined;
    /** User-targeted routing (call). */
    getClientsByUserId?(userIds: string[], excludeClientId?: string): { clientId: string; userId: string }[];
    /** true = connected here, false = not connected here, null = unknown
     *  (another replica may hold it). Services use it to tell a live
     *  participant from one whose socket is gone. */
    isClientLive?(clientId: string): boolean | null;
    /** Broadcast to every connected client (call's no-target fallback). */
    broadcastToAll?(message: unknown, excludeClientId?: string): Promise<void> | void;
    /** Remove a client from all channels (disconnect path). */
    removeClient?(clientId: string): void;
    /** Transport hints some services read. */
    readonly redisAvailable?: boolean;
    readonly nodeId?: string;
}

function firePlugin(name: string, fn: () => void | Promise<void>): void {
    try {
        const r = fn();
        if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch(() => undefined);
        }
    } catch {
        /* plugin errors never propagate */
    }
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
    private handleRef: WsHandlerHandle | null = null;
    private readonly plugins: FeaturePlugin[];
    private readonly authorize: ChannelAuthorize | null;
    private readonly logger: RouterLogger;

    readonly redisAvailable = false;
    readonly nodeId = 'local';

    constructor(opts: {
        plugins?: FeaturePlugin[];
        authorize?: ChannelAuthorize;
        logger?: RouterLogger;
    } = {}) {
        this.plugins = opts.plugins ?? [];
        this.authorize = opts.authorize ?? null;
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

    sendToClient(clientId: string, message: unknown): void {
        if (!this.handleRef) return; // pre-connection, no-op
        this.handleRef.sendToClient(clientId, message as Record<string, unknown>);
    }

    sendToLocalClient(clientId: string, message: unknown): void {
        this.sendToClient(clientId, message);
    }

    async broadcastToAll(message: unknown, excludeClientId?: string): Promise<void> {
        if (!this.handleRef) return;
        for (const clientId of this.handleRef.listClients()) {
            if (clientId !== excludeClientId) this.sendToClient(clientId, message);
        }
    }

    async sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string | null,
        opts?: { skipCoalesce?: boolean; publisherClientId?: string | null },
    ): Promise<void> {
        // M3 publish authz: runs whenever a publisher is named, independent
        // of echo exclusion.
        const publisher = opts?.publisherClientId ?? null;
        if (publisher && !this.allows('publish', publisher, channel)) {
            this.logger.info(`[realtime] publish to ${channel} denied for ${publisher}`);
            return;
        }

        const senderId = publisher ?? excludeClientId ?? 'server';
        for (const plugin of this.plugins) {
            if (plugin.onMessage) {
                firePlugin(plugin.name, () =>
                    plugin.onMessage!({ clientId: senderId, channelId: channel, message }),
                );
            }
        }

        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0) return;
        for (const clientId of members) {
            if (clientId !== excludeClientId) this.sendToClient(clientId, message);
        }
    }

    // ---- authz -----------------------------------------------------------

    /** Run `authorize`; absent → allow, throwing → refuse. */
    private allows(kind: ChannelAccessKind, clientId: string, channel: string): boolean {
        if (!this.authorize) return true;
        try {
            return !!this.authorize({ kind, clientId, channel, ctx: this.ctxOf(clientId) });
        } catch (err) {
            this.logger.warn(`[realtime] authorize threw for ${kind} ${channel}; refusing`, err);
            return false;
        }
    }

    /**
     * The check every service runs before acting on a channel. On refusal
     * the client is told (AUTHZ_CHANNEL_DENIED) and false comes back.
     */
    checkChannel(kind: ChannelAccessKind, clientId: string, channel: string, opts: ChannelAccessOpts = {}): boolean {
        if (this.allows(kind, clientId, channel)) return true;
        this.logger.info(`[realtime] ${kind} to ${channel} denied for ${clientId}`);
        this.sendToClient(clientId, channelDeniedFrame({
            kind,
            channel: opts.clientChannel ?? channel,
            service: opts.service,
        }));
        return false;
    }

    // ---- membership ------------------------------------------------------

    subscribeToChannel(clientId: string, channel: string, opts?: ChannelAccessOpts): boolean {
        // M3: on false, services suppress the local subscription and the ack.
        if (!this.checkChannel('subscribe', clientId, channel, opts)) return false;

        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);

        let channels = this.clientChannels.get(clientId);
        if (!channels) {
            channels = new Set();
            this.clientChannels.set(clientId, channels);
        }
        channels.add(channel);

        for (const plugin of this.plugins) {
            if (plugin.onConnect) {
                firePlugin(plugin.name, () => plugin.onConnect!({ clientId, channelId: channel }));
            }
        }
        return true;
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
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
        const channels = this.clientChannels.get(clientId);
        const channelList = channels ? [...channels] : [];
        for (const channel of channelList) {
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
