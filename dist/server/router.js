"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalRealtimeRouter = void 0;
const channelAccess_1 = require("../server-ws/channelAccess");
function firePlugin(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.catch === 'function') {
            r.catch(() => undefined);
        }
    }
    catch {
        /* plugin errors never propagate */
    }
}
/**
 * Single-process router: in-memory channel membership, identity from the WS
 * auth context, optional channel authz, plugin lifecycle hooks. The handle
 * is attached lazily (it is created after the services that hold the
 * router), so pre-connection sends are no-ops by design.
 */
class LocalRealtimeRouter {
    /** channel → Set<clientId> */
    channelMembers = new Map();
    /** clientId → Set<channel> — mirror for disconnect notification */
    clientChannels = new Map();
    handleRef = null;
    plugins;
    authorize;
    logger;
    redisAvailable = false;
    nodeId = 'local';
    constructor(opts = {}) {
        this.plugins = opts.plugins ?? [];
        this.authorize = opts.authorize ?? null;
        this.logger = opts.logger ?? {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        };
    }
    _setHandle(handle) {
        this.handleRef = handle;
    }
    // ---- identity --------------------------------------------------------
    ctxOf(clientId) {
        return this.handleRef?.getClientContext(clientId) ?? null;
    }
    getClientData(clientId) {
        const ctx = this.ctxOf(clientId);
        return ctx ? { userContext: ctx } : null;
    }
    getUserIdForClient(clientId) {
        const uid = this.ctxOf(clientId)?.userId;
        return typeof uid === 'string' && uid.length > 0 ? uid : undefined;
    }
    getClientsByUserId(userIds, excludeClientId) {
        if (!this.handleRef)
            return [];
        const wanted = new Set(userIds);
        const out = [];
        for (const clientId of this.handleRef.listClients()) {
            if (clientId === excludeClientId)
                continue;
            const uid = this.getUserIdForClient(clientId);
            if (uid && wanted.has(uid))
                out.push({ clientId, userId: uid });
        }
        return out;
    }
    /** Single process: a client not connected here is not connected. */
    isClientLive(clientId) {
        if (!this.handleRef)
            return null;
        return this.handleRef.getClientContext(clientId) != null;
    }
    // ---- sends -----------------------------------------------------------
    sendToClient(clientId, message) {
        if (!this.handleRef)
            return; // pre-connection, no-op
        this.handleRef.sendToClient(clientId, message);
    }
    sendToLocalClient(clientId, message) {
        this.sendToClient(clientId, message);
    }
    async broadcastToAll(message, excludeClientId) {
        if (!this.handleRef)
            return;
        for (const clientId of this.handleRef.listClients()) {
            if (clientId !== excludeClientId)
                this.sendToClient(clientId, message);
        }
    }
    async sendToChannel(channel, message, excludeClientId, opts) {
        // M3 publish authz: runs whenever a publisher is named, independent
        // of echo exclusion.
        const publisher = opts?.publisherClientId ?? null;
        if (publisher && !this.allows('publish', publisher, channel)) {
            this.logger.info(`[realtime] publish to ${channel} denied for ${publisher}`);
            return;
        }
        const senderClientId = publisher ?? excludeClientId ?? null;
        const senderId = senderClientId ?? 'server';
        if (this.plugins.length > 0) {
            const userId = senderClientId ? this.getUserIdForClient(senderClientId) : undefined;
            for (const plugin of this.plugins) {
                if (plugin.onMessage) {
                    firePlugin(plugin.name, () => plugin.onMessage({ clientId: senderId, channelId: channel, message, userId }));
                }
            }
        }
        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0)
            return;
        for (const clientId of members) {
            if (clientId !== excludeClientId)
                this.sendToClient(clientId, message);
        }
    }
    // ---- authz -----------------------------------------------------------
    /** Run `authorize`; absent → allow, throwing → refuse. */
    allows(kind, clientId, channel) {
        if (!this.authorize)
            return true;
        try {
            return !!this.authorize({ kind, clientId, channel, ctx: this.ctxOf(clientId) });
        }
        catch (err) {
            this.logger.warn(`[realtime] authorize threw for ${kind} ${channel}; refusing`, err);
            return false;
        }
    }
    hasChannelAuthorize() {
        return this.authorize !== null;
    }
    /**
     * The check every service runs before acting on a channel. On refusal
     * the client is told (AUTHZ_CHANNEL_DENIED) and false comes back.
     */
    checkChannel(kind, clientId, channel, opts = {}) {
        if (this.allows(kind, clientId, channel))
            return true;
        this.logger.info(`[realtime] ${kind} to ${channel} denied for ${clientId}`);
        if (opts.silent)
            return false;
        this.sendToClient(clientId, (0, channelAccess_1.channelDeniedFrame)({
            kind,
            channel: opts.clientChannel ?? channel,
            service: opts.service,
        }));
        return false;
    }
    // ---- membership ------------------------------------------------------
    subscribeToChannel(clientId, channel, opts) {
        // M3: on false, services suppress the local subscription and the ack.
        if (!this.checkChannel('subscribe', clientId, channel, opts))
            return false;
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
        const userId = this.plugins.length > 0 ? this.getUserIdForClient(clientId) : undefined;
        for (const plugin of this.plugins) {
            if (plugin.onConnect) {
                firePlugin(plugin.name, () => plugin.onConnect({ clientId, channelId: channel, userId }));
            }
        }
        return true;
    }
    unsubscribeFromChannel(clientId, channel) {
        const members = this.channelMembers.get(channel);
        if (members) {
            members.delete(clientId);
            if (members.size === 0)
                this.channelMembers.delete(channel);
        }
        const channels = this.clientChannels.get(clientId);
        if (channels) {
            channels.delete(channel);
            if (channels.size === 0) {
                this.clientChannels.delete(clientId);
                for (const plugin of this.plugins) {
                    if (plugin.onDisconnect) {
                        firePlugin(plugin.name, () => plugin.onDisconnect({ clientId, channels: [channel] }));
                    }
                }
            }
        }
    }
    removeClient(clientId) {
        const channels = this.clientChannels.get(clientId);
        const channelList = channels ? [...channels] : [];
        for (const channel of channelList) {
            const members = this.channelMembers.get(channel);
            if (members) {
                members.delete(clientId);
                if (members.size === 0)
                    this.channelMembers.delete(channel);
            }
        }
        this.clientChannels.delete(clientId);
        if (channelList.length > 0) {
            for (const plugin of this.plugins) {
                if (plugin.onDisconnect) {
                    firePlugin(plugin.name, () => plugin.onDisconnect({ clientId, channels: channelList }));
                }
            }
        }
    }
}
exports.LocalRealtimeRouter = LocalRealtimeRouter;
//# sourceMappingURL=router.js.map