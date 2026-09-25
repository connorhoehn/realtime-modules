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
exports.inviteDedupKey = inviteDedupKey;
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
/** Dedup identity for an invite: the call PLUS who is being rung.
 *  Broadcast invites (no targets) collapse to the callId, which is the
 *  old behaviour and correct for them — a broadcast re-fired within the
 *  window really is a duplicate. */
function inviteDedupKey(callId, targetUserIds) {
    if (!targetUserIds || targetUserIds.length === 0)
        return callId;
    return `${callId}|${[...targetUserIds].sort().join(',')}`;
}
const INVITE_DEDUP_MAX_ENTRIES = 10_000;
/** How long a call this node just registered may be missing from the shared
 *  store (its write-through mirror is fire-and-forget) before `status` treats
 *  "not in the store" as "gone". */
const STORE_SETTLE_MS = 5_000;
/** Review list with the host document first, deduped, strings only. */
function normalizeDocumentIds(raw, hostDocumentId) {
    const out = [];
    if (hostDocumentId)
        out.push(hostDocumentId);
    if (Array.isArray(raw)) {
        for (const id of raw) {
            if (typeof id === 'string' && id && !out.includes(id))
                out.push(id);
        }
    }
    return out.slice(0, 50);
}
function normalizeTitles(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string')
            out[k] = v.slice(0, 200);
    }
    return Object.keys(out).length ? out : null;
}
/** The meta as it goes on the wire: `clients` (connection ids) stays
 *  server-side. */
function publicMeta(meta) {
    const { clients: _clients, ...rest } = meta;
    return rest;
}
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
    callEndedHook;
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
     * Live room calls, keyed by slug.
     *
     * A room call has no invite and no accept — you join a PLACE — so none of
     * the signaling-edge bookkeeping above ever runs for it, and
     * `onCallEnded` could never fire: the record of a room call simply never
     * reached the room's conversation. Its lifecycle is membership instead:
     * the first member in starts it, the last member out ends it, which is
     * the same rule the DM path uses on `participantClientIds`.
     *
     * Deleting the entry IS the once-guard, so a duplicate leave cannot
     * announce the same call twice.
     */
    roomCalls = new Map();
    /**
     * PR-W2.4 — sync leadership check + skip-metric hook for the
     * invite-sweep timer.  Both are optional: when omitted the sweeper
     * runs every tick (single-node / pre-PR behaviour).  Wired by
     * server.ts from createSweeperLeader(SWEEPER_SENTINELS.CALL_INVITE)
     * + recordCleanupSkipped('call_invite', ...).
     */
    sweeperIsLeader = null;
    /** F2 — pending end-of-call timers for calls in the rejoin grace
     *  window (disconnect left <=1 participants; teardown deferred so a
     *  refreshing peer can come back). callId → timer. */
    rejoinGraceTimers = new Map();
    rejoinGraceMs = 30_000;
    onSweepSkipped = null;
    _withSpan;
    /** Document calls (2026-09-24) — see CallServiceOptions.metaStore. */
    metaStore;
    onOfflineInviteHook;
    isClientAliveHook;
    /** Document calls — `<callId>|<userId>` → timer that turns a
     *  `reconnecting` participant into `left` when the grace runs out. */
    docLeaveTimers = new Map();
    /** Calls whose registration has reached the shared store at least once —
     *  after that, "not in the store" means gone. */
    storeMirrored = new Set();
    /** Guards against two overlapping sweep ticks (the tick is async now). */
    sweepRunning = false;
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
        if (typeof opts.rejoinGraceMs === 'number' && opts.rejoinGraceMs >= 0) {
            this.rejoinGraceMs = opts.rejoinGraceMs;
        }
        this.onSweepSkipped = opts.onSweepSkipped ?? null;
        this._withSpan = opts.withSpan ?? _passthroughWithSpan;
        this.metaStore = opts.metaStore ?? null;
        this.onOfflineInviteHook = opts.onOfflineInvite ?? null;
        this.isClientAliveHook = opts.isClientAlive ?? null;
        const config = opts.config ?? {};
        this.authorize = config.authorize ?? (() => true);
        this.canCallHook = config.canCall ?? null;
        this.recordCallActionHook = config.recordCallAction ?? null;
        this.persistBindingHook = config.persistCallBinding ?? null;
        this.callEndedHook = config.onCallEnded ?? null;
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
            void this.runInviteSweep();
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
            await this.notifyLocalPeersOfDeparture(callId, evt.departedClientId, evt.callerId, evt.lobbyName, evt.callContinues === true, evt.notified === true)
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
    async notifyLocalPeersOfDeparture(callId, departedClientId, fallbackCallerId, fallbackLobbyName, callContinues = false, alreadyNotified = false) {
        if (alreadyNotified) {
            // Document call: the origin replica told everyone cluster-wide.
            // Only keep this node's cache in step.
            const local = this.activeCalls.get(callId);
            if (callContinues) {
                if (local && departedClientId)
                    local.participantClientIds.delete(departedClientId);
                const cs = departedClientId ? this.clientToCalls.get(departedClientId) : undefined;
                if (cs) {
                    cs.delete(callId);
                    if (cs.size === 0)
                        this.clientToCalls.delete(departedClientId);
                }
            }
            else if (local) {
                this.forgetCall(callId);
            }
            return 0;
        }
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
        for (const t of this.rejoinGraceTimers.values())
            clearTimeout(t);
        this.rejoinGraceTimers.clear();
        for (const t of this.docLeaveTimers.values())
            clearTimeout(t);
        this.docLeaveTimers.clear();
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
        // F2 — a (re)registration during the rejoin grace window saves
        // the call: cancel the deferred teardown.
        const pendingEnd = this.rejoinGraceTimers.get(callId);
        if (pendingEnd) {
            clearTimeout(pendingEnd);
            this.rejoinGraceTimers.delete(callId);
            this.logger.info(`[CallService] rejoin within grace — cancelled deferred end for ${callId}`);
        }
        let state = this.activeCalls.get(callId);
        if (!state) {
            state = { callerId, lobbyName, targetUserIds, participantClientIds: new Set() };
            this.activeCalls.set(callId, state);
        }
        state.participantClientIds.add(clientId);
        // Who is here now drains as people leave; who was ever here is what a
        // record of the call is made of.
        (state.everParticipated ??= new Set()).add(clientId);
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
                .then(() => { this.storeMirrored.add(callId); })
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
    /**
     * Fire `onCallEnded` exactly once for a call that is over.
     *
     * There are TWO terminal paths and they do not share teardown: a
     * `ended`/`declined`/`cancelled` verb drops the last participant and
     * deletes the call inline, while `forgetCall` handles the sweeper, the
     * `forget` verb and cross-node departure. A hook wired to only one of
     * them misses whichever way this particular call happened to end, so both
     * call this.
     *
     * `acceptedCallIds` is both the gate and the once-guard: an invite nobody
     * accepted is a MISSED call rather than a call, and consuming the entry
     * here means a second terminal event for the same call finds nothing to
     * announce.
     */
    _announceCallEnded(callId, state) {
        if (!this.callEndedHook || !this.acceptedCallIds.has(callId))
            return;
        this.acceptedCallIds.delete(callId);
        const endedAt = Date.now();
        const startedAt = typeof state.invitedAt === 'number' ? state.invitedAt : undefined;
        this._emitCallEnded({
            callId,
            lobbyName: state.lobbyName,
            callerId: state.callerId,
            callerName: state.originalCallerName,
            startedAt,
            endedAt,
            // Absent rather than zero when we never knew when it began — a
            // transcript reading "0s" looks like a bug, because it is one.
            durationMs: startedAt !== undefined ? endedAt - startedAt : undefined,
            // The full roster. Reporting whoever happened to leave last
            // would name one person out of however many were in the call.
            participantClientIds: Array.from(state.everParticipated ?? state.participantClientIds),
        });
    }
    /**
     * Hand a finished call to the consumer. Never awaited: teardown is
     * synchronous and must not wait on whatever the consumer does with this.
     * A broken recorder cannot break a hang-up.
     */
    _emitCallEnded(summary) {
        if (!this.callEndedHook)
            return;
        try {
            void Promise.resolve(this.callEndedHook(summary)).catch((e) => this.logger.warn(`[CallService] onCallEnded failed for ${summary.callId}: ${e?.message ?? e}`));
        }
        catch (e) {
            this.logger.warn(`[CallService] onCallEnded threw for ${summary.callId}: ${e?.message ?? e}`);
        }
    }
    forgetCall(callId) {
        const state = this.activeCalls.get(callId);
        if (!state)
            return;
        const departedParticipants = Array.from(state.participantClientIds);
        this._announceCallEnded(callId, state);
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
        this.storeMirrored.delete(callId);
        // J2 — also drop any pending grace for a call we are forgetting
        // outright, so a late timer can't resurrect a terminal decision.
        const pendingGrace = this.rejoinGraceTimers.get(callId);
        if (pendingGrace) {
            clearTimeout(pendingGrace);
            this.rejoinGraceTimers.delete(callId);
        }
        this.clearInviteRegistryForCall(callId);
        void this.clearInviteRegistryForCallStore(callId);
        if (this.metaStore) {
            void this.metaStore.delete(callId).catch(() => { });
        }
        for (const key of Array.from(this.docLeaveTimers.keys())) {
            if (key.startsWith(`${callId}|`))
                this.clearDocLeaveTimerKey(key);
        }
        // J2 — evict from the F2/F3 discovery indexes. They were
        // append-only with a 4h TTL: readers liveness-filter, so this
        // was not supposed to leak, but leaving forgotten calls in the
        // lobby index widened every window where a filter said "keep".
        if (this.stateStore) {
            if (typeof this.stateStore.forgetLobbyCall === 'function' && state.lobbyName) {
                void this.stateStore.forgetLobbyCall(state.lobbyName, callId)
                    .catch(() => { });
            }
            if (typeof this.stateStore.forgetUserCall === 'function') {
                const users = new Set([
                    ...(state.originalTargetUserIds ?? state.targetUserIds ?? []),
                    ...(state.callerId ? [state.callerId] : []),
                ]);
                for (const uid of users) {
                    if (!uid)
                        continue;
                    void this.stateStore.forgetUserCall(uid, callId)
                        .catch(() => { });
                }
            }
        }
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
    /** UX audit 2026-08-24 — reap a call that exists only in the durable
     *  store (local cache cold) and whose every registered participant is
     *  provably dead. Mirrors the index-hygiene part of forgetCall for
     *  the store-only case: lobby index, per-user resume index, invite
     *  registry, and the call hash itself. */
    async reapDeadStoredCall(callId, lobbyName, view) {
        if (!this.stateStore)
            return;
        this.logger.info(`[CallService] status query reaped dead stored call ${callId} in lobby ${lobbyName}`);
        if (typeof this.stateStore.forgetLobbyCall === 'function') {
            try {
                await this.stateStore.forgetLobbyCall(lobbyName, callId);
            }
            catch { /* best-effort */ }
        }
        if (typeof this.stateStore.forgetUserCall === 'function') {
            const users = new Set([
                ...(view.targetUserIds ?? []),
                ...(view.callerId ? [view.callerId] : []),
            ]);
            for (const uid of users) {
                if (!uid)
                    continue;
                try {
                    await this.stateStore.forgetUserCall(uid, callId);
                }
                catch { /* best-effort */ }
            }
        }
        if (typeof this.stateStore.clearInviteForUser === 'function') {
            for (const uid of view.targetUserIds ?? []) {
                if (!uid)
                    continue;
                try {
                    await this.stateStore.clearInviteForUser(uid, callId);
                }
                catch { /* best-effort */ }
            }
        }
        try {
            await this.stateStore.forgetCall(callId);
        }
        catch { /* best-effort */ }
        this.acceptedCallIds.delete(callId);
    }
    /**
     * UX audit 2026-08-24 — `forget` verb: durable per-user dismissal.
     * The sender says "stop offering me callId"; we remove THEIR resume
     * index + invite-registry entries so the ResumeCallDialog cannot
     * resurrect for this user in any future session. Other participants'
     * indexes are untouched — a call the peer is still happily in keeps
     * offering THEM resume. Acked to the sender with a `forgotten`
     * envelope so clients (and e2e) can await completion.
     */
    async handleForgetRequest(clientId, payload) {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        if (!callId) {
            this.sendError(clientId, 'callId is required on forget');
            return;
        }
        let userId = '';
        if (typeof this.messageRouter.getUserIdForClient === 'function') {
            try {
                userId = (await Promise.resolve(this.messageRouter.getUserIdForClient(clientId))) ?? '';
            }
            catch { /* best-effort */ }
        }
        // Fall back to the payload's callerId when the router can't
        // resolve identity (SKIP_AUTH dev setups) — worst case a client
        // clears its OWN claimed identity's index, which is exactly the
        // dismissal semantic anyway.
        if (!userId && typeof payload.callerId === 'string')
            userId = payload.callerId;
        if (userId && this.stateStore) {
            if (typeof this.stateStore.forgetUserCall === 'function') {
                try {
                    await this.stateStore.forgetUserCall(userId, callId);
                }
                catch (e) {
                    this.logger.warn(`[CallService] forgetUserCall failed for ${userId}/${callId}: ${e?.message ?? e}`);
                }
            }
            if (typeof this.stateStore.clearInviteForUser === 'function') {
                try {
                    await this.stateStore.clearInviteForUser(userId, callId);
                }
                catch { /* best-effort */ }
            }
        }
        // Local invite-replay registry for this user too.
        if (userId) {
            const localSet = this.activeInvitesByUserId.get(userId);
            if (localSet) {
                localSet.delete(callId);
                if (localSet.size === 0)
                    this.activeInvitesByUserId.delete(userId);
            }
        }
        this.logger.info(`[CallService] forget: cleared resume/invite indexes of call ${callId} for user ${userId || '<unknown>'}`);
        const envelope = {
            type: 'call',
            action: 'forgotten',
            data: { callId, forgotten: true },
            timestamp: new Date().toISOString(),
        };
        try {
            await Promise.resolve(this.messageRouter.sendToClient(clientId, envelope));
        }
        catch { /* ack is best-effort */ }
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
    /** `key` is an inviteDedupKey() — (callId, audience), never a bare
     *  callId. See the call site for why the audience is part of it. */
    checkRecentInviteLocal(key) {
        const now = Date.now();
        const lastSeen = this.recentInvites.get(key);
        if (lastSeen && (now - lastSeen) < INVITE_DEDUP_WINDOW_MS)
            return false;
        this.recentInvites.set(key, now);
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
            const docMeta = await this.getDocumentMeta(callId);
            if (docMeta) {
                // Document call: replay only a ring that is still live FOR
                // THIS USER, and never end the call over it.
                const inv = docMeta.invites[userId];
                if (!inv || inv.state !== 'ringing' || now - inv.at > CallService.INVITE_TTL_MS) {
                    this.dropInviteForUser(userId, callId);
                    continue;
                }
                const docData = {
                    callId,
                    callerId: inv.by || docMeta.hostUserId,
                    lobbyName: docMeta.documentId,
                    targetUserIds: [userId],
                    kind: 'document-review',
                    documentId: docMeta.documentId,
                    title: docMeta.title,
                    documentIds: docMeta.documentIds,
                    media: docMeta.media,
                    participantCount: Object.values(docMeta.invites).filter((i) => i.state === 'accepted').length + 1,
                    replayed: true,
                    originalTimestamp: new Date(inv.at).toISOString(),
                };
                if (docMeta.documentTitles)
                    docData.documentTitles = docMeta.documentTitles;
                if (state.originalCallerName)
                    docData.callerName = state.originalCallerName;
                try {
                    await Promise.resolve(this.messageRouter.sendToClient(clientId, {
                        type: 'call', action: 'invite', data: docData, timestamp: new Date().toISOString(),
                    }));
                    replayed += 1;
                }
                catch { /* best-effort */ }
                continue;
            }
            if (typeof state.inviteExpiresAt === 'number' && now > state.inviteExpiresAt) {
                // An answered call is not ended by a late ring expiring —
                // only this user's stale replay entry goes.
                if (await this.callHasAcceptedParticipant(callId, state)) {
                    this.dropInviteForUser(userId, callId);
                    continue;
                }
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
        // every participant crashed away lingers in the registries long after
        // anyone can be joined. Liveness per participant: the router's
        // three-state isClientLive for this node's sockets (true / false =
        // dead here), and for sockets on other replicas (null) the consumer's
        // cluster-wide isClientAlive when wired (the gateway checks the
        // owning node's heartbeat), else trust.
        const liveParticipants = async (ids) => {
            const out = [];
            for (const cid of ids) {
                const local = typeof this.messageRouter.isClientLive === 'function'
                    ? this.messageRouter.isClientLive(cid)
                    : null;
                if (local === false)
                    continue;
                if (local === null && this.isClientAliveHook) {
                    let alive = true;
                    try {
                        alive = (await Promise.resolve(this.isClientAliveHook(cid))) !== false;
                    }
                    catch {
                        alive = true; /* unknown is not dead */
                    }
                    if (!alive)
                        continue;
                }
                out.push(cid);
            }
            return out;
        };
        const candidateIds = new Set();
        for (const [id, state] of this.activeCalls) {
            if (state.lobbyName !== lobbyName && state.originalLobbyName !== lobbyName)
                continue;
            // Expired unaccepted invites are dead air even before the sweep.
            if (typeof state.inviteExpiresAt === 'number'
                && now > state.inviteExpiresAt
                && !this.acceptedCallIds.has(id)
                && !(await this.getDocumentMeta(id)))
                continue;
            candidateIds.add(id);
        }
        if (this.stateStore && typeof this.stateStore.getCallIdsByLobby === 'function') {
            try {
                for (const id of await this.stateStore.getCallIdsByLobby(lobbyName))
                    candidateIds.add(id);
            }
            catch (e) {
                this.logger.warn(`[CallService] status lobby lookup failed for ${lobbyName}: ${e?.message ?? e}`);
            }
        }
        const candidates = [];
        for (const id of candidateIds) {
            const local = this.activeCalls.get(id) ?? null;
            let view = null;
            let viewKnown = false;
            if (this.stateStore) {
                try {
                    view = await this.stateStore.getCall(id);
                    viewKnown = true;
                }
                catch { /* store hiccup: fall back to the local view */ }
            }
            if (viewKnown && !view) {
                // Gone cluster-wide (ended, forgotten, or its state deleted).
                // A call this node registered moments ago may simply not have
                // reached the store yet (the mirror is fire-and-forget), so a
                // young local entry gets the benefit of the doubt.
                const young = this.isUnmirroredYoung(id, now);
                if (!young) {
                    this.logger.info(`[CallService] status query dropped call ${id} in lobby ${lobbyName}: gone cluster-wide`);
                    if (local)
                        this.forgetCall(id);
                    if (this.stateStore && typeof this.stateStore.forgetLobbyCall === 'function') {
                        void this.stateStore.forgetLobbyCall(lobbyName, id).catch(() => { });
                    }
                    continue;
                }
            }
            const ids = new Set(local ? Array.from(local.participantClientIds) : []);
            if (view)
                for (const cid of view.participantClientIds)
                    ids.add(cid);
            const alive = await liveParticipants(Array.from(ids));
            if (alive.length === 0) {
                // Provably dead: every registered participant failed the probe.
                this.logger.info(`[CallService] status query reaped dead call ${id} in lobby ${lobbyName}`);
                if (local)
                    this.forgetCall(id);
                else if (view)
                    await this.reapDeadStoredCall(id, lobbyName, view);
                continue;
            }
            const meta = await this.getDocumentMeta(id);
            candidates.push({
                id,
                callerId: local?.callerId || view?.callerId || '',
                callerName: local?.originalCallerName ?? view?.callerName ?? null,
                startedAt: meta?.startedAt ?? local?.invitedAt ?? view?.invitedAt ?? null,
                participantClientIds: alive,
                targetUserIds: (local ? (local.originalTargetUserIds ?? local.targetUserIds) : (view?.targetUserIds ?? [])).slice(),
                meta,
            });
        }
        // Document calls with live meta first (a document call whose meta is
        // gone has ended), then the newest.
        const withMeta = candidates.filter((c) => c.meta);
        const pool = withMeta.length > 0 ? withMeta : candidates;
        pool.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
        const best = pool[0] ?? null;
        const foundCallId = best?.id ?? null;
        const callerId = best?.callerId ?? '';
        const callerName = best?.callerName ?? null;
        const startedAt = best?.startedAt ?? null;
        const participantClientIds = best?.participantClientIds ?? [];
        const targetUserIds = best?.targetUserIds ?? [];
        const data = { lobbyName, active: !!foundCallId };
        if (foundCallId) {
            // Best-effort participant userIds: reverse-map live clientIds
            // (local router knowledge), fall back to caller + invitees.
            const userIds = new Set();
            // Document calls know every connection's user, whichever replica
            // it lives on — the local router only knows its own sockets.
            const docMeta = await this.getDocumentMeta(foundCallId);
            if (docMeta?.clients) {
                for (const cid of participantClientIds) {
                    const uid = docMeta.clients[cid];
                    if (uid)
                        userIds.add(uid);
                }
            }
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
            data.participantUserIds = Array.from(userIds);
            // People, not connections: two tabs of one person count once.
            data.participantCount = docMeta ? userIds.size : participantClientIds.length;
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
        // UX audit 2026-08-24 — `forget` is likewise a sender-scoped
        // verb, not a signaling broadcast: durable dismissal of a
        // resumable call for THIS user only.
        if (action === 'forget') {
            await this.handleForgetRequest(clientId, payload);
            return;
        }
        // Document calls (2026-09-24) — meta queries and edits.
        if (action === 'meta' || action === 'set-documents' || action === 'present' || action === 'set-title'
            || action === 'mute-participant' || action === 'remove-participant' || action === 'transfer-host') {
            await this.handleDocumentCallAction(clientId, action, payload);
            return;
        }
        // Document calls — signalling verbs on a call that has meta get their
        // own bookkeeping, and never fall back to broadcast-to-everyone.
        let docMeta = null;
        let docRecipients = null;
        if (this.metaStore && callId && action !== 'invite') {
            docMeta = await this.getDocumentMeta(callId);
            if (docMeta) {
                const r = await this.handleDocumentCallVerb(clientId, action, payload, docMeta);
                if (r.handled)
                    return;
                if (targetUserIds.length === 0)
                    docRecipients = r.recipientsIfUntargeted;
            }
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
                        // Last one out ends the room's call. Deleting the
                        // entry is the once-guard.
                        const roomCall = this.roomCalls.get(slug);
                        if (roomCall) {
                            roomCall.present.delete(clientId);
                            if (roomCall.present.size === 0) {
                                this.roomCalls.delete(slug);
                                const endedAt = Date.now();
                                this._emitCallEnded({
                                    callId: roomCall.callId,
                                    lobbyName: roomCall.lobbyName,
                                    callerId: roomCall.starterId,
                                    callerName: roomCall.starterName,
                                    startedAt: roomCall.startedAt,
                                    endedAt,
                                    durationMs: endedAt - roomCall.startedAt,
                                    participantClientIds: Array.from(roomCall.everParticipated),
                                });
                            }
                        }
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
                    // First member in starts the room's call; everyone after
                    // joins the one already running.
                    let roomCall = this.roomCalls.get(slug);
                    if (!roomCall) {
                        roomCall = {
                            // Prefer the envelope's callId so the record lines
                            // up with recordings of the same session.
                            callId: callId || `room-${slug}-${Date.now()}`,
                            lobbyName,
                            startedAt: Date.now(),
                            starterId: userId,
                            starterName: displayName || undefined,
                            everParticipated: new Set(),
                            present: new Set(),
                        };
                        this.roomCalls.set(slug, roomCall);
                    }
                    roomCall.everParticipated.add(clientId);
                    roomCall.present.add(clientId);
                    try {
                        await Promise.resolve(this.roomBridge.handleMemberJoined(slug, userId, clientId, participantId, displayName));
                    }
                    catch (e) {
                        this.logger.warn(`[CallService→Room] handleMemberJoined failed for ${slug}/${clientId}: ${e?.message ?? e}`);
                    }
                }
            }
        }
        // P5.1 — dedup duplicate invites within a 5s window. The SAME
        // invite arriving twice = slow double-click or WS retry; suppress
        // so receivers don't re-ring. PR-W2.1: this check is now
        // cluster-wide via CallStateStore.markRecentInvite (SETNX with
        // TTL). Falls back to the in-memory Map when stateStore is null
        // or doesn't implement the dedup op.
        //
        // The key is (callId, audience), NOT callId alone. A call invites
        // more people over its lifetime — "add someone to the call I'm
        // already on" reuses the callId by design, so that it rings into
        // THIS call rather than starting a rival one. Keying on callId
        // alone made every mid-call invite issued within the window look
        // like a double-click and vanish server-side, with the caller
        // seeing no error.
        if (action === 'invite' && callId) {
            let isFirstInvite = true;
            const windowSec = Math.ceil(INVITE_DEDUP_WINDOW_MS / 1000);
            const dedupKey = inviteDedupKey(callId, targetUserIds);
            if (this.stateStore && typeof this.stateStore.markRecentInvite === 'function') {
                try {
                    isFirstInvite = await this.stateStore.markRecentInvite(dedupKey, windowSec);
                }
                catch (e) {
                    this.logger.warn(`[CallService] markRecentInvite failed for ${callId}: ${e?.message ?? e} — falling back to local dedup`);
                    isFirstInvite = this.checkRecentInviteLocal(dedupKey);
                }
            }
            else {
                isFirstInvite = this.checkRecentInviteLocal(dedupKey);
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
        let docInvite = null;
        if (action === 'invite' && this.metaStore && callId
            && (payload.kind === 'document-review' || await this.getDocumentMeta(callId))) {
            const callerUserId = await this.resolveActorUserId(clientId, payload, true);
            docInvite = await this.handleDocumentInvite(clientId, callerUserId, payload, targetUserIds);
        }
        // Track participation so handleDisconnect can fire synthetic
        // `ended` to peers if this client drops uncleanly.
        // A document call's non-invite verbs do not carry the host as
        // callerId (gateways reject a callerId that is not the sender), so the
        // meta supplies it; likewise the lobby is the host document, whatever
        // page the sender happens to be on.
        const callerId = (typeof payload.callerId === 'string' && payload.callerId) || docMeta?.hostUserId || '';
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
        let resolvedLobbyName = docMeta?.documentId || lobbyName || '';
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
                for (const targetUserId of (docInvite ? docInvite.ringTargets : targetUserIds)) {
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
            // A document call keeps ringing the others: only the accepter's
            // entry was dropped (handleDocumentCallVerb).
            if (!docMeta) {
                this.clearInviteRegistryForCall(callId);
                void this.clearInviteRegistryForCallStore(callId);
            }
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
            // J2 (2026-08-22) — a TERMINAL verb is an explicit decision:
            // it must supersede the rejoin grace. Without this, hanging
            // up cleanly and refreshing still found the call alive for
            // the rest of the grace window, so discovery/resume kept
            // offering a call the user had just left.
            const pendingGrace = this.rejoinGraceTimers.get(callId);
            if (pendingGrace) {
                clearTimeout(pendingGrace);
                this.rejoinGraceTimers.delete(callId);
                this.logger.info(`[CallService] ${action} cancelled the rejoin grace for ${callId}`);
            }
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
                if (state.participantClientIds.size === 0) {
                    // Last one out — the call is over, whichever verb got us
                    // here. This path never goes through forgetCall().
                    this._announceCallEnded(callId, state);
                    this.activeCalls.delete(callId);
                    this.storeMirrored.delete(callId);
                }
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
        if (docInvite && docInvite.ringTargets.length === 0) {
            // Nobody online to ring (or ring:false) — the invite is recorded
            // in the meta and the offline hook ran; nothing goes out.
            this.recordCallActionMetric(action, 'targeted');
            return;
        }
        if (docRecipients) {
            await this.sendToClients(docRecipients, envelope);
            this.recordCallActionMetric(action, 'targeted');
            return;
        }
        const fanoutTargets = docInvite ? docInvite.ringTargets : targetUserIds;
        if (fanoutTargets.length > 0) {
            const recipients = await this.findClientsForUsers(fanoutTargets, /* excludeClientId */ clientId);
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
            const docMeta = await this.getDocumentMeta(callId);
            if (docMeta) {
                await this.handleDocumentDisconnect(callId, docMeta, clientId);
                continue;
            }
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
            // F2 — rejoin grace: a departure that would END the call
            // (<=1 remaining) defers teardown so a refreshing peer can
            // re-register. Treated like a continue for envelope +
            // participant-removal purposes; the synthetic ended fires
            // from the grace timer only if nobody comes back.
            const graceDeferred = !callContinues
                && this.rejoinGraceMs > 0
                && remainingAfterDeparture >= 1;
            if (state) {
                callerIdForPayload = state.callerId;
                lobbyNameForPayload = state.lobbyName;
                const departedUserId = (typeof this.messageRouter.getUserIdForClient === 'function'
                    ? this.messageRouter.getUserIdForClient(clientId)
                    : null) ?? null;
                const envelope = (callContinues || graceDeferred)
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
                            ...(graceDeferred ? { rejoinGraceMs: this.rejoinGraceMs } : {}),
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
                this.logger.info(`CallService: client ${clientId} dropped; sent ${(callContinues || graceDeferred) ? "'user-status: left'" : "synthetic 'ended'"} to ${state.participantClientIds.size - 1} local peer(s) of call ${callId} (remaining=${remainingAfterDeparture}${graceDeferred ? `, rejoin grace ${this.rejoinGraceMs}ms` : ''})`);
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
                        // Grace-deferred counts as continuing for peers —
                        // they prune the departed client; the final ended
                        // (if the grace expires) fans out from this node.
                        callContinues: callContinues || graceDeferred,
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
            if (graceDeferred) {
                this.scheduleGraceEnd(callId, clientId);
            }
            if (callContinues || graceDeferred) {
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
    /**
     * F2 — deferred end-of-call. Fires rejoinGraceMs after a departure
     * left the call with <=1 participants and nobody re-registered.
     * Sends the synthetic `ended` to whoever is still around, fans the
     * terminal departure cross-node, and forgets the call.
     */
    scheduleGraceEnd(callId, departedClientId) {
        const existing = this.rejoinGraceTimers.get(callId);
        if (existing)
            clearTimeout(existing);
        const timer = setTimeout(() => {
            this.rejoinGraceTimers.delete(callId);
            void (async () => {
                const state = this.activeCalls.get(callId);
                // Re-check: a rejoin that raced the timer (or a clean
                // ended) may have already resolved the call.
                let remaining = state ? state.participantClientIds.size : 0;
                if (this.stateStore) {
                    try {
                        const view = await this.stateStore.getCall(callId);
                        if (view)
                            remaining = Math.max(remaining, view.participantClientIds.length);
                    }
                    catch { /* local view stands */ }
                }
                if (remaining >= 2)
                    return; // rejoined — call lives
                const envelope = {
                    type: 'call',
                    action: 'ended',
                    data: {
                        callId,
                        callerId: state?.callerId ?? '',
                        lobbyName: state?.lobbyName ?? '',
                        reason: 'rejoin-grace-expired',
                    },
                    timestamp: new Date().toISOString(),
                };
                if (state) {
                    for (const peerClientId of state.participantClientIds) {
                        try {
                            await Promise.resolve(this.messageRouter.sendToClient(peerClientId, envelope));
                        }
                        catch { /* best-effort */ }
                    }
                }
                if (this.crossNodePubSub) {
                    try {
                        const payload = {
                            callId,
                            departedClientId,
                            callerId: state?.callerId ?? '',
                            lobbyName: state?.lobbyName ?? '',
                            callContinues: false,
                        };
                        await Promise.resolve(this.crossNodePubSub.publish(CROSS_NODE_DEPARTED_TOPIC, JSON.stringify(payload)));
                    }
                    catch { /* best-effort */ }
                }
                this.logger.info(`[CallService] rejoin grace expired — call ${callId} ended`);
                this.forgetCall(callId);
            })();
        }, this.rejoinGraceMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.rejoinGraceTimers.set(callId, timer);
        this.logger.info(`[CallService] call ${callId} entering rejoin grace (${this.rejoinGraceMs}ms) after ${departedClientId} dropped`);
    }
    // -----------------------------------------------------------------
    // Invite sweep (runs on the `__leader:call-sweep` holder only)
    // -----------------------------------------------------------------
    /**
     * One sweep tick. Public so tests (and a consumer that wants a sweep on
     * demand) can drive it without waiting 15 s.
     *
     * Expiry is PER TARGET. Before 2026-09-24 the sweep forgot the whole call
     * the moment `inviteExpiresAt` passed, so one unanswered invitee in a
     * group call — or an unanswered mid-call invite — ended the call for
     * everyone, and on a two-replica gateway an accept on the other replica
     * never reached this node's `acceptedCallIds` at all. Now:
     *   - a call someone has accepted is never forgotten here; only the
     *     expired target's invite-replay entry is dropped;
     *   - an unanswered legacy (non-document) call still ends as a missed
     *     call, as before;
     *   - document calls are swept from the meta store: each ringing invite
     *     older than the TTL becomes `missed`, the inviter's clients get
     *     `invite-expired`, and the call itself is left alone;
     *   - roster entries whose client is provably dead (its replica is gone)
     *     are pruned when `isClientAlive` is wired.
     */
    async runInviteSweep(now = Date.now()) {
        if (this.sweepRunning)
            return;
        this.sweepRunning = true;
        try {
            let docCallIds = new Set();
            if (this.metaStore) {
                try {
                    docCallIds = new Set(await this.metaStore.listCallIds());
                }
                catch (e) {
                    this.logger.warn(`[CallService] meta listCallIds failed: ${e?.message ?? e}`);
                }
            }
            await this.sweepLegacyInvites(now, docCallIds);
            if (this.metaStore) {
                for (const callId of docCallIds) {
                    try {
                        await this.sweepDocumentCall(callId, now);
                    }
                    catch (e) {
                        this.logger.warn(`[CallService] document-call sweep failed for ${callId}: ${e?.message ?? e}`);
                    }
                }
            }
            const dedupCutoff = now - INVITE_DEDUP_WINDOW_MS;
            for (const [k, ts] of this.recentInvites) {
                if (ts < dedupCutoff)
                    this.recentInvites.delete(k);
            }
        }
        finally {
            this.sweepRunning = false;
        }
    }
    /** Legacy half of the sweep: this node's in-memory invite registry. */
    async sweepLegacyInvites(now, docCallIds) {
        const expiredCallIds = new Set();
        const expiredTargets = [];
        for (const [userId, callIds] of this.activeInvitesByUserId) {
            for (const callId of callIds) {
                const state = this.activeCalls.get(callId);
                if (!state) {
                    callIds.delete(callId);
                    continue;
                }
                if (!(typeof state.inviteExpiresAt === 'number' && now > state.inviteExpiresAt))
                    continue;
                expiredTargets.push({ userId, callId });
            }
        }
        for (const { userId, callId } of expiredTargets) {
            const state = this.activeCalls.get(callId);
            if (!state)
                continue;
            // Document calls are never ended by a ring timing out: the meta
            // sweep marks the target missed. A call someone answered is not
            // ended either — only this target's replay entry goes.
            if (docCallIds.has(callId) || await this.callHasAcceptedParticipant(callId, state)) {
                this.dropInviteForUser(userId, callId);
            }
            else {
                expiredCallIds.add(callId);
            }
        }
        for (const callId of expiredCallIds)
            this.forgetCall(callId);
        for (const [userId, callIds] of this.activeInvitesByUserId) {
            if (callIds.size === 0)
                this.activeInvitesByUserId.delete(userId);
        }
    }
    /** True when anyone besides the caller is (or was) in the call — checked
     *  locally and in the cluster store, because the accept may have landed on
     *  another replica. */
    async callHasAcceptedParticipant(callId, state) {
        if (this.acceptedCallIds.has(callId))
            return true;
        if (state && state.participantClientIds.size > 1)
            return true;
        if (this.stateStore) {
            try {
                const view = await this.stateStore.getCall(callId);
                if (view && view.participantClientIds.length > 1)
                    return true;
            }
            catch { /* local view stands */ }
        }
        return false;
    }
    /** Drop one person's invite-replay entry for one call (local + store). */
    dropInviteForUser(userId, callId) {
        const set = this.activeInvitesByUserId.get(userId);
        if (set) {
            set.delete(callId);
            if (set.size === 0)
                this.activeInvitesByUserId.delete(userId);
        }
        if (this.stateStore && typeof this.stateStore.clearInviteForUser === 'function') {
            void this.stateStore.clearInviteForUser(userId, callId).catch(() => { });
        }
    }
    /** Meta half of the sweep, for one document call. */
    async sweepDocumentCall(callId, now) {
        const store = this.metaStore;
        const meta = await store.get(callId);
        if (!meta) {
            // Hash expired under its index entry — drop the index entry.
            await store.delete(callId);
            return;
        }
        let changed = false;
        for (const [userId, inv] of Object.entries(meta.invites)) {
            if (inv.state !== 'ringing' || now - inv.at <= CallService.INVITE_TTL_MS)
                continue;
            const missed = { ...inv, state: 'missed' };
            await store.markInvite(callId, userId, missed);
            meta.invites[userId] = missed;
            changed = true;
            this.dropInviteForUser(userId, callId);
            const inviter = inv.by || meta.hostUserId;
            await this.sendToUsers([inviter], {
                type: 'call',
                action: 'invite-expired',
                data: { callId, userId },
                timestamp: new Date().toISOString(),
            });
            this.logger.info(`[CallService] ring to ${userId} in document call ${callId} expired (missed)`);
        }
        const pruned = await this.pruneDeadClients(callId, meta);
        if (pruned === 'ended')
            return;
        if (changed || pruned === 'changed') {
            const fresh = await store.get(callId);
            if (fresh)
                await this.broadcastCallMeta(fresh);
        }
    }
    /**
     * Remove roster entries whose client is provably dead — its replica went
     * away without running handleDisconnect, so nobody else will. Uses the
     * consumer's `isClientAlive` (the gateway checks the owning node's
     * heartbeat). Each person with no live connection left gets a synthetic
     * `user-status: left`; a call with nobody left ends.
     */
    async pruneDeadClients(callId, meta) {
        if (!this.isClientAliveHook)
            return 'none';
        const members = await this.docCallMemberClientIds(callId);
        if (members.length === 0)
            return 'none';
        const dead = [];
        for (const cid of members) {
            let alive = true;
            try {
                alive = (await Promise.resolve(this.isClientAliveHook(cid))) !== false;
            }
            catch {
                alive = true; /* unknown is not dead */
            }
            if (!alive)
                dead.push(cid);
        }
        if (dead.length === 0)
            return 'none';
        for (const cid of dead)
            this.removeClientFromCallEverywhere(callId, cid);
        const survivors = members.filter((c) => !dead.includes(c));
        if (survivors.length === 0) {
            await this.endDocumentCall(callId, meta, 'participants-lost');
            return 'ended';
        }
        const survivorUsers = new Set(survivors.map((c) => meta.clients?.[c]).filter(Boolean));
        let presentingCleared = false;
        for (const cid of dead) {
            const uid = meta.clients?.[cid];
            if (!uid || survivorUsers.has(uid))
                continue;
            this.clearDocLeaveTimer(callId, uid);
            await this.sendToClients(survivors, this.userStatusEnvelope(callId, meta, uid, 'left', 'node-lost'));
            if (meta.presenting?.userId === uid && !presentingCleared) {
                await this.metaStore.setPresenting(callId, null);
                presentingCleared = true;
            }
        }
        this.logger.info(`[CallService] pruned ${dead.length} dead client(s) from document call ${callId}`);
        return 'changed';
    }
    // -----------------------------------------------------------------
    // Document calls (2026-09-24)
    // -----------------------------------------------------------------
    /** The authenticated user behind a client, falling back to what the
     *  payload claims (SKIP_AUTH dev setups have no router identity). */
    async resolveActorUserId(clientId, payload, allowCallerId) {
        if (typeof this.messageRouter.getUserIdForClient === 'function') {
            try {
                const uid = await Promise.resolve(this.messageRouter.getUserIdForClient(clientId));
                if (uid)
                    return uid;
            }
            catch { /* fall through */ }
        }
        if (typeof payload.userId === 'string' && payload.userId)
            return payload.userId;
        if (allowCallerId && typeof payload.callerId === 'string')
            return payload.callerId;
        return '';
    }
    async getDocumentMeta(callId) {
        if (!this.metaStore || !callId)
            return null;
        try {
            return await this.metaStore.get(callId);
        }
        catch (e) {
            this.logger.warn(`[CallService] meta read failed for ${callId}: ${e?.message ?? e}`);
            return null;
        }
    }
    /** Participant = the host, anyone whose invite is `accepted`, or a
     *  connection the call has seen. */
    isDocParticipant(meta, userId, clientId) {
        if (userId && meta.hostUserId === userId)
            return true;
        if (userId && meta.invites[userId]?.state === 'accepted')
            return true;
        return !!meta.clients && Object.prototype.hasOwnProperty.call(meta.clients, clientId);
    }
    /** Connections currently in the call, cluster-wide (store) plus this
     *  node's cache. */
    async docCallMemberClientIds(callId) {
        const out = new Set();
        const local = this.activeCalls.get(callId);
        if (local)
            for (const cid of local.participantClientIds)
                out.add(cid);
        if (this.stateStore) {
            try {
                const view = await this.stateStore.getCall(callId);
                if (view)
                    for (const cid of view.participantClientIds)
                        out.add(cid);
            }
            catch { /* local view stands */ }
        }
        return Array.from(out);
    }
    removeClientFromCallEverywhere(callId, clientId) {
        const state = this.activeCalls.get(callId);
        if (state)
            state.participantClientIds.delete(clientId);
        const cs = this.clientToCalls.get(clientId);
        if (cs) {
            cs.delete(callId);
            if (cs.size === 0)
                this.clientToCalls.delete(clientId);
        }
        if (this.stateStore) {
            void this.stateStore.removeParticipant(callId, clientId).catch(() => { });
            if (typeof this.stateStore.removeClientFromCall === 'function') {
                void this.stateStore.removeClientFromCall(clientId, callId).catch(() => { });
            }
        }
    }
    async sendToClients(clientIds, envelope) {
        await Promise.allSettled(Array.from(new Set(clientIds)).map((cid) => {
            try {
                return Promise.resolve(this.messageRouter.sendToClient(cid, envelope));
            }
            catch (err) {
                return Promise.reject(err);
            }
        }));
    }
    /** Every connection of the given users, cluster-wide. */
    async sendToUsers(userIds, envelope) {
        const ids = userIds.filter(Boolean);
        if (ids.length === 0 || typeof this.messageRouter.getClientsByUserId !== 'function')
            return;
        let matches = [];
        try {
            const r = await Promise.resolve(this.messageRouter.getClientsByUserId(ids, ''));
            matches = Array.isArray(r) ? r : [];
        }
        catch {
            return;
        }
        await this.sendToClients(matches.map((m) => m.clientId), envelope);
    }
    userStatusEnvelope(callId, meta, userId, status, reason, extra = {}) {
        return {
            type: 'call',
            action: 'user-status',
            data: {
                callId,
                callerId: meta.hostUserId,
                lobbyName: meta.documentId,
                userId,
                status,
                reason,
                ...extra,
            },
            timestamp: new Date().toISOString(),
        };
    }
    /** Send `call-meta` to everyone in the call (plus `extraClientIds`). */
    async broadcastCallMeta(meta, extraClientIds = []) {
        const members = await this.docCallMemberClientIds(meta.callId);
        const envelope = {
            type: 'call',
            action: 'call-meta',
            data: publicMeta(meta),
            timestamp: new Date().toISOString(),
        };
        await this.sendToClients([...members, ...extraClientIds], envelope);
    }
    /**
     * `kind:'document-review'` invite. Writes the meta on the call's first
     * invite, marks each target ringing (online) or notified (no connected
     * client, or `ring:false`), and returns who should actually be rung.
     */
    async handleDocumentInvite(clientId, callerUserId, payload, targetUserIds) {
        const store = this.metaStore;
        const callId = payload.callId;
        const now = Date.now();
        let meta = await store.get(callId);
        const documentId = typeof payload.documentId === 'string' && payload.documentId
            ? payload.documentId
            : String(payload.lobbyName ?? '');
        if (!meta) {
            const documentIds = normalizeDocumentIds(payload.documentIds, documentId);
            meta = {
                callId,
                documentId,
                title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : documentId,
                documentIds,
                hostUserId: callerUserId,
                media: payload.media === 'audio' ? 'audio' : 'video',
                startedAt: now,
                presenting: null,
                invites: {},
                clients: {},
            };
            const titles = normalizeTitles(payload.documentTitles);
            if (titles)
                meta.documentTitles = titles;
            await store.set(meta);
            await this.pruneLobbyIndex(documentId, callId);
        }
        if (callerUserId)
            await store.markClient(callId, clientId, callerUserId);
        const ring = payload.ring !== false;
        const ringTargets = [];
        for (const target of targetUserIds) {
            if (!target || target === callerUserId)
                continue;
            // Somebody already in the call is not rung again.
            if (meta.invites[target]?.state === 'accepted' || meta.hostUserId === target)
                continue;
            let online = false;
            if (ring) {
                try {
                    online = (await this.findClientsForUsers([target], clientId)).length > 0;
                }
                catch {
                    online = false;
                }
            }
            const state = ring && online ? 'ringing' : 'notified';
            await store.markInvite(callId, target, { at: now, state, by: callerUserId });
            if (state === 'ringing') {
                ringTargets.push(target);
            }
            else if (this.onOfflineInviteHook) {
                const offline = {
                    callId,
                    documentId: meta.documentId,
                    title: meta.title,
                    callerId: callerUserId,
                    documentIds: meta.documentIds,
                    media: meta.media,
                };
                if (typeof payload.callerName === 'string')
                    offline.callerName = payload.callerName;
                if (typeof payload.message === 'string' && payload.message)
                    offline.message = payload.message.slice(0, 280);
                try {
                    await Promise.resolve(this.onOfflineInviteHook(target, offline));
                }
                catch (e) {
                    this.logger.warn(`[CallService] onOfflineInvite failed for ${target}/${callId}: ${e?.message ?? e}`);
                }
            }
        }
        const fresh = await store.get(callId);
        if (fresh)
            await this.broadcastCallMeta(fresh, [clientId]);
        return { ringTargets };
    }
    /** A call this node registered moments ago whose store write has not
     *  landed yet — not in the store, but not gone either. */
    isUnmirroredYoung(callId, now) {
        const local = this.activeCalls.get(callId);
        if (!local || this.storeMirrored.has(callId))
            return false;
        return typeof local.invitedAt !== 'number' || now - local.invitedAt < STORE_SETTLE_MS;
    }
    /** A new document call starts: drop lobby-index entries that point at
     *  calls whose state is gone cluster-wide, so `status` stops finding them.
     *  Live calls are left alone. */
    async pruneLobbyIndex(lobbyName, keepCallId) {
        const st = this.stateStore;
        if (!st || typeof st.getCallIdsByLobby !== 'function' || typeof st.forgetLobbyCall !== 'function')
            return;
        try {
            for (const id of await st.getCallIdsByLobby(lobbyName)) {
                if (id === keepCallId)
                    continue;
                if (await st.getCall(id))
                    continue;
                if (this.isUnmirroredYoung(id, Date.now()))
                    continue;
                await st.forgetLobbyCall(lobbyName, id);
                if (this.activeCalls.has(id))
                    this.forgetCall(id);
                this.logger.info(`[CallService] pruned stale call ${id} from lobby ${lobbyName}`);
            }
        }
        catch (e) {
            this.logger.warn(`[CallService] lobby prune failed for ${lobbyName}: ${e?.message ?? e}`);
        }
    }
    /** `meta` / `set-documents` / `present` / `set-title`. */
    async handleDocumentCallAction(clientId, action, payload) {
        if (!this.metaStore) {
            this.sendError(clientId, `Document calls are not enabled (${action})`);
            return;
        }
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        if (!callId) {
            this.sendError(clientId, `callId is required on ${action}`);
            return;
        }
        const meta = await this.metaStore.get(callId);
        if (!meta) {
            this.sendError(clientId, `Unknown call: ${callId}`);
            return;
        }
        const userId = await this.resolveActorUserId(clientId, payload, true);
        if (!this.isDocParticipant(meta, userId, clientId)) {
            this.sendError(clientId, `Not a participant of call ${callId}`);
            return;
        }
        if (action === 'meta') {
            await this.sendToClients([clientId], {
                type: 'call',
                action: 'call-meta',
                data: publicMeta(meta),
                timestamp: new Date().toISOString(),
            });
            return;
        }
        if (action === 'set-documents') {
            if (!Array.isArray(payload.documentIds)) {
                this.sendError(clientId, 'documentIds is required on set-documents');
                return;
            }
            const documentIds = normalizeDocumentIds(payload.documentIds, meta.documentId);
            const titles = normalizeTitles(payload.documentTitles);
            const patch = { documentIds };
            if (titles || meta.documentTitles) {
                const merged = { ...(meta.documentTitles ?? {}), ...(titles ?? {}) };
                for (const k of Object.keys(merged))
                    if (!documentIds.includes(k))
                        delete merged[k];
                patch.documentTitles = merged;
            }
            await this.metaStore.patch(callId, patch);
            // A presented document that left the list stops being presented.
            if (meta.presenting && !documentIds.includes(meta.presenting.documentId)) {
                await this.metaStore.setPresenting(callId, null);
            }
        }
        else if (action === 'present') {
            const raw = payload.documentId;
            const documentId = typeof raw === 'string' && raw ? raw : null;
            const current = meta.presenting;
            const isHost = userId === meta.hostUserId;
            if (current && current.userId !== userId && !isHost) {
                this.sendError(clientId, `Someone else is presenting (${current.userId})`);
                return;
            }
            if (documentId && !meta.documentIds.includes(documentId)) {
                this.sendError(clientId, 'Only a review document can be presented');
                return;
            }
            if (!documentId && !current) {
                // Nothing to stop — answer with the unchanged meta.
                await this.broadcastCallMeta(meta, [clientId]);
                return;
            }
            await this.metaStore.setPresenting(callId, documentId
                ? { documentId, userId, since: Date.now() }
                : null);
        }
        else if (action === 'set-title') {
            if (userId !== meta.hostUserId) {
                this.sendError(clientId, 'Only the host can rename the call');
                return;
            }
            const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : '';
            if (!title) {
                this.sendError(clientId, 'title is required on set-title');
                return;
            }
            await this.metaStore.patch(callId, { title });
        }
        else if (action === 'mute-participant' || action === 'remove-participant' || action === 'transfer-host') {
            const handled = await this.handleModeration(clientId, action, payload, meta, userId);
            if (handled)
                return;
        }
        const fresh = await this.metaStore.get(callId);
        if (fresh)
            await this.broadcastCallMeta(fresh, [clientId]);
    }
    /**
     * Host moderation: `mute-participant`, `remove-participant`,
     * `transfer-host`. Host only; the target must be someone in the call
     * (not the host themself). Works across replicas: the target's
     * connections are found cluster-wide, the meta lives in the shared store,
     * and other nodes drop removed connections from their caches through the
     * cross-node departure topic. Returns true when it already answered (so
     * the caller must not broadcast call-meta again).
     */
    async handleModeration(clientId, action, payload, meta, actorUserId) {
        const store = this.metaStore;
        const callId = meta.callId;
        if (!actorUserId || actorUserId !== meta.hostUserId) {
            this.sendError(clientId, `Only the host can ${action.replace('-', ' ')}`);
            return true;
        }
        const target = typeof payload.userId === 'string' ? payload.userId : '';
        if (!target) {
            this.sendError(clientId, `userId is required on ${action}`);
            return true;
        }
        if (target === actorUserId) {
            this.sendError(clientId, `The host cannot ${action.replace('-', ' ')} themself`);
            return true;
        }
        const members = await this.docCallMemberClientIds(callId);
        const targetClients = members.filter((c) => meta.clients?.[c] === target);
        const inCall = meta.invites[target]?.state === 'accepted' || targetClients.length > 0;
        if (!inCall) {
            this.sendError(clientId, `${target} is not in call ${callId}`);
            return true;
        }
        const frame = (a) => ({
            type: 'call',
            action: a,
            data: { callId, userId: target, by: actorUserId },
            timestamp: new Date().toISOString(),
        });
        if (action === 'mute-participant') {
            // Every tab of theirs mutes; their participant-state follows.
            await this.sendToUsers([target], frame('mute-participant'));
            this.logger.info(`[CallService] host ${actorUserId} muted ${target} in ${callId}`);
            return true;
        }
        if (action === 'transfer-host') {
            await store.patch(callId, { hostUserId: target });
            // The old host stays a participant in their own right.
            const mine = meta.invites[actorUserId];
            await store.markInvite(callId, actorUserId, { at: mine?.at ?? meta.startedAt, state: 'accepted', ...(mine?.by ? { by: mine.by } : {}) });
            if (meta.invites[target] && meta.invites[target].state !== 'accepted') {
                await store.markInvite(callId, target, { ...meta.invites[target], state: 'accepted' });
            }
            this.logger.info(`[CallService] host of ${callId} moved ${actorUserId} → ${target}`);
            return false; // caller broadcasts the fresh call-meta
        }
        // remove-participant
        const prev = meta.invites[target];
        await store.markInvite(callId, target, { at: prev?.at ?? Date.now(), state: 'removed', by: actorUserId });
        // Tell them first, while their connections are still on the roster.
        await this.sendToUsers([target], frame('remove-participant'));
        for (const cid of targetClients) {
            this.removeClientFromCallEverywhere(callId, cid);
            await store.markClient(callId, cid, null);
            if (this.crossNodePubSub) {
                try {
                    const p = {
                        callId, departedClientId: cid, callerId: meta.hostUserId, lobbyName: meta.documentId,
                        callContinues: true, notified: true,
                    };
                    await Promise.resolve(this.crossNodePubSub.publish(CROSS_NODE_DEPARTED_TOPIC, JSON.stringify(p)));
                }
                catch { /* best-effort */ }
            }
        }
        this.clearDocLeaveTimer(callId, target);
        this.dropInviteForUser(target, callId);
        if (meta.presenting?.userId === target)
            await store.setPresenting(callId, null);
        const rest = members.filter((c) => !targetClients.includes(c));
        await this.sendToClients(rest, this.userStatusEnvelope(callId, meta, target, 'left', 'removed', { by: actorUserId }));
        this.logger.info(`[CallService] host ${actorUserId} removed ${target} from ${callId}`);
        return false;
    }
    /**
     * Routing + bookkeeping for the signalling verbs of a document call.
     * Returns true when it fully handled the action (the generic path must
     * not run), or the recipients to use when the payload named none —
     * a document call never falls back to broadcast-to-everyone.
     */
    async handleDocumentCallVerb(clientId, action, payload, meta) {
        const callId = meta.callId;
        const store = this.metaStore;
        const userId = await this.resolveActorUserId(clientId, payload, action !== 'accepted');
        if (action === 'ended') {
            if (payload.forEveryone === true) {
                if (userId !== meta.hostUserId) {
                    this.sendError(clientId, 'Only the host can end the call for everyone');
                    return { handled: true };
                }
                await this.endDocumentCall(callId, meta, 'ended-for-everyone', userId);
                return { handled: true };
            }
            await this.leaveDocumentCall(callId, meta, clientId, userId, 'left');
            return { handled: true };
        }
        if (userId && meta.invites[userId]?.state === 'removed'
            && (action === 'accepted' || action === 'participant-state')) {
            this.sendError(clientId, `You were removed from call ${callId}`);
            return { handled: true };
        }
        if (action === 'accepted' && userId) {
            this.clearDocLeaveTimer(callId, userId);
            const prev = meta.invites[userId];
            if (meta.hostUserId !== userId && prev?.state !== 'accepted') {
                await store.markInvite(callId, userId, { at: prev?.at ?? Date.now(), state: 'accepted', ...(prev?.by ? { by: prev.by } : {}) });
            }
            await store.markClient(callId, clientId, userId);
            this.dropInviteForUser(userId, callId);
        }
        if (action === 'participant-state' && userId) {
            const status = typeof payload.status === 'string' ? payload.status : 'in-call';
            const member = meta.hostUserId === userId || meta.invites[userId]?.state === 'accepted';
            if (status !== 'left' && member) {
                // Reconnect: a fresh socket re-announces itself. Put it back
                // on the roster and cancel the pending `left`.
                const local = this.activeCalls.get(callId);
                if (!local || !local.participantClientIds.has(clientId)) {
                    this.registerParticipant(callId, clientId, meta.hostUserId, meta.documentId, []);
                }
                await store.markClient(callId, clientId, userId);
                this.clearDocLeaveTimer(callId, userId);
            }
        }
        if (action === 'declined' && userId) {
            const prev = meta.invites[userId];
            if (prev && prev.state !== 'accepted') {
                await store.markInvite(callId, userId, { ...prev, state: 'declined' });
            }
            this.dropInviteForUser(userId, callId);
            const inviter = prev?.by || meta.hostUserId;
            const members = await this.docCallMemberClientIds(callId);
            const envelope = { type: 'call', action: 'declined', data: { ...payload, userId }, timestamp: new Date().toISOString() };
            await this.sendToClients(members.filter((c) => c !== clientId), envelope);
            await this.sendToUsers([inviter], envelope);
            const fresh = await store.get(callId);
            if (fresh)
                await this.broadcastCallMeta(fresh);
            this.recordCallActionMetric(action, 'targeted');
            return { handled: true };
        }
        if (action === 'cancelled') {
            // Caller stops ringing specific people; the call goes on.
            const targets = this.normalizeTargetUserIds(payload);
            for (const t of targets) {
                if (meta.invites[t] && meta.invites[t].state !== 'accepted')
                    await store.markInvite(callId, t, null);
                this.dropInviteForUser(t, callId);
            }
            const envelope = { type: 'call', action: 'cancelled', data: payload, timestamp: new Date().toISOString() };
            await this.sendToUsers(targets, envelope);
            const fresh = await store.get(callId);
            if (fresh)
                await this.broadcastCallMeta(fresh);
            this.recordCallActionMetric(action, 'targeted');
            return { handled: true };
        }
        const members = await this.docCallMemberClientIds(callId);
        if (action === 'accepted') {
            const fresh = await store.get(callId);
            if (fresh)
                await this.broadcastCallMeta(fresh, [clientId]);
        }
        return { handled: false, recipientsIfUntargeted: members.filter((c) => c !== clientId) };
    }
    /** One person leaves (explicitly). Others get `user-status: left`; the
     *  last one out ends the call. */
    async leaveDocumentCall(callId, meta, clientId, userId, reason) {
        this.removeClientFromCallEverywhere(callId, clientId);
        const members = await this.docCallMemberClientIds(callId);
        if (members.length === 0) {
            await this.endDocumentCall(callId, meta, 'last-participant-left', userId);
            return;
        }
        const stillThere = members.some((c) => meta.clients?.[c] === userId);
        if (!stillThere && userId) {
            this.clearDocLeaveTimer(callId, userId);
            await this.sendToClients(members, this.userStatusEnvelope(callId, meta, userId, 'left', reason));
            if (meta.presenting?.userId === userId) {
                await this.metaStore.setPresenting(callId, null);
                const fresh = await this.metaStore.get(callId);
                if (fresh)
                    await this.broadcastCallMeta(fresh);
            }
        }
    }
    /** The call is over for everyone: tell them, then drop every trace. */
    async endDocumentCall(callId, meta, reason, endedBy) {
        const members = await this.docCallMemberClientIds(callId);
        const envelope = {
            type: 'call',
            action: 'ended',
            data: {
                callId,
                callerId: meta.hostUserId,
                lobbyName: meta.documentId,
                reason,
                ...(reason === 'ended-for-everyone' ? { forEveryone: true } : {}),
                ...(endedBy ? { endedBy } : {}),
            },
            timestamp: new Date().toISOString(),
        };
        await this.sendToClients(members, envelope);
        // Ringing invitees stop ringing.
        const ringing = Object.entries(meta.invites).filter(([, i]) => i.state === 'ringing').map(([u]) => u);
        if (ringing.length)
            await this.sendToUsers(ringing, envelope);
        for (const key of Array.from(this.docLeaveTimers.keys())) {
            if (key.startsWith(`${callId}|`))
                this.clearDocLeaveTimerKey(key);
        }
        const hadLocal = this.activeCalls.has(callId);
        this.forgetCall(callId);
        if (!hadLocal) {
            if (this.stateStore) {
                void this.stateStore.forgetCall(callId).catch(() => { });
                if (typeof this.stateStore.forgetLobbyCall === 'function' && meta.documentId) {
                    void this.stateStore.forgetLobbyCall(meta.documentId, callId).catch(() => { });
                }
            }
            if (this.metaStore)
                await this.metaStore.delete(callId).catch(() => { });
        }
        if (this.crossNodePubSub) {
            try {
                const p = {
                    callId, departedClientId: '', callerId: meta.hostUserId, lobbyName: meta.documentId,
                    callContinues: false, notified: true,
                };
                await Promise.resolve(this.crossNodePubSub.publish(CROSS_NODE_DEPARTED_TOPIC, JSON.stringify(p)));
            }
            catch { /* best-effort */ }
        }
        this.logger.info(`[CallService] document call ${callId} ended (${reason})`);
    }
    /**
     * A participant's socket dropped. Everyone else sees them as
     * `reconnecting` for the rejoin grace; if no connection of theirs is back
     * by then, `left`. The call itself survives even when nobody else is in
     * it — a lone host refreshing the page keeps the call.
     */
    async handleDocumentDisconnect(callId, meta, clientId) {
        const userId = meta.clients?.[clientId]
            ?? (typeof this.messageRouter.getUserIdForClient === 'function' ? this.messageRouter.getUserIdForClient(clientId) : null)
            ?? '';
        this.removeClientFromCallEverywhere(callId, clientId);
        const members = await this.docCallMemberClientIds(callId);
        const stillThere = !!userId && members.some((c) => meta.clients?.[c] === userId);
        if (userId && !stillThere && members.length > 0) {
            await this.sendToClients(members, this.userStatusEnvelope(callId, meta, userId, 'reconnecting', 'peer-disconnected', {
                rejoinGraceMs: this.rejoinGraceMs,
            }));
        }
        if (this.crossNodePubSub) {
            try {
                const p = {
                    callId, departedClientId: clientId, callerId: meta.hostUserId, lobbyName: meta.documentId,
                    callContinues: true, notified: true,
                };
                await Promise.resolve(this.crossNodePubSub.publish(CROSS_NODE_DEPARTED_TOPIC, JSON.stringify(p)));
            }
            catch { /* best-effort */ }
        }
        if (!stillThere)
            this.scheduleDocLeave(callId, userId);
    }
    scheduleDocLeave(callId, userId) {
        const key = `${callId}|${userId}`;
        this.clearDocLeaveTimerKey(key);
        const fire = async () => {
            this.docLeaveTimers.delete(key);
            const meta = await this.getDocumentMeta(callId);
            if (!meta)
                return;
            const members = await this.docCallMemberClientIds(callId);
            if (members.length === 0) {
                await this.endDocumentCall(callId, meta, 'rejoin-grace-expired');
                return;
            }
            if (!userId || members.some((c) => meta.clients?.[c] === userId))
                return; // came back
            await this.sendToClients(members, this.userStatusEnvelope(callId, meta, userId, 'left', 'rejoin-grace-expired'));
            if (meta.presenting?.userId === userId) {
                await this.metaStore.setPresenting(callId, null);
                const fresh = await this.metaStore.get(callId);
                if (fresh)
                    await this.broadcastCallMeta(fresh);
            }
        };
        if (this.rejoinGraceMs <= 0) {
            void fire();
            return;
        }
        const timer = setTimeout(() => { void fire(); }, this.rejoinGraceMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.docLeaveTimers.set(key, timer);
    }
    clearDocLeaveTimer(callId, userId) {
        this.clearDocLeaveTimerKey(`${callId}|${userId}`);
    }
    clearDocLeaveTimerKey(key) {
        const t = this.docLeaveTimers.get(key);
        if (t) {
            clearTimeout(t);
            this.docLeaveTimers.delete(key);
        }
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