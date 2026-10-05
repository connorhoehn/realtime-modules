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
    /** A fresh token for each admission, including a re-subscribe. */
    subscriptionTokens = new Map();
    handleRef = null;
    plugins;
    authorize;
    filterClientMessage;
    logger;
    /** In-flight admissions are cancelled by an unsubscribe/disconnect. */
    pendingSubscriptions = new Map();
    redisAvailable = false;
    nodeId = 'local';
    constructor(opts = {}) {
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
        return this.sendFiltered(clientId, message);
    }
    sendFiltered(clientId, message, stillCurrent = () => true) {
        const handle = this.handleRef;
        if (!handle)
            return false;
        if (!this.filterClientMessage)
            return stillCurrent() && handle.sendToClient(clientId, message);
        const context = this.ctxOf(clientId);
        if (!context)
            return false;
        const deliver = (filtered) => {
            if (filtered == null || this.handleRef !== handle || this.ctxOf(clientId) !== context || !stillCurrent())
                return false;
            return handle.sendToClient(clientId, filtered);
        };
        try {
            const filtered = this.filterClientMessage({ clientId, message, ctx: context });
            if (filtered && typeof filtered.then === 'function') {
                return Promise.resolve(filtered).then(deliver, () => false);
            }
            return deliver(filtered);
        }
        catch {
            return false;
        }
    }
    sendToLocalClient(clientId, message) {
        return this.sendToClient(clientId, message);
    }
    async broadcastToAll(message, excludeClientId) {
        if (!this.handleRef)
            return;
        await Promise.all(this.handleRef.listClients().filter(clientId => clientId !== excludeClientId)
            .map(clientId => this.sendToClient(clientId, message)));
    }
    async sendToChannel(channel, message, excludeClientId, opts) {
        // M3 publish authz: runs whenever a publisher is named, independent
        // of echo exclusion.
        const publisher = opts?.publisherClientId ?? null;
        const publisherContext = publisher ? this.ctxOf(publisher) : null;
        if (publisher && !(await this.allows('publish', publisher, channel))) {
            this.logger.info(`[realtime] publish to ${channel} denied for ${publisher}`);
            return;
        }
        if (publisher && this.ctxOf(publisher) !== publisherContext)
            return;
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
        await this.sendToLocalChannel(channel, message, excludeClientId);
    }
    /** Trusted peer fanout: local recipient authorization and generation
     * fences still run; origin plugins/publish hooks are not fired twice. */
    async sendToLocalChannel(channel, message, excludeClientId) {
        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0)
            return;
        // Admission is not a lasting grant. Recheck every recipient, even for
        // server-originated updates, and do not revive a subscription removed
        // while asynchronous authorization was resolving.
        await Promise.all([...members].map(async (clientId) => {
            if (clientId === excludeClientId)
                return;
            const context = this.ctxOf(clientId);
            const token = this.subscriptionTokens.get(channel)?.get(clientId);
            if (!(await this.allows('subscribe', clientId, channel)))
                return;
            if (this.ctxOf(clientId) !== context || !token || this.subscriptionTokens.get(channel)?.get(clientId) !== token)
                return;
            await this.sendFiltered(clientId, message, () => this.ctxOf(clientId) === context
                && this.subscriptionTokens.get(channel)?.get(clientId) === token);
        }));
    }
    // ---- authz -----------------------------------------------------------
    /** Preserve synchronous decisions; rejected async decisions fail closed. */
    allows(kind, clientId, channel) {
        if (!this.authorize)
            return true;
        const context = this.ctxOf(clientId);
        const handle = this.handleRef;
        try {
            const decision = this.authorize({ kind, clientId, channel, ctx: context });
            if (typeof decision === 'boolean')
                return decision;
            return Promise.resolve(decision).then(allowed => allowed === true && this.handleRef === handle && (!handle || (context !== null && this.ctxOf(clientId) === context)), err => { this.logger.warn(`[realtime] authorize rejected for ${kind} ${channel}; refusing`, err); return false; });
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
        const decision = this.allows(kind, clientId, channel);
        return typeof decision === 'boolean' ? this.channelDecision(decision, kind, clientId, channel, opts)
            : decision.then(allowed => this.channelDecision(allowed, kind, clientId, channel, opts));
    }
    channelDecision(allowed, kind, clientId, channel, opts) {
        if (allowed)
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
        const context = this.ctxOf(clientId);
        const decision = this.checkChannel('subscribe', clientId, channel, opts);
        if (typeof decision === 'boolean')
            return decision && this.addSubscription(clientId, channel);
        const pending = { cancelled: false };
        const channels = this.pendingSubscriptions.get(clientId) ?? new Map();
        const requests = channels.get(channel) ?? new Set();
        requests.add(pending);
        channels.set(channel, requests);
        this.pendingSubscriptions.set(clientId, channels);
        return decision.then(allowed => allowed && !pending.cancelled && this.ctxOf(clientId) === context && this.addSubscription(clientId, channel)).finally(() => {
            requests.delete(pending);
            if (!requests.size)
                channels.delete(channel);
            if (!channels.size)
                this.pendingSubscriptions.delete(clientId);
        });
    }
    addSubscription(clientId, channel) {
        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);
        const tokens = this.subscriptionTokens.get(channel) ?? new Map();
        tokens.set(clientId, {});
        this.subscriptionTokens.set(channel, tokens);
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
        for (const pending of this.pendingSubscriptions.get(clientId)?.get(channel) ?? [])
            pending.cancelled = true;
        const tokens = this.subscriptionTokens.get(channel);
        tokens?.delete(clientId);
        if (tokens?.size === 0)
            this.subscriptionTokens.delete(channel);
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
        for (const requests of this.pendingSubscriptions.get(clientId)?.values() ?? []) {
            for (const pending of requests)
                pending.cancelled = true;
        }
        const channels = this.clientChannels.get(clientId);
        const channelList = channels ? [...channels] : [];
        for (const channel of channelList) {
            const tokens = this.subscriptionTokens.get(channel);
            tokens?.delete(clientId);
            if (tokens?.size === 0)
                this.subscriptionTokens.delete(channel);
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