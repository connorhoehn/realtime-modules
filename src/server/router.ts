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
    subscribeToChannel?(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    /** Auth context accessor — `{ userContext }` shape services expect. */
    getClientData?(clientId: string): { userContext?: WsAuthContext } | null;
    /** Uploader/identity attribution (fileupload). */
    getUserIdForClient?(clientId: string): string | undefined;
    /** User-targeted routing (call). */
    getClientsByUserId?(userIds: string[], excludeClientId?: string): { clientId: string; userId: string }[];
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
        if (publisher && this.authorize) {
            const allowed = this.authorize({
                kind: 'publish',
                clientId: publisher,
                channel,
                ctx: this.ctxOf(publisher),
            });
            if (!allowed) {
                this.logger.info(`[realtime] publish to ${channel} denied for ${publisher}`);
                return;
            }
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

    // ---- membership ------------------------------------------------------

    subscribeToChannel(clientId: string, channel: string): boolean {
        if (this.authorize) {
            const allowed = this.authorize({
                kind: 'subscribe',
                clientId,
                channel,
                ctx: this.ctxOf(clientId),
            });
            if (!allowed) {
                this.logger.info(`[realtime] subscribe to ${channel} denied for ${clientId}`);
                return false; // M3: services suppress local sub + joined ack
            }
        }

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
