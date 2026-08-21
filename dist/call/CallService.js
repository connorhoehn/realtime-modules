"use strict";
// realtime-modules/src/call/CallService.ts
//
// Lifted from gateway's src/services/call-service.ts (Wave 2 catch-up).
// SCOPE: hangout/call **invite signaling** only — the 5-event lifecycle
// (invite/accepted/declined/cancelled/ended) fanned out user-to-user
// over the existing WS connection. NO WebRTC, NO SDP, NO ICE, NO SFU
// media-plane code. The media plane lives in live-video-streaming +
// platform-api's useVideoCall path; this module is signaling only.
//
// Routing modes (both preserved byte-faithfully from the gateway original):
//
//   1. Broadcast (empty/missing targetUserIds) — fans out to every
//      connected client except the sender. Backs the original "📞 Hangout"
//      button: every other tab/session sees the banner and can opt in.
//      Sender is excluded so the initiator's own WebSocket doesn't echo;
//      OTHER tabs of the initiator still receive and filter by callerId
//      on the FE.
//
//   2. Targeted (targetUserIds populated) — delivers to every connected
//      client whose authenticated userId is in `targetUserIds`. Backs
//      both the per-row "📞" button (1-element array = 1:1 call) and the
//      multi-select group-call CTA (N-element array). Sender is still
//      excluded by passing the senderClientId through to the resolver.
//
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional (router, logger, metrics) to
//     a single CallServiceOptions bag.
//   - enforceChannelPermission interceptor coupling replaced with a
//     pluggable `authorize` hook (defaults to allow-all). Call routing
//     is direct user-to-user so there's no channel to gate.
//   - ErrorCodes / createErrorResponse import removed; CallErrorFrame
//     is the inlined minimal shape.
//   - The lazy-required `../observability/metrics` prom counter is gone;
//     consumers pass a `recordCallAction` callback through CallConfig.
//   - MetricsCollector positional arg dropped — wire the callback above
//     to whatever sink the consumer already has (prom/CloudWatch/…).
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallService = void 0;
const types_1 = require("./types");
// Tracing is an injected seam (CallServiceOptions.withSpan) rather than a
// require('distributed-core') — this library does not depend on
// distributed-core, and the gateway supplies its real withSpan at
// construction. When absent, the pass-through below runs the handler
// unwrapped with an inert span object.
const _noopSpan = { setAttribute: () => { } };
const _passthroughWithSpan = async (_name, _attrs, fn) => fn(_noopSpan);
/** Topic for cross-node disconnect notifications. Single dedicated
 *  channel keeps the topic surface minimal; the payload encodes who
 *  left and which call (when known). */
const CROSS_NODE_DEPARTED_TOPIC = 'call:client-departed';
/** P5.1 — invite dedup window. 5 seconds is long enough to catch a
 *  double-click + slow-network retry, short enough to allow a legit
 *  re-invite after a brief call-restart. */
const INVITE_DEDUP_WINDOW_MS = 5000;
const INVITE_DEDUP_MAX_ENTRIES = 10_000;
class CallService {
    static INVITE_TTL_MS = 60_000;
    static INVITE_SWEEP_INTERVAL_MS = 15_000;
    /** PR-W2.1 (completion) — write-through TTLs in SECONDS for the
     *  cluster-wide CallStateStore mirror. INVITE_TTL_SEC matches the
     *  60s wall-clock invite TTL; ACCEPTED_CALL_TTL_SEC is the 4h
     *  safety-net used for accepted calls (mirrors the Redis-store
     *  internal TTL_SECONDS so accepted calls don't get reaped mid-
     *  conversation). */
    static INVITE_TTL_SEC = 60;
    static ACCEPTED_CALL_TTL_SEC = 4 * 60 * 60;
    messageRouter;
    logger;
    authorize;
    canCallHook;
    recordCallActionHook;
    persistBindingHook;
    /** Fast local cache of active calls. PR-W2.1: still maintained
     *  per-node so handleDisconnect can find calls this client was in
     *  without a Redis SMEMBERS roundtrip. Authoritative state lives in
     *  the CallStateStore (Redis when wired); peer nodes read THAT.
     *  Local cache is a write-through view: every mutation here also
     *  mirrors to stateStore. */
    activeCalls = new Map();
    clientToCalls = new Map();
    inviteSweepTimer = null;
    /** PR-W2.1 — kept ONLY as a fallback when stateStore is null
     *  (single-node deployments without Redis). When stateStore is
     *  wired, these three are unused — stateStore.markAccepted /
     *  markRecentInvite / registerInvite carry the cluster-wide truth.
     *  Marked private + non-readonly so the existing sweep loop can still
     *  reference them in the fallback path. */
    activeInvitesByUserId = new Map();
    acceptedCallIds = new Set();
    recentInvites = new Map();
    crossNodePubSub;
    crossNodeUnsubscribe = null;
    /** W11 — durable cross-cluster store. When wired, mirrors writes
     *  to Redis so peer nodes + restarts can recover state. The local
     *  `activeCalls` Map stays as a per-node cache for fast disconnect
     *  routing — disconnect's first step is "find calls this client
     *  was in", and a local Map lookup is faster than a Redis SMEMBERS. */
    stateStore;
    /**
     * W3 — RoomService bridge. When set, `room:*` lobby participant-
     * state / user-status envelopes mirror into the room occupancy
     * tracker without requiring a separate platform-api → gateway HTTP
     * roundtrip. Optional — left null in tests + when the room service
     * isn't mounted. See server.ts wiring for the contract.
     */
    roomBridge = null;
    /**
     * W3 — dedup set of (slug|clientId) pairs already mirrored to
     * RoomService.handleMemberJoined. participant-state envelopes
     * arrive frequently (every name/screen-share change) but the
     * room-membership semantic is "joined once until disconnect/left".
     * This set ensures we call handleMemberJoined exactly once per
     * unique (slug, clientId) pair within a call lifetime.
     */
    roomMembershipMirrored = new Set();
    /**
     * PR-W2.4 — sync leadership check + skip-metric hook for the
     * invite-sweep timer.  Both are optional: when omitted the sweeper
     * runs every tick (single-node / pre-PR behaviour).  Wired by
     * server.ts from createSweeperLeader(SWEEPER_SENTINELS.CALL_INVITE)
     * + recordCleanupSkipped('call_invite', ...).
     */
    sweeperIsLeader = null;
    onSweepSkipped = null;
    _withSpan;
    constructor(opts) {
        if (!opts || !opts.messageRouter) {
            throw new Error('CallService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('CallService: logger is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.crossNodePubSub = opts.crossNodePubSub ?? null;
        this.stateStore = opts.stateStore ?? null;
        this.sweeperIsLeader = opts.sweeperIsLeader ?? null;
        this.onSweepSkipped = opts.onSweepSkipped ?? null;
        this._withSpan = opts.withSpan ?? _passthroughWithSpan;
        const config = opts.config ?? {};
        this.authorize = config.authorize ?? (() => true);
        this.canCallHook = config.canCall ?? null;
        this.recordCallActionHook = config.recordCallAction ?? null;
        this.persistBindingHook = config.persistCallBinding ?? null;
        this.inviteSweepTimer = setInterval(() => {
            // PR-W2.4 — leader gate.  When ownership is enabled and a
            // peer node owns the `__leader:call-sweep` sentinel, that
            // peer is responsible for this tick; we skip + bump the
            // skip counter.  When the hook is unwired or returns true,
            // the original tick body runs unchanged.
            if (this.sweeperIsLeader && !this.sweeperIsLeader()) {
                if (this.onSweepSkipped) {
                    try {
                        this.onSweepSkipped('not_leader');
                    }
                    catch (_e) { /* metric hook must not crash the tick */ }
                }
                return;
            }
            const now = Date.now();
            // Collect expired callIds first so we can fully forgetCall
            // them — Map mutation while iterating the index is OK for the
            // current key, but forgetCall ripples through activeCalls +
            // clientToCalls + acceptedCallIds + stateStore which is safer
            // to do after the scan.
            const expiredCallIds = new Set();
            for (const [, callIds] of this.activeInvitesByUserId) {
                for (const callId of callIds) {
                    const state = this.activeCalls.get(callId);
                    if (!state) {
                        // Index references a call we already forgot —
                        // safe to drop the stale reference.
                        callIds.delete(callId);
                        continue;
                    }
                    if (typeof state.inviteExpiresAt === 'number' && now > state.inviteExpiresAt) {
                        expiredCallIds.add(callId);
                    }
                }
            }
            for (const callId of expiredCallIds) {
                this.forgetCall(callId);
            }
            // Second pass: prune any user-index entries that ended up
            // empty (either from the orphan-drop above, or from forgetCall
            // which calls clearInviteRegistryForCall internally).
            for (const [userId, callIds] of this.activeInvitesByUserId) {
                if (callIds.size === 0)
                    this.activeInvitesByUserId.delete(userId);
            }
            // Sweep stale recentInvites dedup entries too — bounded, but
            // long-lived processes shouldn't carry hours-old timestamps.
            const dedupCutoff = now - INVITE_DEDUP_WINDOW_MS;
            for (const [k, ts] of this.recentInvites) {
                if (ts < dedupCutoff)
                    this.recentInvites.delete(k);
            }
        }, CallService.INVITE_SWEEP_INTERVAL_MS);
        if (typeof this.inviteSweepTimer.unref === 'function') {
            this.inviteSweepTimer.unref();
        }
        // Subscribe to cross-node disconnect events. When a peer node
        // detects a client drop, it publishes departed. We check our
        // OWN activeCalls for participants of that call — if we have
        // local clients in it, fire synthetic 'ended' to them.
        if (this.crossNodePubSub) {
            this.crossNodeUnsubscribe = this.crossNodePubSub.subscribe(CROSS_NODE_DEPARTED_TOPIC, (payload) => {
                try {
                    const evt = JSON.parse(payload);
                    void this.handleCrossNodeDeparted(evt);
                }
                catch (e) {
                    this.logger.warn(`[CallService] malformed cross-node departed payload: ${e?.message ?? e}`);
                }
            });
        }
    }
    /**
     * Fan-out logic for a cross-node departure. Mirrors handleDisconnect
     * but ONLY notifies our local participants — the originating node
     * already cleaned its own bookkeeping. Idempotent: if we have no
     * affected local participants, the loop is a no-op.
     *
     * PR-W2.1 (completion) — the previous implementation only consulted
     * `evt.callId` (a single callId carried in the payload). That works
     * when the origin node's local `clientToCalls` Map was correctly
     * populated, but the *whole reason* this RPC exists is to handle the
     * case where the origin lost state (cold restart, crash, peer never
     * registered the client). The fix: also probe the cluster-wide
     * reverse-index via `stateStore.getCallsForClient(departedClientId)`
     * and union the result with `evt.callId`, so we notify peers of
     * every call this client was in across the entire cluster — not just
     * the one the origin happened to remember.
     */
    async handleCrossNodeDeparted(evt) {
        // 1) Collect every callId this departed client might be in.
        //    Start with the payload's callId (origin node's local Map),
        //    then union with cluster-wide reverse-index (covers cold-
        //    restart on the origin + multi-call sessions).
        const candidateCallIds = new Set();
        if (evt.callId)
            candidateCallIds.add(evt.callId);
        if (this.stateStore && typeof this.stateStore.getCallsForClient === 'function') {
            try {
                const cluster = await this.stateStore.getCallsForClient(evt.departedClientId);
                for (const id of cluster)
                    candidateCallIds.add(id);
            }
            catch (e) {
                this.logger.warn(`[CallService] cross-node getCallsForClient lookup failed for ${evt.departedClientId}: ${e?.message ?? e}`);
            }
        }
        else if (this.stateStore && typeof this.stateStore.getCallIdsByClient === 'function') {
            // Older stub fallback: try the participant-grain reverse-index.
            try {
                const cluster = await this.stateStore.getCallIdsByClient(evt.departedClientId);
                for (const id of cluster)
                    candidateCallIds.add(id);
            }
            catch { /* best-effort */ }
        }
        // Always include any local-cache calls keyed to this departed
        // client too — covers the single-node fallback path where there's
        // no stateStore.
        const localFromMap = this.clientToCalls.get(evt.departedClientId);
        if (localFromMap) {
            for (const id of localFromMap)
                candidateCallIds.add(id);
        }
        if (candidateCallIds.size === 0)
            return;
        // 2) For each candidate callId, fan out to LOCAL live peers only.
        //    No early-exit on a single call being empty — keep iterating
        //    so a multi-call disconnect (rare but real: same tab in two
        //    lobbies) doesn't drop the second.
        let totalNotified = 0;
        for (const callId of candidateCallIds) {
            await this.notifyLocalPeersOfDeparture(callId, evt.departedClientId, evt.callerId, evt.lobbyName, evt.callContinues === true)
                .then((n) => { totalNotified += n; })
                .catch((e) => this.logger.warn(`[CallService] cross-node notify loop failed for ${callId}: ${e?.message ?? e}`));
        }
        this.logger.info(`[CallService] cross-node departure of ${evt.departedClientId} (origin hint=${evt.callId ?? '-'}) — covered ${candidateCallIds.size} call(s); notified ${totalNotified} local peer(s) total`);
    }
    /**
     * Inner per-call fan-out used by {@link handleCrossNodeDeparted}.
     * Resolves the call's participants from stateStore + local cache,
     * filters to local-live clientIds, sends synthetic `ended`, and
     * cleans local state. Returns the count of notified peers.
     */
    async notifyLocalPeersOfDeparture(callId, departedClientId, fallbackCallerId, fallbackLobbyName, callContinues = false) {
        let participantClientIds = [];
        let callerId = fallbackCallerId;
        let lobbyName = fallbackLobbyName;
        if (this.stateStore) {
            try {
                const view = await this.stateStore.getCall(callId);
                if (view) {
                    participantClientIds = view.participantClientIds.slice();
                    callerId = view.callerId || callerId;
                    lobbyName = view.lobbyName || lobbyName;
                }
            }
            catch (e) {
                this.logger.warn(`[CallService] cross-node getCall lookup failed for ${callId}: ${e?.message ?? e}`);
            }
        }
        const localState = this.activeCalls.get(callId);
        if (localState) {
            for (const cid of localState.participantClientIds) {
                if (!participantClientIds.includes(cid))
                    participantClientIds.push(cid);
            }
            callerId = localState.callerId || callerId;
            lobbyName = localState.lobbyName || lobbyName;
        }
        if (participantClientIds.length === 0)
            return 0;
        const isLive = typeof this.messageRouter.isClientLive === 'function'
            ? this.messageRouter.isClientLive.bind(this.messageRouter)
            : null;
        const localPeers = [];
        for (const cid of participantClientIds) {
            if (cid === departedClientId)
                continue;
            if (isLive) {
                const live = isLive(cid);
                if (live === true)
                    localPeers.push(cid);
            }
            else {
                if (localState?.participantClientIds.has(cid))
                    localPeers.push(cid);
            }
        }
        if (localPeers.length === 0) {
            // F1 — a continuing call must NOT be torn down just because
            // this node happens to host no other participants.
            if (localState && !callContinues)
                this.forgetCall(callId);
            if (localState && callContinues)
                localState.participantClientIds.delete(departedClientId);
            return 0;
        }
        const envelope = callContinues
            ? {
                type: 'call',
                action: 'user-status',
                data: {
                    callId,
                    callerId,
                    lobbyName,
                    status: 'left',
                    userId: null,
                    reason: 'peer-disconnected',
                },
                timestamp: new Date().toISOString(),
            }
            : {
                type: 'call',
                action: 'ended',
                data: {
                    callId,
                    callerId,
                    lobbyName,
                    reason: 'peer-disconnected',
                },
                timestamp: new Date().toISOString(),
            };
        for (const peerClientId of localPeers) {
            try {
                await Promise.resolve(this.messageRouter.sendToClient(peerClientId, envelope));
            }
            catch (e) {
                this.logger.warn(`[CallService] cross-node notify failed for peer ${peerClientId} of call ${callId}: ${e?.message ?? e}`);
            }
        }
        if (callContinues) {
            if (localState)
                localState.participantClientIds.delete(departedClientId);
        }
        else {
            this.forgetCall(callId);
        }
        return localPeers.length;
    }
    /** Stop the cross-node subscription. Called on service shutdown. */
    async dispose() {
        if (this.crossNodeUnsubscribe) {
            try {
                this.crossNodeUnsubscribe();
            }
            catch { /* ignore */ }
            this.crossNodeUnsubscribe = null;
        }
        if (this.inviteSweepTimer) {
            try {
                clearInterval(this.inviteSweepTimer);
            }
            catch { /* ignore */ }
            this.inviteSweepTimer = null;
        }
    }
    /** Alias for {@link dispose}. The server's shutdown loop invokes
     *  `service.shutdown` on every registered service; without this
     *  alias the cross-node subscription leaked across hot reloads. */
    async shutdown() {
        return this.dispose();
    }
    /**
     * W3 — wire the RoomService bridge. Called once at boot (after both
     * services are constructed). Permits invite-less registration of
     * room membership when a participant-state / user-status envelope
     * arrives for a `room:*` lobby. Without this bridge, room occupancy
     * would have to flow through platform-api → gateway HTTP, which is
     * the long-term design but adds a service hop W3 doesn't need yet.
     *
     * Idempotent: re-calling replaces the bridge (useful for hot
     * reload + test reuse).
     */
    setRoomBridge(bridge) {
        this.roomBridge = bridge;
    }
    /**
     * Track a client's participation in a call. Idempotent — repeated
     * registrations are safe. State entry is created lazily on first
     * touch (typically `invite`) so we don't allocate for envelopes that
     * never identify a callId.
     *
     * PR-W2.1 (completion) — write-through cache. Every local Map write
     * here mirrors to the cluster-wide CallStateStore so peer nodes' WS
     * disconnect path can find this call via `getCallsForClient`. The
     * mirror is fire-and-forget: a Redis hiccup must not block invite
     * routing, and the local Maps are the source of truth FOR THIS NODE
     * (peer nodes consult the store for cross-node visibility). The
     * write-through TTL matches the call lifetime — 60s for an open
     * invite, refreshed to 4h once accepted.
     */
    registerParticipant(callId, clientId, callerId, lobbyName, targetUserIds) {
        let state = this.activeCalls.get(callId);
        if (!state) {
            state = { callerId, lobbyName, targetUserIds, participantClientIds: new Set() };
            this.activeCalls.set(callId, state);
        }
        state.participantClientIds.add(clientId);
        let calls = this.clientToCalls.get(clientId);
        if (!calls) {
            calls = new Set();
            this.clientToCalls.set(clientId, calls);
        }
        calls.add(callId);
        // W11 — mirror to durable store so peer nodes can read this
        // participant. Fire-and-forget: Redis hiccup shouldn't block
        // call routing. Local Map writes above are the source of truth
        // for THIS node; the store is for cross-node visibility.
        if (this.stateStore) {
            void this.stateStore.registerParticipant(callId, clientId, callerId, lobbyName, targetUserIds)
                .catch((e) => this.logger.warn(`[CallService] stateStore.register failed for ${callId}/${clientId}: ${e?.message ?? e}`));
            // PR-W2.1 (completion) — also mirror via the explicit
            // addClientToCall API so peer nodes can query
            // getCallsForClient on disconnect without first needing to
            // know the callId. registerParticipant above already covers
            // the same key (`client:calls:<clientId>`) but exposing this
            // path keeps the write-through invariant explicit and
            // testable, AND covers in-memory stub implementations that
            // don't mirror clientToCalls inside registerParticipant.
            if (typeof this.stateStore.addClientToCall === 'function') {
                const ttl = this.acceptedCallIds.has(callId)
                    ? CallService.ACCEPTED_CALL_TTL_SEC
                    : CallService.INVITE_TTL_SEC;
                void this.stateStore.addClientToCall(clientId, callId, ttl)
                    .catch((e) => this.logger.warn(`[CallService] stateStore.addClientToCall failed for ${clientId}/${callId}: ${e?.message ?? e}`));
            }
        }
    }
    /** Forget a call entirely — used on terminal `ended`/`declined`.
     *  PR-W2.1 (completion) — also clears the cluster-wide reverse-
     *  index via `removeClientFromCall` per participant. The
     *  stateStore.forgetCall path already handles this internally for
     *  participants in the call's HASH+SET, but going through the
     *  explicit API ensures in-memory stub implementations that don't
     *  share that internal state still get cleaned. */
    forgetCall(callId) {
        const state = this.activeCalls.get(callId);
        if (!state)
            return;
        const departedParticipants = Array.from(state.participantClientIds);
        for (const cid of departedParticipants) {
            const calls = this.clientToCalls.get(cid);
            if (calls) {
                calls.delete(callId);
                if (calls.size === 0)
                    this.clientToCalls.delete(cid);
            }
        }
        this.activeCalls.delete(callId);
        this.acceptedCallIds.delete(callId);
        this.clearInviteRegistryForCall(callId);
        void this.clearInviteRegistryForCallStore(callId);
        // W11 — mirror to durable store.
        if (this.stateStore) {
            void this.stateStore.forgetCall(callId)
                .catch((e) => this.logger.warn(`[CallService] stateStore.forgetCall failed for ${callId}: ${e?.message ?? e}`));
            if (typeof this.stateStore.removeClientFromCall === 'function') {
                for (const cid of departedParticipants) {
                    void this.stateStore.removeClientFromCall(cid, callId)
                        .catch((e) => this.logger.warn(`[CallService] stateStore.removeClientFromCall failed for ${cid}/${callId}: ${e?.message ?? e}`));
                }
            }
        }
    }
    clearInviteRegistryForCall(callId) {
        // Local fallback path — still maintained for the no-stateStore
        // case. When stateStore is wired, the cluster-wide clear happens
        // via clearInviteForUser per target (see clearInviteRegistryForCallStore).
        for (const [userId, callIds] of this.activeInvitesByUserId) {
            if (callIds.delete(callId) && callIds.size === 0) {
                this.activeInvitesByUserId.delete(userId);
            }
        }
    }
    /** PR-W2.1 — cluster-wide clear of the per-user invite registry.
     *  We don't keep a reverse callId→userIds index in Redis (would
     *  triple the writes); instead we use the call's targetUserIds
     *  captured at invite time, which is what the registry was indexed
     *  by in the first place. Best-effort. */
    async clearInviteRegistryForCallStore(callId) {
        if (!this.stateStore || typeof this.stateStore.clearInviteForUser !== 'function')
            return;
        const state = this.activeCalls.get(callId);
        const targets = state?.originalTargetUserIds ?? state?.targetUserIds ?? [];
        for (const userId of targets) {
            try {
                await this.stateStore.clearInviteForUser(userId, callId);
            }
            catch { /* */ }
        }
    }
    /** PR-W2.1 — local fallback for the recent-invite dedup window.
     *  Mirrors the original Map-based behaviour for when stateStore is
     *  null. Returns true if this is the first invite seen for callId in
     *  the window, false on duplicate. */
    checkRecentInviteLocal(callId) {
        const now = Date.now();
        const lastSeen = this.recentInvites.get(callId);
        if (lastSeen && (now - lastSeen) < INVITE_DEDUP_WINDOW_MS)
            return false;
        this.recentInvites.set(callId, now);
        // Cheap pruning: when over the bound, drop the expired entries.
        if (this.recentInvites.size > INVITE_DEDUP_MAX_ENTRIES) {
            const cutoff = now - INVITE_DEDUP_WINDOW_MS;
            for (const [k, ts] of this.recentInvites) {
                if (ts < cutoff)
                    this.recentInvites.delete(k);
            }
        }
        return true;
    }
    async replayActiveInvitesForUser(clientId, userId) {
        // PR-W2.1 — pull the candidate callIds from stateStore when
        // wired (cluster-wide truth), otherwise from the local Map.
        let callIds = [];
        if (this.stateStore && typeof this.stateStore.getActiveInvitesForUser === 'function') {
            try {
                callIds = await this.stateStore.getActiveInvitesForUser(userId);
            }
            catch (e) {
                this.logger.warn(`[CallService] getActiveInvitesForUser failed for ${userId}: ${e?.message ?? e}`);
            }
        }
        if (callIds.length === 0) {
            const local = this.activeInvitesByUserId.get(userId);
            if (local && local.size > 0)
                callIds = Array.from(local);
        }
        if (callIds.length === 0)
            return;
        const now = Date.now();
        let replayed = 0;
        for (const callId of callIds) {
            // Prefer local cache for the full ActiveCallState (carries the
            // original lobby name + callerName fields). Fall back to
            // stateStore when local cache is cold (peer-owned invite).
            let state = this.activeCalls.get(callId) ?? null;
            if (!state && this.stateStore) {
                try {
                    const view = await this.stateStore.getCall(callId);
                    if (view) {
                        state = {
                            callerId: view.callerId,
                            lobbyName: view.lobbyName,
                            targetUserIds: view.targetUserIds,
                            participantClientIds: new Set(view.participantClientIds),
                            invitedAt: view.invitedAt ?? undefined,
                            originalCallerName: view.callerName ?? undefined,
                            originalLobbyName: view.lobbyName,
                            originalTargetUserIds: view.targetUserIds,
                        };
                    }
                }
                catch { /* */ }
            }
            if (!state) {
                // Stale user-index reference; drop it.
                const localSet = this.activeInvitesByUserId.get(userId);
                if (localSet)
                    localSet.delete(callId);
                if (this.stateStore && typeof this.stateStore.clearInviteForUser === 'function') {
                    try {
                        await this.stateStore.clearInviteForUser(userId, callId);
                    }
                    catch { /* */ }
                }
                continue;
            }
            if (typeof state.inviteExpiresAt === 'number' && now > state.inviteExpiresAt) {
                // Fully forget — covers all participants' indexes + the
                // call entry + acceptedCallIds + stateStore mirror.
                this.forgetCall(callId);
                continue;
            }
            const data = {
                callId,
                callerId: state.callerId,
                lobbyName: state.originalLobbyName ?? state.lobbyName,
                targetUserIds: state.originalTargetUserIds ?? state.targetUserIds,
                replayed: true,
                originalTimestamp: typeof state.invitedAt === 'number' ? new Date(state.invitedAt).toISOString() : undefined,
            };
            if (state.originalCallerName) {
                data.callerName = state.originalCallerName;
            }
            const envelope = {
                type: 'call',
                action: 'invite',
                data,
                timestamp: new Date().toISOString(),
            };
            try {
                await Promise.resolve(this.messageRouter.sendToClient(clientId, envelope));
                replayed += 1;
            }
            catch (e) {
                this.logger.warn(`[CallService] replay invite send failed for clientId=${clientId} callId=${callId}: ${e?.message ?? e}`);
            }
        }
        const remainLocal = this.activeInvitesByUserId.get(userId);
        if (remainLocal && remainLocal.size === 0)
            this.activeInvitesByUserId.delete(userId);
        this.logger.info(`[CallService] replayed ${replayed} invites to clientId=${clientId} userId=${userId}`);
    }
    /**
     * F3 (2026-08-21) — answer a `status` query: "is there an active call
     * in this lobby?" Reply goes to the sender only, as an `active-call`
     * envelope. Resolution order: local activeCalls cache (fast path,
     * covers single-node), then the stateStore lobby index (cluster-wide,
     * liveness-filtered through getCall).
     */
    async handleStatusQuery(clientId, payload) {
        const lobbyName = typeof payload.lobbyName === 'string' ? payload.lobbyName : '';
        if (!lobbyName) {
            this.sendError(clientId, 'lobbyName is required on status');
            return;
        }
        const now = Date.now();
        // Ghost-call guard: call state has a 4h safety TTL, so a call whose
        // every participant crashed away (specs, tab kills) lingers in the
        // registries long after anyone can be joined. Liveness-filter
        // participants through the router's three-state isClientLive
        // (true=live, false=dead-local, null=unknown/cross-node → trust);
        // a call with zero surviving participants is NOT active.
        const liveParticipants = (ids) => {
            if (typeof this.messageRouter.isClientLive !== 'function')
                return ids;
            return ids.filter((cid) => this.messageRouter.isClientLive(cid) !== false);
        };
        let foundCallId = null;
        let callerId = '';
        let callerName = null;
        let startedAt = null;
        let participantClientIds = [];
        let targetUserIds = [];
        // Local cache first. Skip expired unaccepted invites — they are
        // dead air even if the sweep timer hasn't reaped them yet.
        for (const [id, state] of this.activeCalls) {
            if (state.lobbyName !== lobbyName && state.originalLobbyName !== lobbyName)
                continue;
            if (typeof state.inviteExpiresAt === 'number'
                && now > state.inviteExpiresAt
                && !this.acceptedCallIds.has(id))
                continue;
            const alive = liveParticipants(Array.from(state.participantClientIds));
            if (alive.length === 0)
                continue;
            foundCallId = id;
            callerId = state.callerId;
            callerName = state.originalCallerName ?? null;
            startedAt = state.invitedAt ?? null;
            participantClientIds = alive;
            targetUserIds = (state.originalTargetUserIds ?? state.targetUserIds).slice();
            break;
        }
        // Cluster-wide fallback via the lobby index.
        if (!foundCallId && this.stateStore && typeof this.stateStore.getCallIdsByLobby === 'function') {
            try {
                const ids = await this.stateStore.getCallIdsByLobby(lobbyName);
                for (const id of ids) {
                    const view = await this.stateStore.getCall(id);
                    if (!view)
                        continue;
                    const alive = liveParticipants(view.participantClientIds);
                    if (alive.length === 0)
                        continue;
                    foundCallId = id;
                    callerId = view.callerId;
                    callerName = view.callerName ?? null;
                    startedAt = view.invitedAt ?? null;
                    participantClientIds = alive;
                    targetUserIds = view.targetUserIds.slice();
                    break;
                }
            }
            catch (e) {
                this.logger.warn(`[CallService] status lobby lookup failed for ${lobbyName}: ${e?.message ?? e}`);
            }
        }
        const data = { lobbyName, active: !!foundCallId };
        if (foundCallId) {
            // Best-effort participant userIds: reverse-map live clientIds
            // (local router knowledge), fall back to caller + invitees.
            const userIds = new Set();
            if (typeof this.messageRouter.getUserIdForClient === 'function') {
                for (const cid of participantClientIds) {
                    try {
                        const uid = await Promise.resolve(this.messageRouter.getUserIdForClient(cid));
                        if (uid)
                            userIds.add(uid);
                    }
                    catch { /* */ }
                }
            }
            if (userIds.size === 0) {
                if (callerId)
                    userIds.add(callerId);
                for (const uid of targetUserIds)
                    if (uid)
                        userIds.add(uid);
            }
            data.callId = foundCallId;
            data.callerId = callerId;
            if (callerName)
                data.callerName = callerName;
            if (typeof startedAt === 'number' && startedAt > 0) {
                data.startedAt = new Date(startedAt).toISOString();
            }
            data.participantCount = participantClientIds.length;
            data.participantUserIds = Array.from(userIds);
        }
        const envelope = {
            type: 'call',
            action: 'active-call',
            data: data,
            timestamp: new Date().toISOString(),
        };
        try {
            await Promise.resolve(this.messageRouter.sendToClient(clientId, envelope));
        }
        catch (e) {
            this.logger.warn(`[CallService] active-call reply failed for ${clientId}: ${e?.message ?? e}`);
        }
    }
    async handleAction(clientId, action, data) {
        // Wrap the whole action in a per-verb span so the trace UI shows
        // `call.invite` / `call.accepted` / etc. rather than just a single
        // generic `ws.message.dispatch` span. Inner Redis / peer-fan-out /
        // stateStore operations inherit this span and stitch cleanly under it.
        // The error log on the catch path also gets the same span context.
        return this._withSpan(`call.${action}`, {
            'rpc.method': 'handleAction',
            'call.action': String(action),
            'client.id': String(clientId),
            'call.id': String((data && data.callId) ?? ''),
            'call.lobby_name': String((data && data.lobbyName) ?? ''),
        }, async (span) => {
            try {
                if (!types_1.ALLOWED_CALL_ACTIONS.has(action)) {
                    span.setAttribute('call.outcome', 'unknown_action');
                    this.sendError(clientId, `Unknown call action: ${action}`);
                    return;
                }
                const typedAction = action;
                if (!this.authorize(clientId, typedAction, data ?? {})) {
                    span.setAttribute('call.outcome', 'unauthorized');
                    this.sendError(clientId, `Not authorized for call action: ${typedAction}`);
                    return;
                }
                await this.handleCallEvent(clientId, typedAction, data);
                span.setAttribute('call.outcome', 'ok');
            }
            catch (error) {
                span.setAttribute('call.outcome', 'error');
                // Replace the bare `logger.error(msg, error)` call: the
                // CallLogger contract is `error(msg, error?)` where the
                // second arg is the error object. Surfacing callId +
                // lobbyName + action lets an operator grep the log for
                // a specific failed invite without correlating clientId
                // → callId across multiple lines.
                this.logger.error('[CallService] handleAction failed', {
                    clientId,
                    action,
                    callId: (data && data.callId) ?? null,
                    lobbyName: (data && data.lobbyName) ?? null,
                    errorMessage: error && error.message ? error.message : String(error),
                });
                this.sendError(clientId, 'Internal server error');
            }
        }, { tracerName: 'gateway' });
    }
    async handleCallEvent(clientId, action, data) {
        // Envelope tolerance (2026-08-21): accept BOTH the flat shape the
        // frontend sends ({service:'call', action, callId, lobbyName, ...})
        // and the nested shape ({service:'call', action, data:{callId,...}})
        // that raw WS clients (e2e harness, external integrators) use.
        // Before this, nested invites silently failed the callId/lobbyName
        // requirement with an error frame most callers never read — every
        // invite-driven e2e journey died at step one.
        let payload = data ?? {};
        const nested = payload.data;
        if (payload.callId == null && payload.lobbyName == null
            && nested && typeof nested === 'object' && !Array.isArray(nested)) {
            payload = { ...nested, ...payload };
        }
        const callId = payload.callId;
        const lobbyName = payload.lobbyName;
        // Normalize routing targets — accept either `targetUserIds: string[]`
        // (preferred) or legacy `targetUserId: string`. Empty/missing = broadcast.
        const targetUserIds = this.normalizeTargetUserIds(payload);
        if (action === 'invite' && (!callId || !lobbyName)) {
            this.sendError(clientId, 'callId and lobbyName are required on invite');
            return;
        }
        // F3 (2026-08-21) — `status` is a query, not a signaling verb:
        // reply to the SENDER ONLY with an `active-call` envelope and
        // stop. Lets a freshly-connected client (never invited, or
        // reconnecting after a refresh) discover an in-progress call in
        // a lobby before deciding to join.
        if (action === 'status') {
            await this.handleStatusQuery(clientId, payload);
            return;
        }
        // W3 — RoomService bridge. participant-state + user-status are
        // the only call verbs that fire inside a live session (invite/
        // accepted/declined/cancelled/ended are signaling-edge events).
        // For lobbies whose name starts with `room:`, treat the first
        // such envelope per (slug, clientId) as a "member joined room"
        // and a user-status: 'left' envelope as "member left room". This
        // is the W3 substitute for a HMAC-signed platform-api → gateway
        // HTTP endpoint; it works without any cross-service plumbing
        // because the FE is already sending these envelopes for the
        // grid-tile + presence sidebar features.
        if (this.roomBridge
            && typeof lobbyName === 'string'
            && lobbyName.startsWith('room:')
            && (action === 'participant-state' || action === 'user-status')) {
            const slug = lobbyName.slice('room:'.length);
            if (slug) {
                const state = (0, types_1.isParticipantStateBroadcast)(payload) ? payload : {};
                const userId = typeof state.callerId === 'string' ? state.callerId : '';
                const participantId = typeof state.participantId === 'string' ? state.participantId : '';
                const displayName = typeof state.displayName === 'string'
                    ? state.displayName
                    : (typeof state.callerName === 'string' ? state.callerName : '');
                const dedupKey = `${slug}|${clientId}`;
                const userStatus = typeof state.status === 'string' ? state.status : null;
                if (action === 'user-status' && userStatus === 'left') {
                    if (this.roomMembershipMirrored.delete(dedupKey)) {
                        try {
                            await Promise.resolve(this.roomBridge.handleMemberLeft(slug, userId, clientId));
                        }
                        catch (e) {
                            this.logger.warn(`[CallService→Room] handleMemberLeft failed for ${slug}/${clientId}: ${e?.message ?? e}`);
                        }
                    }
                }
                else if (action === 'participant-state' && !participantId) {
                    // Room bridge requires participantId to seed occupancy correctly.
                    // Without it, RoomService indexes the wrong user and the grid drifts.
                    this.logger.warn(`[CallService→Room] participant-state for room:${slug} missing participantId — skipping handleMemberJoined for ${clientId}`);
                }
                else if (!this.roomMembershipMirrored.has(dedupKey)) {
                    this.roomMembershipMirrored.add(dedupKey);
                    try {
                        await Promise.resolve(this.roomBridge.handleMemberJoined(slug, userId, clientId, participantId, displayName));
                    }
                    catch (e) {
                        this.logger.warn(`[CallService→Room] handleMemberJoined failed for ${slug}/${clientId}: ${e?.message ?? e}`);
                    }
                }
            }
        }
        // P5.1 — dedup duplicate invites within a 5s window. Same callId
        // arriving twice = slow double-click or WS retry; suppress so
        // receivers don't re-ring. PR-W2.1: this check is now cluster-wide
        // via CallStateStore.markRecentInvite (SETNX with TTL). Falls back
        // to the in-memory Map when stateStore is null or doesn't
        // implement the dedup op.
        if (action === 'invite' && callId) {
            let isFirstInvite = true;
            const windowSec = Math.ceil(INVITE_DEDUP_WINDOW_MS / 1000);
            if (this.stateStore && typeof this.stateStore.markRecentInvite === 'function') {
                try {
                    isFirstInvite = await this.stateStore.markRecentInvite(callId, windowSec);
                }
                catch (e) {
                    this.logger.warn(`[CallService] markRecentInvite failed for ${callId}: ${e?.message ?? e} — falling back to local dedup`);
                    isFirstInvite = this.checkRecentInviteLocal(callId);
                }
            }
            else {
                isFirstInvite = this.checkRecentInviteLocal(callId);
            }
            if (!isFirstInvite) {
                let wouldHaveBeenRecipients = 0;
                if (targetUserIds.length > 0) {
                    try {
                        const recipients = await this.findClientsForUsers(targetUserIds, clientId);
                        wouldHaveBeenRecipients = recipients.length;
                    }
                    catch {
                        /* ignore lookup failure — diagnostic only */
                    }
                }
                this.logger.info(`[CallService] suppressing duplicate invite for callId=${callId} (wouldHaveBeenRecipients=${wouldHaveBeenRecipients})`);
                return;
            }
        }
        // P0 — cross-user policy gate. invite ONLY (decline/ended don't
        // need this; the original invite's policy applies). authorize
        // above already confirmed callerId matches the authed userId,
        // so we can trust callerId for the policy lookup.
        if (action === 'invite' && this.canCallHook) {
            const callerForPolicy = typeof payload.callerId === 'string' ? payload.callerId : '';
            try {
                const allowed = await Promise.resolve(this.canCallHook(callerForPolicy, targetUserIds));
                this.logger.debug(`[CallService.canCall] check { caller: ${callerForPolicy}, targets: [${targetUserIds.join(', ')}], result: ${allowed} }`);
                if (!allowed) {
                    this.logger.warn(`[CallService.canCall] DENIED invite from ${callerForPolicy} to [${targetUserIds.join(', ') || 'broadcast'}]`);
                    this.sendError(clientId, 'Not authorized to call those users');
                    return;
                }
            }
            catch (e) {
                this.logger.error(`[CallService.canCall] policy check threw — denying invite as fail-closed: ${e?.message ?? e}`);
                this.sendError(clientId, 'Authorization check failed');
                return;
            }
        }
        // Track participation so handleDisconnect can fire synthetic
        // `ended` to peers if this client drops uncleanly.
        const callerId = typeof payload.callerId === 'string' ? payload.callerId : '';
        const wasFirstAccepted = action === 'accepted' && !!callId && !this.acceptedCallIds.has(callId);
        // PR-W2.1 (completion) — relax the historical
        // `callId && lobbyName` gate for `accepted`. Real FE accept
        // envelopes routinely carry only { callId, callerId,
        // targetUserIds } — no lobbyName. That gap left the accepter
        // unregistered in the cluster-wide CallStateStore, so when the
        // original caller disconnected from a peer node the cross-node
        // fan-out couldn't find the accepter as a peer to notify. We
        // now hydrate lobbyName from local cache / stateStore on
        // accept, falling back to '' when neither is available. `invite`
        // still requires lobbyName (enforced earlier via sendError).
        let resolvedLobbyName = lobbyName ?? '';
        if (action === 'accepted' && callId && !resolvedLobbyName) {
            const local = this.activeCalls.get(callId);
            if (local?.lobbyName) {
                resolvedLobbyName = local.lobbyName;
            }
            else if (this.stateStore) {
                try {
                    const view = await this.stateStore.getCall(callId);
                    if (view?.lobbyName)
                        resolvedLobbyName = view.lobbyName;
                }
                catch { /* */ }
            }
        }
        const shouldRegister = !!callId && ((action === 'invite' && !!lobbyName)
            || action === 'accepted');
        if (shouldRegister) {
            this.registerParticipant(callId, clientId, callerId, resolvedLobbyName, targetUserIds);
            // F2/F3 — durable discovery indexes, fire-and-forget. The
            // userId index is what survives a page refresh (new tab =
            // new clientId, so the clientId reverse-index misses); the
            // lobby index powers the `status` query for non-invitees.
            if (this.stateStore) {
                let senderUserId = action === 'invite' ? callerId : '';
                if (!senderUserId && typeof this.messageRouter.getUserIdForClient === 'function') {
                    try {
                        senderUserId = (await Promise.resolve(this.messageRouter.getUserIdForClient(clientId))) ?? '';
                    }
                    catch { /* best-effort */ }
                }
                if (senderUserId && typeof this.stateStore.registerUserCall === 'function') {
                    void this.stateStore.registerUserCall(senderUserId, callId, CallService.ACCEPTED_CALL_TTL_SEC)
                        .catch((e) => this.logger.warn(`[CallService] registerUserCall failed for ${senderUserId}/${callId}: ${e?.message ?? e}`));
                }
                if (resolvedLobbyName && typeof this.stateStore.registerLobbyCall === 'function') {
                    void this.stateStore.registerLobbyCall(resolvedLobbyName, callId, CallService.ACCEPTED_CALL_TTL_SEC)
                        .catch((e) => this.logger.warn(`[CallService] registerLobbyCall failed for ${resolvedLobbyName}/${callId}: ${e?.message ?? e}`));
                }
            }
            if (action === 'invite') {
                const state = this.activeCalls.get(callId);
                if (state) {
                    const now = Date.now();
                    state.invitedAt = now;
                    state.inviteExpiresAt = now + CallService.INVITE_TTL_MS;
                    state.originalTargetUserIds = targetUserIds.slice();
                    if (typeof payload.callerName === 'string') {
                        state.originalCallerName = payload.callerName;
                    }
                    state.originalLobbyName = lobbyName;
                }
                // W12 — mirror invitedAt + callerName to the durable store
                // so the GET /api/calls/active resume endpoint has a
                // wall-clock startedAt for the dialog's live timer and a
                // friendly caller label for the prompt body. Fire-and-forget
                // (Redis hiccup shouldn't block invite routing).
                if (this.stateStore && typeof this.stateStore.setInviteMetadata === 'function') {
                    const callerNameRaw = typeof payload.callerName === 'string' ? payload.callerName : '';
                    const meta = {
                        invitedAt: state?.invitedAt ?? Date.now(),
                    };
                    if (callerNameRaw.length)
                        meta.callerName = callerNameRaw;
                    void this.stateStore.setInviteMetadata(callId, meta)
                        .catch((e) => this.logger.warn(`[CallService] stateStore.setInviteMetadata failed for ${callId}: ${e?.message ?? e}`));
                }
                for (const targetUserId of targetUserIds) {
                    let set = this.activeInvitesByUserId.get(targetUserId);
                    if (!set) {
                        set = new Set();
                        this.activeInvitesByUserId.set(targetUserId, set);
                    }
                    set.add(callId);
                    // PR-W2.1 (completion) — mirror per-user invite
                    // registry into the cluster-wide store so peer
                    // nodes' replay-on-reconnect can see it. Fire-and-
                    // forget: a Redis hiccup must not block invite fan-
                    // out (in-memory map above still handles the local-
                    // tab replay even if Redis is unreachable).
                    if (this.stateStore && typeof this.stateStore.registerInvite === 'function') {
                        const expiresAtMs = state?.inviteExpiresAt ?? (Date.now() + CallService.INVITE_TTL_MS);
                        void this.stateStore.registerInvite(targetUserId, callId, expiresAtMs)
                            .catch((e) => this.logger.warn(`[CallService] stateStore.registerInvite failed for ${targetUserId}/${callId}: ${e?.message ?? e}`));
                    }
                }
                // PR-W2.1 (completion) — authoritative setCall mirror.
                // registerParticipant already wrote individual fields
                // via HSETNX; setCall is the explicit "here's the full
                // resolved view" overwrite so a peer node reading getCall
                // on a cross-node-departed event sees the lobby + caller
                // name even if HSETNX raced.
                if (state && this.stateStore && typeof this.stateStore.setCall === 'function') {
                    const view = {
                        callerId: state.callerId,
                        lobbyName: state.lobbyName,
                        targetUserIds: state.originalTargetUserIds ?? state.targetUserIds,
                        participantClientIds: Array.from(state.participantClientIds),
                        invitedAt: state.invitedAt ?? null,
                        callerName: state.originalCallerName ?? null,
                    };
                    void this.stateStore.setCall(callId, view, CallService.INVITE_TTL_SEC)
                        .catch((e) => this.logger.warn(`[CallService] stateStore.setCall failed for ${callId}: ${e?.message ?? e}`));
                }
            }
            // Persist call→session binding so the recording.completed
            // webhook (downstream) can resolve channelArn → callId.
            // Fire-and-forget — DDB write failure shouldn't block routing.
            if (this.persistBindingHook) {
                void Promise.resolve(this.persistBindingHook({
                    callId: callId, callerId, lobbyName: resolvedLobbyName, clientId, action: action,
                })).catch((e) => {
                    this.logger.warn(`[CallService] persistCallBinding failed for ${action} callId=${callId}: ${e?.message ?? e}`);
                });
            }
        }
        // Bug fix: `accepted` bookkeeping must NOT be gated on lobbyName.
        // FE accepted payloads commonly carry only { callId, callerId } —
        // gating clearInviteRegistryForCall on lobbyName left receivers'
        // ringers + replay registry stuck after a successful accept.
        if (action === 'accepted' && callId && wasFirstAccepted) {
            this.acceptedCallIds.add(callId);
            this.clearInviteRegistryForCall(callId);
            void this.clearInviteRegistryForCallStore(callId);
            // PR-W2.1 (completion) — cluster-wide accept dedup so a
            // racing accepted on a peer node doesn't trigger duplicate
            // "answered elsewhere" prompts. SETNX with the accepted
            // call's 4h safety TTL.
            if (this.stateStore && typeof this.stateStore.markAccepted === 'function') {
                void this.stateStore.markAccepted(callId, CallService.ACCEPTED_CALL_TTL_SEC)
                    .catch((e) => this.logger.warn(`[CallService] stateStore.markAccepted failed for ${callId}: ${e?.message ?? e}`));
            }
        }
        if (callId && (action === 'ended' || action === 'declined' || action === 'cancelled')) {
            this.clearInviteRegistryForCall(callId);
            void this.clearInviteRegistryForCallStore(callId);
            // Drop this client from the call; if it was the last
            // participant, forget the call entirely.
            const state = this.activeCalls.get(callId);
            if (state) {
                state.participantClientIds.delete(clientId);
                const cs = this.clientToCalls.get(clientId);
                if (cs) {
                    cs.delete(callId);
                    if (cs.size === 0)
                        this.clientToCalls.delete(clientId);
                }
                if (state.participantClientIds.size === 0)
                    this.activeCalls.delete(callId);
            }
            // W11 — mirror to durable store. Fire-and-forget.
            if (this.stateStore) {
                void this.stateStore.removeParticipant(callId, clientId)
                    .catch((e) => this.logger.warn(`[CallService] stateStore.removeParticipant failed for ${callId}/${clientId}: ${e?.message ?? e}`));
            }
        }
        const envelope = {
            type: 'call',
            action,
            data: payload,
            timestamp: new Date().toISOString(),
        };
        if (targetUserIds.length > 0) {
            const recipients = await this.findClientsForUsers(targetUserIds, /* excludeClientId */ clientId);
            const planned = recipients.length;
            // Promise.allSettled — never short-circuit on a single send failure.
            // sendToClient itself returns false on a closed socket and may throw
            // (sync OR async) when the publish path errors; either way we count
            // this as a delivery failure and keep going. The wrapper converts a
            // synchronous throw into a rejected promise so allSettled can
            // observe it without aborting the whole map.
            const results = await Promise.allSettled(recipients.map((targetClientId) => {
                try {
                    return Promise.resolve(this.messageRouter.sendToClient(targetClientId, envelope));
                }
                catch (err) {
                    return Promise.reject(err);
                }
            }));
            let delivered = 0;
            const failures = [];
            results.forEach((result, idx) => {
                const targetClientId = recipients[idx];
                if (result.status === 'fulfilled' && result.value !== false) {
                    delivered += 1;
                }
                else {
                    const reason = result.status === 'rejected'
                        ? (result.reason && result.reason.message) || String(result.reason)
                        : 'sendToClient returned false';
                    failures.push({ targetClientId, reason });
                }
            });
            const deliveryLogMsg = `[CallService] delivery { action: ${action}, callId: ${callId ?? '-'}, delivered: ${delivered}, planned: ${planned}, failures: ${failures.length} }`;
            const deliveryLogMeta = {
                action,
                callId: callId ?? null,
                delivered,
                planned,
                failures: failures.length,
                failureDetail: failures,
                failedClientIds: failures.map((f) => f.targetClientId),
            };
            if (planned > delivered) {
                // Stale entries in the userId→clientIds index, peer-node
                // ghosts, or sockets that closed between the liveness probe
                // and the send. Promote to WARN with the failed clientIds
                // so operators can correlate to which user-mapping leaked
                // (per-incident debugging without grepping `failureDetail`).
                this.logger.warn(deliveryLogMsg, deliveryLogMeta);
            }
            else {
                this.logger.info(deliveryLogMsg, deliveryLogMeta);
            }
            this.recordCallActionMetric(action, 'targeted');
            // P5.2 — when a callee accepts on tab 1, the original
            // routing above delivered `accepted` to the caller's tabs.
            // Sibling tabs of the ACCEPTER (tabs 2, 3 of the callee)
            // also need to know so they can dismiss their incoming-
            // call banner. Look up the accepter's authed userId from
            // the sending clientId and fan to their other clients.
            if (action === 'accepted' && typeof this.messageRouter.getUserIdForClient === 'function') {
                const accepterUserId = this.messageRouter.getUserIdForClient(clientId);
                if (accepterUserId && typeof this.messageRouter.getClientsByUserId === 'function') {
                    try {
                        const siblingMatches = await Promise.resolve(this.messageRouter.getClientsByUserId([accepterUserId], clientId));
                        const siblingIds = Array.isArray(siblingMatches)
                            ? siblingMatches.map((m) => m.clientId)
                            : [];
                        for (const sibId of siblingIds) {
                            try {
                                await Promise.resolve(this.messageRouter.sendToClient(sibId, envelope));
                            }
                            catch (e) {
                                this.logger.warn(`[CallService] sibling accepted fan-out failed for ${sibId}: ${e?.message ?? e}`);
                            }
                        }
                        if (siblingIds.length > 0) {
                            this.logger.info(`[CallService] fanned accepted to ${siblingIds.length} sibling tab(s) of ${accepterUserId}`);
                        }
                    }
                    catch (e) {
                        this.logger.warn(`[CallService] sibling lookup failed: ${e?.message ?? e}`);
                    }
                }
            }
            return;
        }
        // Broadcast path — everyone except the sender.
        await this.messageRouter.broadcastToAll(envelope, clientId);
        this.logger.info(`Client ${clientId} broadcast call event '${action}' (callId=${callId ?? '-'} lobby=${lobbyName ?? '-'})`);
        this.recordCallActionMetric(action, 'broadcast');
    }
    /**
     * Pull the target user-id list out of a call payload. Returns a deduped
     * array — empty means the call should be broadcast.
     */
    normalizeTargetUserIds(payload) {
        const out = new Set();
        if (Array.isArray(payload.targetUserIds)) {
            for (const id of payload.targetUserIds) {
                if (typeof id === 'string' && id.length)
                    out.add(id);
            }
        }
        return Array.from(out);
    }
    /**
     * Return the clientIds of every connected client authenticated as any of
     * the provided userIds, excluding the sender. Delegates to MessageRouter's
     * `getClientsByUserId` seam — that method is now Redis-backed and async,
     * so this helper is async too. Cross-node routing happens transparently
     * inside `messageRouter.sendToClient(clientId, ...)`.
     */
    async findClientsForUsers(userIds, excludeClientId) {
        if (!this.messageRouter || typeof this.messageRouter.getClientsByUserId !== 'function') {
            return [];
        }
        const matches = await Promise.resolve(this.messageRouter.getClientsByUserId(userIds, excludeClientId));
        if (!Array.isArray(matches))
            return [];
        // Liveness pre-filter — when the router exposes isClientLive,
        // drop any clientId whose local socket is NOT in OPEN readyState
        // BEFORE we try to deliver. Skipping these avoids inflating the
        // failure counter on sockets we already know are dead and stops
        // ringing tabs that crashed without their close handler firing.
        // Three-state contract: true=live, false=dead-local, null=not-
        // local (peer node or stale Redis index entry — we cannot tell
        // sync, so trust it and let sendToClient route cross-node).
        const isLive = typeof this.messageRouter.isClientLive === 'function'
            ? this.messageRouter.isClientLive.bind(this.messageRouter)
            : null;
        const filtered = [];
        const dropped = [];
        for (const m of matches) {
            if (isLive) {
                const live = isLive(m.clientId);
                if (live === false) {
                    dropped.push(m.clientId);
                    continue;
                }
            }
            filtered.push(m.clientId);
        }
        if (dropped.length > 0) {
            this.logger.warn(`[CallService] findClientsForUsers dropped ${dropped.length} non-OPEN local client(s): [${dropped.join(', ')}]`);
        }
        // Return the legacy `string[]` shape (clientIds only) — this is the
        // contract every existing call site expects.
        return filtered;
    }
    /**
     * Fire the optional recordCallAction hook. Wrapped in try/catch so a
     * misbehaving consumer sink can never break call routing.
     */
    recordCallActionMetric(action, targetKind) {
        if (!this.recordCallActionHook)
            return;
        try {
            this.recordCallActionHook(action, targetKind);
        }
        catch (_e) {
            /* metrics are optional — fail open */
        }
    }
    /**
     * On WS disconnect, fire synthetic `ended` envelopes to every other
     * participant of any call this client was in. Without this, peers'
     * overlays would freeze on the last frame until they hang up
     * manually. Best-effort: failures to deliver are logged, not retried.
     */
    async handleDisconnect(clientId) {
        // W3 — drop any room-membership dedup entries for this client.
        // RoomService has its own `handleDisconnect` (wired via the
        // services map) that handles the actual member-left fan-out;
        // here we only need to clean our local mirroring bookkeeping
        // so reconnects don't get treated as already-joined.
        if (this.roomMembershipMirrored.size > 0) {
            const suffix = `|${clientId}`;
            for (const key of this.roomMembershipMirrored) {
                if (key.endsWith(suffix))
                    this.roomMembershipMirrored.delete(key);
            }
        }
        // PR-W2.1 (completion) — union the local reverse-index with the
        // cluster-wide one. After a hot restart the local Map is cold;
        // without the stateStore fallback we'd skip cleanup + cross-
        // node fan-out entirely for any call the client had previously
        // accepted on a now-restarted node.
        const callIdSet = new Set();
        const localSet = this.clientToCalls.get(clientId);
        if (localSet)
            for (const id of localSet)
                callIdSet.add(id);
        if (this.stateStore && typeof this.stateStore.getCallsForClient === 'function') {
            try {
                const cluster = await this.stateStore.getCallsForClient(clientId);
                for (const id of cluster)
                    callIdSet.add(id);
            }
            catch (e) {
                this.logger.warn(`[CallService] handleDisconnect getCallsForClient failed for ${clientId}: ${e?.message ?? e}`);
            }
        }
        if (callIdSet.size === 0)
            return;
        for (const callId of callIdSet) {
            const state = this.activeCalls.get(callId);
            // PR-W2.1 (completion) — when local cache is cold (cluster-
            // only entry from getCallsForClient), still publish the
            // cross-node departure + clean stateStore. The peer-node
            // handleCrossNodeDeparted will notify its own local peers.
            let callerIdForPayload = '';
            let lobbyNameForPayload = '';
            // F1 (2026-08-21) — participant-grain departure. The previous
            // implementation unconditionally broadcast a synthetic `ended`
            // and forgetCall()'d the whole call for EVERY disconnect: in a
            // 3-person call the first person to drop (or refresh!) deleted
            // server state for everyone and kicked every surviving peer.
            // Compute how many participants remain (cluster view preferred,
            // local cache fallback) and only tear the call down when the
            // departure leaves <=1 participant — otherwise the survivors
            // get a `user-status: left` and the call lives on, which is
            // what multi-party calls and refresh-rejoin both require.
            let remainingAfterDeparture = 0;
            if (this.stateStore) {
                try {
                    const view = await this.stateStore.getCall(callId);
                    if (view) {
                        remainingAfterDeparture = view.participantClientIds
                            .filter((cid) => cid !== clientId).length;
                        callerIdForPayload = view.callerId || callerIdForPayload;
                        lobbyNameForPayload = view.lobbyName || lobbyNameForPayload;
                    }
                }
                catch { /* fall through to local cache */ }
            }
            if (state) {
                const localRemaining = Array.from(state.participantClientIds)
                    .filter((cid) => cid !== clientId).length;
                remainingAfterDeparture = Math.max(remainingAfterDeparture, localRemaining);
            }
            const callContinues = remainingAfterDeparture >= 2;
            if (state) {
                callerIdForPayload = state.callerId;
                lobbyNameForPayload = state.lobbyName;
                const departedUserId = (typeof this.messageRouter.getUserIdForClient === 'function'
                    ? this.messageRouter.getUserIdForClient(clientId)
                    : null) ?? null;
                const envelope = callContinues
                    ? {
                        type: 'call',
                        action: 'user-status',
                        data: {
                            callId,
                            callerId: state.callerId,
                            lobbyName: state.lobbyName,
                            status: 'left',
                            userId: departedUserId,
                            reason: 'peer-disconnected',
                        },
                        timestamp: new Date().toISOString(),
                    }
                    : {
                        type: 'call',
                        action: 'ended',
                        data: {
                            callId,
                            callerId: state.callerId,
                            lobbyName: state.lobbyName,
                            reason: 'peer-disconnected',
                        },
                        timestamp: new Date().toISOString(),
                    };
                for (const peerClientId of state.participantClientIds) {
                    if (peerClientId === clientId)
                        continue;
                    try {
                        await Promise.resolve(this.messageRouter.sendToClient(peerClientId, envelope));
                    }
                    catch (e) {
                        this.logger.warn(`CallService.handleDisconnect: failed to notify peer ${peerClientId} of ${clientId}'s exit from ${callId}: ${e?.message ?? e}`);
                    }
                }
                this.logger.info(`CallService: client ${clientId} dropped; sent ${callContinues ? "'user-status: left'" : "synthetic 'ended'"} to ${state.participantClientIds.size - 1} local peer(s) of call ${callId} (remaining=${remainingAfterDeparture})`);
            }
            else if (this.stateStore) {
                // Cluster-only entry — pull authoritative metadata so the
                // cross-node payload carries the right callerId/lobby for
                // the peer's notify envelope.
                try {
                    const view = await this.stateStore.getCall(callId);
                    if (view) {
                        callerIdForPayload = view.callerId;
                        lobbyNameForPayload = view.lobbyName;
                    }
                }
                catch { /* best-effort */ }
                this.logger.info(`CallService: client ${clientId} dropped; no local state for call ${callId} — cluster-only, publishing cross-node departure`);
            }
            // P1 — publish a cross-node departure so peer nodes that
            // hold OTHER participants of this call (multi-replica
            // deployments) can fire their own local synthetic ended.
            // Without this, peers on different nodes never get notified.
            if (this.crossNodePubSub) {
                try {
                    const payload = {
                        callId,
                        departedClientId: clientId,
                        callerId: callerIdForPayload,
                        lobbyName: lobbyNameForPayload,
                        callContinues,
                    };
                    await Promise.resolve(this.crossNodePubSub.publish(CROSS_NODE_DEPARTED_TOPIC, JSON.stringify(payload)));
                    // Structured info log on successful publish: operators need
                    // to trace a disconnect through the cluster ("did the peer
                    // even hear about this departure?"). Without this line, the
                    // only signal is a metric — you can't grep for the specific
                    // call/client without the warn-on-error path firing. Logged
                    // at info because cross-node departure is a state change,
                    // not a hot-path per-message event (fires once per WS close
                    // per active call — bounded).
                    this.logger.info('[CallService] cross-node departure published', {
                        topic: CROSS_NODE_DEPARTED_TOPIC,
                        callId,
                        departedClientId: clientId,
                        callerId: callerIdForPayload || null,
                        lobbyName: lobbyNameForPayload || null,
                    });
                }
                catch (e) {
                    this.logger.warn('[CallService] cross-node departure publish failed', {
                        topic: CROSS_NODE_DEPARTED_TOPIC,
                        callId,
                        departedClientId: clientId,
                        errorMessage: e?.message ?? String(e),
                    });
                }
            }
            if (callContinues) {
                // F1 — participant-grain removal: drop ONLY the departed
                // client; the call (and every other participant's state)
                // survives. This is the same removal the clean-exit
                // `ended`/`declined` path performs.
                if (state)
                    state.participantClientIds.delete(clientId);
                if (this.stateStore) {
                    if (typeof this.stateStore.removeClientFromCall === 'function') {
                        void this.stateStore.removeClientFromCall(clientId, callId)
                            .catch((e) => this.logger.warn(`[CallService] stateStore.removeClientFromCall failed for ${clientId}/${callId}: ${e?.message ?? e}`));
                    }
                    else {
                        void this.stateStore.removeParticipant(callId, clientId)
                            .catch((e) => this.logger.warn(`[CallService] stateStore.removeParticipant failed for ${callId}/${clientId}: ${e?.message ?? e}`));
                    }
                }
            }
            else {
                this.forgetCall(callId);
                // forgetCall above is a no-op when local state is missing
                // (cluster-only callId). Ensure cluster-wide cleanup still
                // fires so peer nodes can converge on a terminal state.
                if (!this.activeCalls.has(callId) && this.stateStore) {
                    if (typeof this.stateStore.removeClientFromCall === 'function') {
                        void this.stateStore.removeClientFromCall(clientId, callId)
                            .catch((e) => this.logger.warn(`[CallService] stateStore.removeClientFromCall failed for ${clientId}/${callId}: ${e?.message ?? e}`));
                    }
                    else {
                        void this.stateStore.removeParticipant(callId, clientId)
                            .catch((e) => this.logger.warn(`[CallService] stateStore.removeParticipant failed for ${callId}/${clientId}: ${e?.message ?? e}`));
                    }
                }
            }
        }
        this.clientToCalls.delete(clientId);
    }
    sendError(clientId, message) {
        if (!this.messageRouter)
            return;
        const frame = {
            type: 'error',
            service: 'call',
            message,
            timestamp: new Date().toISOString(),
        };
        this.messageRouter.sendToClient(clientId, frame);
    }
    getStats() {
        return {
            stateful: true,
            activeCalls: this.activeCalls.size,
            trackedClients: this.clientToCalls.size,
        };
    }
    /**
     * Read-only accessor exposing a CallStateStore-shaped view of this
     * service's state for the GET /api/calls/active resume endpoint.
     * Prefers the durable Redis stateStore when wired (multi-pod
     * visibility), and falls back to a per-process in-memory adapter
     * over `activeCalls`/`clientToCalls` so single-node deployments
     * still get a working resume dialog. Surface area is intentionally
     * narrow (the three readers the resume route actually uses).
     */
    getResumableStateStore() {
        if (this.stateStore)
            return this.stateStore;
        const self = this;
        return {
            async registerParticipant() { },
            async removeParticipant() { return null; },
            async forgetCall() { },
            async getCall(callId) {
                const state = self.activeCalls.get(callId);
                if (!state)
                    return null;
                return {
                    callerId: state.callerId,
                    lobbyName: state.lobbyName,
                    targetUserIds: state.targetUserIds,
                    participantClientIds: Array.from(state.participantClientIds),
                    invitedAt: typeof state.invitedAt === 'number' ? state.invitedAt : null,
                    callerName: state.originalCallerName ?? null,
                };
            },
            async getCallIdsByClient(clientId) {
                const ids = self.clientToCalls.get(clientId);
                return ids ? Array.from(ids) : [];
            },
            async stats() {
                return {
                    activeCalls: self.activeCalls.size,
                    trackedClients: self.clientToCalls.size,
                };
            },
        };
    }
}
exports.CallService = CallService;
exports.default = CallService;
//# sourceMappingURL=CallService.js.map