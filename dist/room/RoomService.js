"use strict";
// realtime-modules/src/room/RoomService.ts
//
// Slug-addressed room occupancy WS service.
//
// SCOPE — this is not a call, not a channel, not a doc collab room.
// It's a thin, per-slug membership tracker that:
//
//   - accepts `subscribe`/`unsubscribe` to per-room member events
//     (member-joined / member-left)
//   - accepts `subscribe-index`/`unsubscribe-index` for the aggregated
//     occupancy-delta stream (used by sidebar / index page)
//   - fans out member-joined / member-left to per-room subscribers
//   - aggregates and debounces (default 500ms) per-room deltas into a
//     single `occupancy-delta` frame sent to index subscribers
//   - replicates via cross-node pub/sub so subscribers on any replica
//     see consistent occupancy
//
// Membership ingress (W3): callers (CallService for `room:*` lobbies,
// or eventually platform-api via HMAC HTTP) invoke
// `handleMemberJoined` / `handleMemberLeft` directly. The WS action
// surface (`subscribe` etc.) is read-only — clients can observe rooms
// but cannot directly assert membership over WS.
//
// Mirrors CallService's shape: options-bag constructor, narrow
// MessageRouter contract, optional state-store + pubsub seams, an
// `onClientDisconnect` hook the server wires through its disconnect
// loop, and a `shutdown`/`dispose` pair.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomService = void 0;
const types_1 = require("./types");
// Metrics are an injected seam (RoomServiceOptions.metrics) — this library
// has no observability layer of its own; hooks default to no-ops.
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_MEMBERS_PER_DELTA = 50;
// Short-lived cache for occupancy reads (audit #8). Hot callers like WS
// heartbeat handlers can poll getRoomOccupancyCount / getRoomMembers
// many times per second; a small TTL coalesces those into one Redis hit
// without making the count meaningfully stale (presence churn is on the
// order of seconds, not milliseconds).
const DEFAULT_OCCUPANCY_CACHE_TTL_MS = 250;
/**
 * Derive an org label for the prometheus room metrics from a room slug.
 *
 * The room layer is org-agnostic — slugs are assigned by platform-api and
 * carry no structural org prefix today. To keep label cardinality bounded
 * AND useful, we use a simple convention: if the slug looks like
 * `<orgId>:<rest>` we split on the first colon and treat the prefix as
 * the orgId; otherwise we fall back to `default-org`. This matches the
 * existing `DEFAULT_ORG_ID = 'default-org'` convention in
 * platform-api/src/routes/hangoutRooms.ts.
 */
function deriveOrgFromSlug(slug) {
    if (!slug)
        return 'default-org';
    const i = slug.indexOf(':');
    if (i > 0 && i < slug.length - 1) {
        const prefix = slug.slice(0, i);
        if (/^[a-zA-Z0-9_-]+$/.test(prefix))
            return prefix;
    }
    return 'default-org';
}
class RoomService {
    messageRouter;
    logger;
    stateStore;
    crossNodePubSub;
    crossNodeUnsubscribe = null;
    nodeId;
    metricsHooks;
    occupancyDebounceMs;
    maxMembersPerDelta;
    occupancyCacheTtlMs;
    /** Local per-room membership cache. Per-node only — peer-node members
     *  are reflected in RoomStateStore (Redis) and surfaced via
     *  `listMembers(slug)` reads on demand for index snapshots. Kept as a
     *  fast write path + single-node fallback when no state-store is
     *  wired. Reads (getRoomOccupancyCount / getRoomMembers) prefer the
     *  state-store for cluster-wide truth — see audit #8. */
    activeRooms = new Map();
    /** Reverse index: which rooms is each LOCAL client a member of. */
    clientToRooms = new Map();
    /** Per-slug occupancy read cache: short-TTL'd memo of the last
     *  state-store result. Keeps WS-heartbeat-rate callers from beating
     *  on Redis. Cleared on local mutation so writers see their own
     *  effects without waiting for the TTL. */
    occupancyCache = new Map();
    /** Per-slug subscriber sets. */
    roomSubscribers = new Map();
    /** Reverse index — which slugs each clientId is subscribed to. */
    clientToSubscriptions = new Map();
    /** rooms:index subscriber set. */
    indexSubscribers = new Set();
    /** Pending occupancy changes awaiting the next debounce flush. Slug
     *  is the map key so a flurry of joins/leaves for the same room
     *  collapses to a single entry. */
    pendingDeltas = new Set();
    debounceTimer = null;
    constructor(opts) {
        if (!opts || !opts.messageRouter) {
            throw new Error('RoomService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('RoomService: logger is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.stateStore = opts.stateStore ?? null;
        this.crossNodePubSub = opts.crossNodePubSub ?? null;
        this.nodeId = opts.nodeId ?? null;
        this.metricsHooks = opts.metrics ?? {};
        const config = opts.config ?? {};
        this.occupancyDebounceMs = config.occupancyDebounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.maxMembersPerDelta = config.maxMembersPerDelta ?? DEFAULT_MAX_MEMBERS_PER_DELTA;
        this.occupancyCacheTtlMs = config.occupancyCacheTtlMs ?? DEFAULT_OCCUPANCY_CACHE_TTL_MS;
        // Subscribe to cross-node room events. Peer nodes publish their
        // local member-joined/member-left; we mirror into our own
        // subscriber fan-out so a client on this node sees a member on
        // another node join their subscribed room in real time.
        if (this.crossNodePubSub) {
            this.crossNodeUnsubscribe = this.crossNodePubSub.subscribe(types_1.CROSS_NODE_ROOM_TOPIC, (payload) => {
                try {
                    const evt = JSON.parse(payload);
                    void this.handleCrossNodeEvent(evt);
                }
                catch (e) {
                    this.logger.warn(`[RoomService] malformed cross-node payload: ${e?.message ?? e}`);
                }
            });
        }
    }
    /** Stop the cross-node subscription + flush any pending debounce.
     *  Called on shutdown so the timer doesn't keep the event loop alive. */
    async dispose() {
        if (this.crossNodeUnsubscribe) {
            try {
                this.crossNodeUnsubscribe();
            }
            catch { /* */ }
            this.crossNodeUnsubscribe = null;
        }
        if (this.debounceTimer) {
            try {
                clearTimeout(this.debounceTimer);
            }
            catch { /* */ }
            this.debounceTimer = null;
        }
        this.pendingDeltas.clear();
        this.occupancyCache.clear();
    }
    /** Server invokes shutdown on every service; alias to dispose. */
    async shutdown() {
        return this.dispose();
    }
    // -----------------------------------------------------------------
    // WS action surface
    // -----------------------------------------------------------------
    async handleAction(clientId, action, data) {
        try {
            if (!types_1.ALLOWED_ROOM_ACTIONS.has(action)) {
                this.sendError(clientId, `Unknown room action: ${action}`);
                return;
            }
            const typedAction = action;
            const payload = data ?? {};
            switch (typedAction) {
                case 'subscribe-index':
                    await this.handleSubscribeIndex(clientId);
                    return;
                case 'unsubscribe-index':
                    this.handleUnsubscribeIndex(clientId);
                    return;
                case 'subscribe': {
                    const slug = typeof payload.slug === 'string' ? payload.slug : '';
                    if (!slug) {
                        this.sendError(clientId, 'slug is required on subscribe');
                        return;
                    }
                    this.handleSubscribe(clientId, slug);
                    return;
                }
                case 'unsubscribe': {
                    const slug = typeof payload.slug === 'string' ? payload.slug : '';
                    if (!slug) {
                        this.sendError(clientId, 'slug is required on unsubscribe');
                        return;
                    }
                    this.handleUnsubscribe(clientId, slug);
                    return;
                }
                case 'join': {
                    // WS-driven room join — records membership + bumps
                    // `room_member_joined_total`. Used by clients that hit
                    // the REST /api/rooms/:slug/join endpoint and then need
                    // the gateway to record the membership for occupancy
                    // delta fan-out. Fields userId / displayName / participantId
                    // are lifted from the WS userContext if absent on the
                    // payload (the typical browser case where the FE has no
                    // reason to echo back its own identity).
                    const slug = typeof payload.slug === 'string' ? payload.slug : '';
                    if (!slug) {
                        this.sendError(clientId, 'slug is required on join');
                        return;
                    }
                    const clientData = this.messageRouter.getClientData?.(clientId);
                    const userCtx = clientData?.userContext;
                    const participantId = typeof payload.participantId === 'string'
                        ? payload.participantId
                        : clientId;
                    const userId = typeof payload.userId === 'string'
                        ? payload.userId
                        : (userCtx?.userId ?? clientId);
                    const displayName = typeof payload.displayName === 'string'
                        ? payload.displayName
                        : (userCtx?.displayName ?? userId);
                    await this.handleMemberJoined(slug, userId, clientId, participantId, displayName);
                    return;
                }
                case 'leave': {
                    const slug = typeof payload.slug === 'string' ? payload.slug : '';
                    if (!slug) {
                        this.sendError(clientId, 'slug is required on leave');
                        return;
                    }
                    const clientData2 = this.messageRouter.getClientData?.(clientId);
                    const userId = typeof payload.userId === 'string'
                        ? payload.userId
                        : (clientData2?.userContext?.userId ?? clientId);
                    await this.handleMemberLeft(slug, userId, clientId, 'explicit');
                    return;
                }
            }
        }
        catch (error) {
            this.logger.error(`Error handling room action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
    }
    async handleSubscribeIndex(clientId) {
        this.indexSubscribers.add(clientId);
        // Initial snapshot. Prefer state-store (cluster-wide); fall back
        // to local Maps when no store wired.
        const snapshot = await this.collectFullSnapshot();
        const envelope = {
            type: 'room',
            action: 'occupancy-delta',
            data: { deltas: snapshot },
            timestamp: new Date().toISOString(),
        };
        try {
            await Promise.resolve(this.messageRouter.sendToClient(clientId, envelope));
        }
        catch (e) {
            this.logger.warn(`[RoomService] initial snapshot send failed for ${clientId}: ${e?.message ?? e}`);
        }
    }
    handleUnsubscribeIndex(clientId) {
        this.indexSubscribers.delete(clientId);
    }
    handleSubscribe(clientId, slug) {
        let subs = this.roomSubscribers.get(slug);
        if (!subs) {
            subs = new Set();
            this.roomSubscribers.set(slug, subs);
        }
        subs.add(clientId);
        let mine = this.clientToSubscriptions.get(clientId);
        if (!mine) {
            mine = new Set();
            this.clientToSubscriptions.set(clientId, mine);
        }
        mine.add(slug);
    }
    handleUnsubscribe(clientId, slug) {
        const subs = this.roomSubscribers.get(slug);
        if (subs) {
            subs.delete(clientId);
            if (subs.size === 0)
                this.roomSubscribers.delete(slug);
        }
        const mine = this.clientToSubscriptions.get(clientId);
        if (mine) {
            mine.delete(slug);
            if (mine.size === 0)
                this.clientToSubscriptions.delete(clientId);
        }
    }
    // -----------------------------------------------------------------
    // Membership mutations (called by CallService bridge + future HTTP)
    // -----------------------------------------------------------------
    /**
     * Record that a user joined a room. Idempotent on (slug, clientId).
     * Fans out `member-joined` to per-room subscribers and schedules a
     * debounced occupancy-delta for index subscribers. Replicates to
     * peer nodes via cross-node pubsub when wired.
     */
    async handleMemberJoined(slug, userId, clientId, participantId, displayName) {
        if (!slug || !clientId)
            return;
        let room = this.activeRooms.get(slug);
        if (!room) {
            room = new Map();
            this.activeRooms.set(slug, room);
        }
        const already = room.has(clientId);
        room.set(clientId, { clientId, userId, displayName, participantId });
        // Metric + structured log. Only emit on a genuinely new arrival to
        // match the per-room fan-out gate further down — repeated
        // participant-state envelopes from the same client must not
        // double-count joins. Org is best-effort derived from the slug.
        if (!already) {
            try {
                this.metricsHooks.recordMemberJoined?.(deriveOrgFromSlug(slug));
            }
            catch { /* */ }
            const count = room.size;
            this.logger.info('[room] member joined', { slug, userId, clientId, participantId, roomCount: count });
        }
        let mine = this.clientToRooms.get(clientId);
        if (!mine) {
            mine = new Set();
            this.clientToRooms.set(clientId, mine);
        }
        mine.add(slug);
        if (this.stateStore) {
            try {
                await this.stateStore.addMember(slug, clientId, userId, displayName, participantId);
            }
            catch (e) {
                this.logger.warn(`[RoomService] stateStore.addMember failed for ${slug}/${clientId}: ${e?.message ?? e}`);
            }
        }
        // Invalidate the occupancy read cache for this slug so the next
        // getRoomOccupancyCount / getRoomMembers caller sees the write.
        this.occupancyCache.delete(slug);
        // Per-room fan-out — only when this is a genuinely new arrival
        // for (slug, clientId). Repeated `participant-state` envelopes
        // from the same client shouldn't re-trigger `member-joined`.
        if (!already) {
            const envelope = {
                type: 'room',
                action: 'member-joined',
                data: { slug, userId, displayName, participantId },
                timestamp: new Date().toISOString(),
            };
            await this.fanOutToRoomSubscribers(slug, envelope, /* exclude */ null);
            this.schedulePendingDelta(slug);
            // Cross-node replicate so peer subscribers see this too.
            if (this.crossNodePubSub) {
                try {
                    const payload = {
                        verb: 'member-joined',
                        slug,
                        clientId,
                        userId,
                        displayName,
                        participantId,
                        sourceNodeId: this.nodeId ?? undefined,
                    };
                    await Promise.resolve(this.crossNodePubSub.publish(types_1.CROSS_NODE_ROOM_TOPIC, JSON.stringify(payload)));
                }
                catch (e) {
                    this.logger.warn(`[RoomService] cross-node publish failed for member-joined ${slug}/${clientId}: ${e?.message ?? e}`);
                }
            }
        }
    }
    /**
     * Record that a user left a room. Idempotent. Fans out `member-left`
     * to per-room subscribers and schedules a debounced occupancy-delta.
     *
     * `reason` distinguishes the leave path for observability:
     *   - 'explicit'   — user-status:'left' (or any direct caller-driven leave)
     *   - 'disconnect' — server's disconnect cleanup loop (WS closed)
     * Defaults to 'explicit' so existing call sites that haven't been
     * updated yet stay backwards-compatible.
     */
    async handleMemberLeft(slug, userId, clientId, reason = 'explicit') {
        if (!slug || !clientId)
            return;
        const room = this.activeRooms.get(slug);
        let removed = false;
        let remainingCount = 0;
        if (room) {
            removed = room.delete(clientId);
            remainingCount = room.size;
            if (room.size === 0)
                this.activeRooms.delete(slug);
        }
        const mine = this.clientToRooms.get(clientId);
        if (mine) {
            mine.delete(slug);
            if (mine.size === 0)
                this.clientToRooms.delete(clientId);
        }
        if (this.stateStore) {
            try {
                await this.stateStore.removeMember(slug, clientId);
            }
            catch (e) {
                this.logger.warn(`[RoomService] stateStore.removeMember failed for ${slug}/${clientId}: ${e?.message ?? e}`);
            }
        }
        // Invalidate cached occupancy for this slug — readers must not
        // see a stale "client is still here" after disconnect cleanup.
        this.occupancyCache.delete(slug);
        if (removed) {
            // Metric + structured log on actual transition (idempotent
            // re-calls for an already-departed clientId are not counted).
            try {
                this.metricsHooks.recordMemberLeft?.(deriveOrgFromSlug(slug), reason);
            }
            catch { /* */ }
            this.logger.info('[room] member left', { slug, userId, reason, remainingCount });
            const envelope = {
                type: 'room',
                action: 'member-left',
                data: { slug, userId },
                timestamp: new Date().toISOString(),
            };
            await this.fanOutToRoomSubscribers(slug, envelope, /* exclude */ null);
            this.schedulePendingDelta(slug);
            if (this.crossNodePubSub) {
                try {
                    const payload = {
                        verb: 'member-left',
                        slug,
                        clientId,
                        userId,
                        sourceNodeId: this.nodeId ?? undefined,
                    };
                    await Promise.resolve(this.crossNodePubSub.publish(types_1.CROSS_NODE_ROOM_TOPIC, JSON.stringify(payload)));
                }
                catch (e) {
                    this.logger.warn(`[RoomService] cross-node publish failed for member-left ${slug}/${clientId}: ${e?.message ?? e}`);
                }
            }
        }
    }
    /**
     * Drop a client from every room they were a member of + clear their
     * subscriptions. Called from the server's disconnect loop via the
     * `handleDisconnect` alias below.
     */
    async handleDisconnect(clientId) {
        // First — clean up subscriber state. Cheap; pure local maps.
        const subs = this.clientToSubscriptions.get(clientId);
        if (subs) {
            for (const slug of subs) {
                const set = this.roomSubscribers.get(slug);
                if (set) {
                    set.delete(clientId);
                    if (set.size === 0)
                        this.roomSubscribers.delete(slug);
                }
            }
            this.clientToSubscriptions.delete(clientId);
        }
        this.indexSubscribers.delete(clientId);
        // Then — emit member-left for every room they were a member of.
        const rooms = this.clientToRooms.get(clientId);
        if (!rooms || rooms.size === 0)
            return;
        for (const slug of Array.from(rooms)) {
            const room = this.activeRooms.get(slug);
            const entry = room?.get(clientId);
            const userId = entry?.userId ?? '';
            try {
                await this.handleMemberLeft(slug, userId, clientId, 'disconnect');
            }
            catch (e) {
                this.logger.warn(`[RoomService] handleDisconnect cleanup failed for ${slug}/${clientId}: ${e?.message ?? e}`);
            }
        }
    }
    // -----------------------------------------------------------------
    // Cross-node mirroring
    // -----------------------------------------------------------------
    async handleCrossNodeEvent(evt) {
        // Loop-suppression: ignore our own publishes.
        if (evt.sourceNodeId && this.nodeId && evt.sourceNodeId === this.nodeId)
            return;
        if (!evt.slug || !evt.clientId)
            return;
        // A peer node's mutation invalidates our cached occupancy for
        // this slug — next reader must re-query the state-store.
        this.occupancyCache.delete(evt.slug);
        if (evt.verb === 'member-joined') {
            const envelope = {
                type: 'room',
                action: 'member-joined',
                data: {
                    slug: evt.slug,
                    userId: evt.userId ?? '',
                    displayName: evt.displayName ?? '',
                    participantId: evt.participantId ?? '',
                },
                timestamp: new Date().toISOString(),
            };
            await this.fanOutToRoomSubscribers(evt.slug, envelope, /* exclude */ null);
            this.schedulePendingDelta(evt.slug);
        }
        else if (evt.verb === 'member-left') {
            const envelope = {
                type: 'room',
                action: 'member-left',
                data: { slug: evt.slug, userId: evt.userId ?? '' },
                timestamp: new Date().toISOString(),
            };
            await this.fanOutToRoomSubscribers(evt.slug, envelope, /* exclude */ null);
            this.schedulePendingDelta(evt.slug);
        }
    }
    // -----------------------------------------------------------------
    // Fan-out helpers
    // -----------------------------------------------------------------
    async fanOutToRoomSubscribers(slug, envelope, excludeClientId) {
        const subs = this.roomSubscribers.get(slug);
        if (!subs || subs.size === 0)
            return;
        for (const cid of subs) {
            if (excludeClientId && cid === excludeClientId)
                continue;
            try {
                await Promise.resolve(this.messageRouter.sendToClient(cid, envelope));
            }
            catch (e) {
                this.logger.warn(`[RoomService] room fan-out send failed for ${cid}/${slug}: ${e?.message ?? e}`);
            }
        }
    }
    schedulePendingDelta(slug) {
        this.pendingDeltas.add(slug);
        if (this.debounceTimer)
            return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.flushPendingDeltas();
        }, this.occupancyDebounceMs);
        // Don't block process exit on this timer.
        if (typeof this.debounceTimer.unref === 'function') {
            this.debounceTimer.unref();
        }
    }
    async flushPendingDeltas() {
        if (this.pendingDeltas.size === 0)
            return;
        // Set the active-room-count gauge on every flush — this is the
        // natural cadence (we already pay for the membership-mutation
        // wakeup, so piggy-back the gauge update). Prefer the
        // cluster-wide view via the state-store when wired; otherwise
        // fall back to local activeRooms map (per-node only).
        let activeCount = this.activeRooms.size;
        if (this.stateStore) {
            try {
                const rows = await this.stateStore.listAllRoomCounts();
                activeCount = rows.filter((r) => r.count > 0).length;
            }
            catch {
                // Already logged in computeOccupancyDelta path on failure;
                // fall back to local count without spamming a duplicate warn.
            }
        }
        try {
            this.metricsHooks.setActiveCount?.(activeCount);
        }
        catch { /* */ }
        if (this.indexSubscribers.size === 0) {
            // No-one listening — drop the batch so we don't accumulate work.
            // Still emit the debug log so operators see flush cadence.
            this.logger.debug('[room] occupancy delta flushed', { deltaCount: this.pendingDeltas.size, subscriberCount: 0 });
            this.pendingDeltas.clear();
            return;
        }
        const slugs = Array.from(this.pendingDeltas);
        this.pendingDeltas.clear();
        const deltas = [];
        for (const slug of slugs) {
            const delta = await this.computeOccupancyDelta(slug);
            deltas.push(delta);
        }
        if (deltas.length === 0)
            return;
        const envelope = {
            type: 'room',
            action: 'occupancy-delta',
            data: { deltas },
            timestamp: new Date().toISOString(),
        };
        for (const cid of this.indexSubscribers) {
            try {
                await Promise.resolve(this.messageRouter.sendToClient(cid, envelope));
            }
            catch (e) {
                this.logger.warn(`[RoomService] occupancy-delta send failed for ${cid}: ${e?.message ?? e}`);
            }
        }
        this.logger.debug('[room] occupancy delta flushed', { deltaCount: deltas.length, subscriberCount: this.indexSubscribers.size });
    }
    async computeOccupancyDelta(slug) {
        // Audit #8: read off the cluster-wide source via the public
        // accessor so single-node and N-node flush paths share one
        // implementation. The accessor falls back to local maps on
        // state-store error.
        const snapshots = await this.getRoomMembers(slug);
        const trimmed = snapshots.slice(0, this.maxMembersPerDelta).map((m) => ({
            userId: m.userId,
            displayName: m.displayName,
            participantId: m.participantId,
        }));
        return { slug, count: snapshots.length, members: trimmed };
    }
    // -----------------------------------------------------------------
    // Public occupancy accessors (audit #8 — cluster-wide truth)
    // -----------------------------------------------------------------
    //
    // These methods are the canonical surface for "how many people are
    // in room X". Under N>1 the local `activeRooms` map only contains
    // clients connected to THIS node; aggregating off it produces
    // per-node-only counts, which is the bug audit #8 calls out.
    //
    // RoomStateStore (Redis-backed when wired, in-memory otherwise) is
    // the authoritative source. A short-TTL'd cache absorbs hot
    // heartbeat-rate callers so we don't open a Redis round-trip on
    // every WS frame.
    //
    // Single-node behaviour is preserved: with no state-store wired,
    // these read directly off `activeRooms` and the cache is bypassed.
    /**
     * Get the current cluster-wide occupancy count for a room.
     *
     * Reads from RoomStateStore (authoritative). Falls back to the local
     * activeRooms Map if the state-store throws OR if no state-store is
     * wired (single-node deployment / tests). Result is memoised for up
     * to `occupancyCacheTtlMs` (default 250ms) to keep WS-heartbeat-rate
     * callers from hammering Redis.
     */
    async getRoomOccupancyCount(slug) {
        if (!slug)
            return 0;
        const snapshots = await this.getRoomMembers(slug);
        return snapshots.length;
    }
    /**
     * Get the full member list for a room, cluster-wide.
     *
     * Same semantics as getRoomOccupancyCount — state-store first,
     * local-map fallback, short-TTL cache. The returned array is sorted
     * by joinedAt ascending when the state-store implementation
     * supports it (both InMemoryRoomStateStore and RedisRoomStateStore
     * do today).
     */
    async getRoomMembers(slug) {
        if (!slug)
            return [];
        const now = Date.now();
        const cached = this.occupancyCache.get(slug);
        if (cached && now - cached.at < this.occupancyCacheTtlMs) {
            return cached.members;
        }
        let members = null;
        if (this.stateStore) {
            try {
                members = await this.stateStore.listMembers(slug);
            }
            catch (e) {
                this.logger.warn(`[RoomService] getRoomMembers state-store failed for ${slug}, falling back to local: ${e?.message ?? e}`);
                members = null;
            }
        }
        if (members === null) {
            // No state-store wired, or state-store threw — return the
            // local Map view. Under N>1 this is per-node only, which is
            // the documented degraded path (audit #8 fall-back).
            const room = this.activeRooms.get(slug);
            if (!room) {
                members = [];
            }
            else {
                members = Array.from(room.values()).map((m) => ({
                    clientId: m.clientId,
                    userId: m.userId,
                    displayName: m.displayName,
                    participantId: m.participantId,
                    joinedAt: 0,
                }));
            }
        }
        if (this.occupancyCacheTtlMs > 0) {
            this.occupancyCache.set(slug, { at: now, count: members.length, members });
        }
        return members;
    }
    async collectFullSnapshot() {
        if (this.stateStore) {
            try {
                const rows = await this.stateStore.listAllRoomCounts();
                return rows.map((r) => ({
                    slug: r.slug,
                    count: r.count,
                    members: r.members.slice(0, this.maxMembersPerDelta),
                }));
            }
            catch (e) {
                this.logger.warn(`[RoomService] state-store listAllRoomCounts failed, falling back to local: ${e?.message ?? e}`);
            }
        }
        const out = [];
        for (const [slug, room] of this.activeRooms) {
            if (room.size === 0)
                continue;
            const members = Array.from(room.values()).slice(0, this.maxMembersPerDelta).map((m) => ({
                userId: m.userId,
                displayName: m.displayName,
                participantId: m.participantId,
            }));
            out.push({ slug, count: room.size, members });
        }
        return out;
    }
    // -----------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------
    sendError(clientId, message) {
        if (!this.messageRouter)
            return;
        const frame = {
            type: 'error',
            service: 'room',
            message,
            timestamp: new Date().toISOString(),
        };
        try {
            this.messageRouter.sendToClient(clientId, frame);
        }
        catch { /* */ }
    }
    getStats() {
        let roomSubs = 0;
        for (const set of this.roomSubscribers.values())
            roomSubs += set.size;
        return {
            stateful: true,
            activeRooms: this.activeRooms.size,
            trackedClients: this.clientToRooms.size,
            indexSubscribers: this.indexSubscribers.size,
            roomSubscribers: roomSubs,
        };
    }
}
exports.RoomService = RoomService;
exports.default = RoomService;
//# sourceMappingURL=RoomService.js.map