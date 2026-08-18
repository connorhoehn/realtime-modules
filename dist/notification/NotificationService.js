"use strict";
// realtime-modules/src/notification/NotificationService.ts
//
// Gateway-side NOTIFICATION service — the server half of the
// realtime-modules `useNotifications` hook (a beta hook that, until now, had
// no server emitting its frames).
//
// SCOPE / SHAPE
// ────────────────────────────────────────────────────────────────────────
// Notifications are USER-scoped, not channel-scoped: a notification is
// delivered to EVERY live connection (tab/session) of a user, regardless of
// which channel each tab has open. This mirrors CallService's user-to-user
// routing — we resolve the user's clientIds via
// `messageRouter.getClientsByUserId` and `sendToClient` each one
// (cross-node routing is transparent inside the router).
//
// WIRE CONTRACT (ground truth: realtime-modules useNotifications.ts:9-21)
// The hook listens for exactly three inbound frame `type`s:
//
//   { type:'notification:new',         service:'notification',
//     payload:{ id,type,title,body?,timestamp,read?,channel?,payload?,action? } }
//   { type:'notification:read',        service:'notification', payload:{ id } }
//   { type:'notification:bulk-update', service:'notification',
//     payload:{ notifications:[...] } }
//
// INBOUND ACTIONS (this service registers under {service:'notification'}):
//   { service:'notification', action:'markRead',    id }   → persist + echo
//                                                             notification:read
//                                                             to other tabs
//   { service:'notification', action:'markAllRead' }       → persist all +
//                                                             echo per id
//   { service:'notification', action:'getHistory' }        → bulk-update reply
//                                                             to the asking tab
//
// REPLAY-ON-CONNECT: server.ts calls `replayUnreadForUser(clientId, userId)`
// after the session is established; we send that one tab a
// `notification:bulk-update` carrying the user's unread set so a freshly
// loaded inbox is populated without a round-trip.
//
// PRODUCER SURFACE: `notifyUser(userId, input)` is the in-process API other
// gateway services call. The authed HTTP `POST /api/notify` route
// (notify-route.ts) is a thin wrapper over it so platform-api / operators
// can push notifications without an in-process import.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const crypto_1 = require("crypto");
const RedisNotificationStore_1 = require("./RedisNotificationStore");
class NotificationService {
    messageRouter;
    logger;
    store;
    constructor(opts) {
        if (!opts || !opts.messageRouter) {
            throw new Error('NotificationService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('NotificationService: logger is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.store =
            opts.store ??
                new RedisNotificationStore_1.RedisNotificationStore({
                    redisClient: opts.redisClient ?? null,
                    logger: opts.logger,
                });
    }
    // ──────────────────────────────────────────────────────────────────
    // Producer API — in-process surface other services / the HTTP route call.
    // ──────────────────────────────────────────────────────────────────
    /**
     * Publish a notification to a user. Persists it (Redis) then delivers a
     * `notification:new` frame to every live connection of that user.
     * Returns the stored record (with the server-assigned id/timestamp) and
     * the number of live connections it reached. Never throws — delivery
     * failures are logged.
     */
    async notifyUser(userId, input) {
        if (!userId || typeof userId !== 'string') {
            throw new Error('notifyUser: userId is required');
        }
        if (!input || typeof input.title !== 'string' || !input.title) {
            throw new Error('notifyUser: input.title is required');
        }
        const record = {
            id: typeof input.id === 'string' && input.id ? input.id : (0, crypto_1.randomUUID)(),
            type: input.type ?? 'system',
            title: input.title,
            timestamp: typeof input.timestamp === 'string' && input.timestamp
                ? input.timestamp
                : new Date().toISOString(),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.read !== undefined ? { read: input.read } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.payload !== undefined ? { payload: input.payload } : {}),
            ...(input.action !== undefined ? { action: input.action } : {}),
        };
        // Persist first so a late-connecting tab still sees it via replay even
        // if delivery races the persist. Best-effort (never throws).
        await this.store.append(userId, record);
        const frame = {
            type: 'notification:new',
            service: 'notification',
            payload: record,
        };
        const delivered = await this.deliverToUser(userId, frame);
        this.logger.debug?.('[notification] notifyUser delivered', {
            userId,
            id: record.id,
            type: record.type,
            delivered,
        });
        return { record, delivered };
    }
    // ──────────────────────────────────────────────────────────────────
    // Inbound WS dispatch — server.ts calls handleAction(clientId, action, data)
    // ──────────────────────────────────────────────────────────────────
    async handleAction(clientId, action, data) {
        const userId = this.resolveUserId(clientId, data);
        if (!userId) {
            this.logger.warn('[notification] action with no resolvable userId', {
                clientId,
                action,
            });
            this.sendErrorToClient(clientId, 'NO_USER_CONTEXT', 'No user context for notification action');
            return;
        }
        switch (action) {
            case 'markRead':
                return this.handleMarkRead(userId, data);
            case 'markAllRead':
                return this.handleMarkAllRead(userId);
            case 'getHistory':
                return this.handleGetHistory(clientId, userId);
            default:
                this.logger.warn('[notification] unknown action', { clientId, action });
                this.sendErrorToClient(clientId, 'UNKNOWN_ACTION', `Unknown notification action: ${action}`);
        }
    }
    async handleMarkRead(userId, data) {
        const id = typeof data?.id === 'string' ? data.id : null;
        if (!id) {
            this.logger.warn('[notification] markRead missing id', { userId });
            return;
        }
        await this.store.markRead(userId, id);
        // Echo to ALL of the user's tabs (including the sender, which is
        // harmless — the hook treats notification:read idempotently). This
        // keeps every open inbox in sync the moment one tab dismisses an item.
        const frame = {
            type: 'notification:read',
            service: 'notification',
            payload: { id },
        };
        await this.deliverToUser(userId, frame);
    }
    async handleMarkAllRead(userId) {
        const ids = await this.store.markAllRead(userId);
        // Echo one notification:read per id to every tab. (The hook has no
        // bulk "all read" frame, so we fan out per-id — matches how the hook's
        // own markAllRead mutates each entry.)
        for (const id of ids) {
            const frame = {
                type: 'notification:read',
                service: 'notification',
                payload: { id },
            };
            await this.deliverToUser(userId, frame);
        }
        this.logger.debug?.('[notification] markAllRead', { userId, count: ids.length });
    }
    async handleGetHistory(clientId, userId) {
        const notifications = await this.store.list(userId);
        const frame = {
            type: 'notification:bulk-update',
            service: 'notification',
            payload: { notifications },
        };
        await Promise.resolve(this.messageRouter.sendToClient(clientId, frame));
    }
    // ──────────────────────────────────────────────────────────────────
    // Replay-on-connect — server.ts calls this after session establishment.
    // ──────────────────────────────────────────────────────────────────
    /**
     * Send the just-connected tab its UNREAD notification set as a single
     * `notification:bulk-update` frame. Scoped to ONE clientId (the new tab),
     * not fanned out — the user's other tabs already have their state.
     * Best-effort; no-op when the user has no unread items.
     */
    async replayUnreadForUser(clientId, userId) {
        if (!clientId || !userId)
            return;
        try {
            const notifications = await this.store.listUnread(userId);
            if (notifications.length === 0)
                return;
            const frame = {
                type: 'notification:bulk-update',
                service: 'notification',
                payload: { notifications },
            };
            await Promise.resolve(this.messageRouter.sendToClient(clientId, frame));
            this.logger.info('[notification] replayed unread set on connect', {
                clientId,
                userId,
                count: notifications.length,
            });
        }
        catch (err) {
            this.logger.warn('[notification] replayUnreadForUser failed', {
                clientId,
                userId,
                errorMessage: err?.message ?? String(err),
            });
        }
    }
    // ──────────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────────
    /**
     * Resolve every live clientId for `userId` and deliver `frame` to each.
     * Returns the count of clients we attempted delivery to. We pass '' as
     * the exclude so ALL of the user's tabs receive it — a notification
     * targets the user, not a peer, so there's no sender to exclude here
     * (markRead echoes deliberately include the originating tab).
     */
    async deliverToUser(userId, frame) {
        let matches = [];
        try {
            const res = await Promise.resolve(this.messageRouter.getClientsByUserId([userId], ''));
            matches = Array.isArray(res) ? res : [];
        }
        catch (err) {
            this.logger.warn('[notification] getClientsByUserId failed', {
                userId,
                errorMessage: err?.message ?? String(err),
            });
            return 0;
        }
        const isLive = typeof this.messageRouter.isClientLive === 'function'
            ? this.messageRouter.isClientLive.bind(this.messageRouter)
            : null;
        let attempted = 0;
        for (const m of matches) {
            // Three-state liveness: false = dead-local (skip), true/null =
            // deliver (null means peer-node — let sendToClient route it).
            if (isLive && isLive(m.clientId) === false)
                continue;
            attempted++;
            try {
                await Promise.resolve(this.messageRouter.sendToClient(m.clientId, frame));
            }
            catch (err) {
                this.logger.warn('[notification] sendToClient failed', {
                    userId,
                    clientId: m.clientId,
                    errorMessage: err?.message ?? String(err),
                });
            }
        }
        return attempted;
    }
    /**
     * Resolve the authed userId for an inbound action. The router's reverse
     * lookup (`getUserIdForClient`, cross-node-aware) is AUTHORITATIVE and
     * checked first — a client-supplied `data.userId` is spoofable, so it's
     * only a fallback for test harnesses / routers that don't expose the
     * reverse lookup. This prevents one user from marking another's
     * notifications read.
     */
    resolveUserId(clientId, data) {
        const router = this.messageRouter;
        // When the router exposes the authoritative reverse lookup, it is the
        // ONLY source of truth — a null result means the client is not
        // authenticated and the action is rejected. We deliberately do NOT
        // fall through to the client-supplied `data.userId` here: doing so
        // would let an unauthenticated socket spoof any identity by simply
        // including a userId in the frame.
        if (typeof router.getUserIdForClient === 'function') {
            const u = router.getUserIdForClient(clientId);
            return typeof u === 'string' && u ? u : null;
        }
        // Router without a reverse lookup (test harnesses / minimal routers):
        // fall back to a client-supplied userId. Production always wires the
        // real MessageRouter, which has getUserIdForClient.
        if (typeof data?.userId === 'string' && data.userId)
            return data.userId;
        return null;
    }
    sendErrorToClient(clientId, code, message) {
        try {
            void Promise.resolve(this.messageRouter.sendToClient(clientId, {
                type: 'error',
                service: 'notification',
                code,
                message,
                timestamp: new Date().toISOString(),
            }));
        }
        catch {
            /* best-effort */
        }
    }
}
exports.NotificationService = NotificationService;
//# sourceMappingURL=NotificationService.js.map