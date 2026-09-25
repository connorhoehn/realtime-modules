import { type CallAction, type CallInvite, type CallLogger, type CallMessageRouter, type CallServiceOptions } from './types';
/** Dedup identity for an invite: the call PLUS who is being rung.
 *  Broadcast invites (no targets) collapse to the callId, which is the
 *  old behaviour and correct for them — a broadcast re-fired within the
 *  window really is a duplicate. */
export declare function inviteDedupKey(callId: string, targetUserIds: string[]): string;
export declare class CallService {
    private static INVITE_TTL_MS;
    private static INVITE_SWEEP_INTERVAL_MS;
    /** PR-W2.1 (completion) — write-through TTLs in SECONDS for the
     *  cluster-wide CallStateStore mirror. INVITE_TTL_SEC matches the
     *  60s wall-clock invite TTL; ACCEPTED_CALL_TTL_SEC is the 4h
     *  safety-net used for accepted calls (mirrors the Redis-store
     *  internal TTL_SECONDS so accepted calls don't get reaped mid-
     *  conversation). */
    private static INVITE_TTL_SEC;
    private static ACCEPTED_CALL_TTL_SEC;
    messageRouter: CallMessageRouter;
    logger: CallLogger;
    private authorize;
    private canCallHook;
    private recordCallActionHook;
    private persistBindingHook;
    private callEndedHook;
    /** Fast local cache of active calls. PR-W2.1: still maintained
     *  per-node so handleDisconnect can find calls this client was in
     *  without a Redis SMEMBERS roundtrip. Authoritative state lives in
     *  the CallStateStore (Redis when wired); peer nodes read THAT.
     *  Local cache is a write-through view: every mutation here also
     *  mirrors to stateStore. */
    private activeCalls;
    private clientToCalls;
    private inviteSweepTimer;
    /** PR-W2.1 — kept ONLY as a fallback when stateStore is null
     *  (single-node deployments without Redis). When stateStore is
     *  wired, these three are unused — stateStore.markAccepted /
     *  markRecentInvite / registerInvite carry the cluster-wide truth.
     *  Marked private + non-readonly so the existing sweep loop can still
     *  reference them in the fallback path. */
    private activeInvitesByUserId;
    private acceptedCallIds;
    private recentInvites;
    private crossNodePubSub;
    private crossNodeUnsubscribe;
    /** W11 — durable cross-cluster store. When wired, mirrors writes
     *  to Redis so peer nodes + restarts can recover state. The local
     *  `activeCalls` Map stays as a per-node cache for fast disconnect
     *  routing — disconnect's first step is "find calls this client
     *  was in", and a local Map lookup is faster than a Redis SMEMBERS. */
    private stateStore;
    /**
     * W3 — RoomService bridge. When set, `room:*` lobby participant-
     * state / user-status envelopes mirror into the room occupancy
     * tracker without requiring a separate platform-api → gateway HTTP
     * roundtrip. Optional — left null in tests + when the room service
     * isn't mounted. See server.ts wiring for the contract.
     */
    private roomBridge;
    /**
     * W3 — dedup set of (slug|clientId) pairs already mirrored to
     * RoomService.handleMemberJoined. participant-state envelopes
     * arrive frequently (every name/screen-share change) but the
     * room-membership semantic is "joined once until disconnect/left".
     * This set ensures we call handleMemberJoined exactly once per
     * unique (slug, clientId) pair within a call lifetime.
     */
    private roomMembershipMirrored;
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
    private roomCalls;
    /**
     * PR-W2.4 — sync leadership check + skip-metric hook for the
     * invite-sweep timer.  Both are optional: when omitted the sweeper
     * runs every tick (single-node / pre-PR behaviour).  Wired by
     * server.ts from createSweeperLeader(SWEEPER_SENTINELS.CALL_INVITE)
     * + recordCleanupSkipped('call_invite', ...).
     */
    private sweeperIsLeader;
    /** F2 — pending end-of-call timers for calls in the rejoin grace
     *  window (disconnect left <=1 participants; teardown deferred so a
     *  refreshing peer can come back). callId → timer. */
    private rejoinGraceTimers;
    private rejoinGraceMs;
    private onSweepSkipped;
    private readonly _withSpan;
    /** Document calls (2026-09-24) — see CallServiceOptions.metaStore. */
    private metaStore;
    private onOfflineInviteHook;
    private isClientAliveHook;
    /** Document calls — `<callId>|<userId>` → timer that turns a
     *  `reconnecting` participant into `left` when the grace runs out. */
    private docLeaveTimers;
    /** Calls whose registration has reached the shared store at least once —
     *  after that, "not in the store" means gone. */
    private storeMirrored;
    /** Roster size last pushed to ringing invitees, per call — so every
     *  participant-state (mic toggles) does not re-push an unchanged roster. */
    private lastRingingPush;
    /** Guards against two overlapping sweep ticks (the tick is async now). */
    private sweepRunning;
    constructor(opts: CallServiceOptions);
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
    private handleCrossNodeDeparted;
    /**
     * Inner per-call fan-out used by {@link handleCrossNodeDeparted}.
     * Resolves the call's participants from stateStore + local cache,
     * filters to local-live clientIds, sends synthetic `ended`, and
     * cleans local state. Returns the count of notified peers.
     */
    private notifyLocalPeersOfDeparture;
    /** Stop the cross-node subscription. Called on service shutdown. */
    dispose(): Promise<void>;
    /** Alias for {@link dispose}. The server's shutdown loop invokes
     *  `service.shutdown` on every registered service; without this
     *  alias the cross-node subscription leaked across hot reloads. */
    shutdown(): Promise<void>;
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
    setRoomBridge(bridge: {
        handleMemberJoined: (slug: string, userId: string, clientId: string, participantId: string, displayName: string) => Promise<void> | void;
        handleMemberLeft: (slug: string, userId: string, clientId: string) => Promise<void> | void;
    } | null): void;
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
    private registerParticipant;
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
    private _announceCallEnded;
    /**
     * Hand a finished call to the consumer. Never awaited: teardown is
     * synchronous and must not wait on whatever the consumer does with this.
     * A broken recorder cannot break a hang-up.
     */
    private _emitCallEnded;
    private forgetCall;
    /** UX audit 2026-08-24 — reap a call that exists only in the durable
     *  store (local cache cold) and whose every registered participant is
     *  provably dead. Mirrors the index-hygiene part of forgetCall for
     *  the store-only case: lobby index, per-user resume index, invite
     *  registry, and the call hash itself. */
    private reapDeadStoredCall;
    /**
     * UX audit 2026-08-24 — `forget` verb: durable per-user dismissal.
     * The sender says "stop offering me callId"; we remove THEIR resume
     * index + invite-registry entries so the ResumeCallDialog cannot
     * resurrect for this user in any future session. Other participants'
     * indexes are untouched — a call the peer is still happily in keeps
     * offering THEM resume. Acked to the sender with a `forgotten`
     * envelope so clients (and e2e) can await completion.
     */
    private handleForgetRequest;
    private clearInviteRegistryForCall;
    /** PR-W2.1 — cluster-wide clear of the per-user invite registry.
     *  We don't keep a reverse callId→userIds index in Redis (would
     *  triple the writes); instead we use the call's targetUserIds
     *  captured at invite time, which is what the registry was indexed
     *  by in the first place. Best-effort. */
    private clearInviteRegistryForCallStore;
    /** PR-W2.1 — local fallback for the recent-invite dedup window.
     *  Mirrors the original Map-based behaviour for when stateStore is
     *  null. Returns true if this is the first invite seen for callId in
     *  the window, false on duplicate. */
    /** `key` is an inviteDedupKey() — (callId, audience), never a bare
     *  callId. See the call site for why the audience is part of it. */
    private checkRecentInviteLocal;
    replayActiveInvitesForUser(clientId: string, userId: string): Promise<void>;
    /**
     * F3 (2026-08-21) — answer a `status` query: "is there an active call
     * in this lobby?" Reply goes to the sender only, as an `active-call`
     * envelope. Resolution order: local activeCalls cache (fast path,
     * covers single-node), then the stateStore lobby index (cluster-wide,
     * liveness-filtered through getCall).
     */
    private handleStatusQuery;
    /**
     * Push a fresh `active-call` for a document call to everyone still being
     * rung for it. Someone ringing is not in the call, so no roster frame ever
     * reaches them; without this the popover's "3 people in the call" was
     * whatever their one `status` right after the ring said (lane D/E,
     * 2026-09-25: always just the host, because everyone else accepts after
     * that). Called on every roster change of a document call.
     */
    private pushRosterToRinging;
    /** The `active-call` answer for a lobby (see handleStatusQuery). */
    private buildActiveCallData;
    handleAction(clientId: string, action: string, data: CallInvite | null | undefined): Promise<void>;
    handleCallEvent(clientId: string, action: CallAction, data: CallInvite | null | undefined): Promise<void>;
    /**
     * Pull the target user-id list out of a call payload. Returns a deduped
     * array — empty means the call should be broadcast.
     */
    normalizeTargetUserIds(payload: CallInvite): string[];
    /**
     * Return the clientIds of every connected client authenticated as any of
     * the provided userIds, excluding the sender. Delegates to MessageRouter's
     * `getClientsByUserId` seam — that method is now Redis-backed and async,
     * so this helper is async too. Cross-node routing happens transparently
     * inside `messageRouter.sendToClient(clientId, ...)`.
     */
    findClientsForUsers(userIds: string[], excludeClientId: string): Promise<string[]>;
    /**
     * Fire the optional recordCallAction hook. Wrapped in try/catch so a
     * misbehaving consumer sink can never break call routing.
     */
    recordCallActionMetric(action: CallAction, targetKind: 'targeted' | 'broadcast'): void;
    /**
     * On WS disconnect, fire synthetic `ended` envelopes to every other
     * participant of any call this client was in. Without this, peers'
     * overlays would freeze on the last frame until they hang up
     * manually. Best-effort: failures to deliver are logged, not retried.
     */
    handleDisconnect(clientId: string): Promise<void>;
    /**
     * F2 — deferred end-of-call. Fires rejoinGraceMs after a departure
     * left the call with <=1 participants and nobody re-registered.
     * Sends the synthetic `ended` to whoever is still around, fans the
     * terminal departure cross-node, and forgets the call.
     */
    private scheduleGraceEnd;
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
    runInviteSweep(now?: number): Promise<void>;
    /** Legacy half of the sweep: this node's in-memory invite registry. */
    private sweepLegacyInvites;
    /** True when anyone besides the caller is (or was) in the call — checked
     *  locally and in the cluster store, because the accept may have landed on
     *  another replica. */
    private callHasAcceptedParticipant;
    /** Drop one person's invite-replay entry for one call (local + store). */
    private dropInviteForUser;
    /** Meta half of the sweep, for one document call. */
    private sweepDocumentCall;
    /**
     * Remove roster entries whose client is provably dead — its replica went
     * away without running handleDisconnect, so nobody else will. Uses the
     * consumer's `isClientAlive` (the gateway checks the owning node's
     * heartbeat). Each person with no live connection left gets a synthetic
     * `user-status: left`; a call with nobody left ends.
     */
    private pruneDeadClients;
    /** The authenticated user behind a client, falling back to what the
     *  payload claims (SKIP_AUTH dev setups have no router identity). */
    private resolveActorUserId;
    private getDocumentMeta;
    /** Participant = the host, anyone whose invite is `accepted`, or a
     *  connection the call has seen. */
    private isDocParticipant;
    /** Connections currently in the call, cluster-wide (store) plus this
     *  node's cache. */
    private docCallMemberClientIds;
    private removeClientFromCallEverywhere;
    private sendToClients;
    /** Every connection of the given users, cluster-wide. */
    private sendToUsers;
    private userStatusEnvelope;
    /** Send `call-meta` to everyone in the call (plus `extraClientIds`). */
    private broadcastCallMeta;
    /**
     * `kind:'document-review'` invite. Writes the meta on the call's first
     * invite, marks each target ringing (online) or notified (no connected
     * client, or `ring:false`), and returns who should actually be rung.
     */
    private handleDocumentInvite;
    /** A call this node registered moments ago whose store write has not
     *  landed yet — not in the store, but not gone either. */
    private isUnmirroredYoung;
    /** A new document call starts: drop lobby-index entries that point at
     *  calls whose state is gone cluster-wide, so `status` stops finding them.
     *  Live calls are left alone. */
    private pruneLobbyIndex;
    /** `meta` / `set-documents` / `present` / `set-title`. */
    private handleDocumentCallAction;
    /**
     * Host moderation: `mute-participant`, `remove-participant`,
     * `transfer-host`. Host only; the target must be someone in the call
     * (not the host themself). Works across replicas: the target's
     * connections are found cluster-wide, the meta lives in the shared store,
     * and other nodes drop removed connections from their caches through the
     * cross-node departure topic. Returns true when it already answered (so
     * the caller must not broadcast call-meta again).
     */
    private handleModeration;
    /**
     * Routing + bookkeeping for the signalling verbs of a document call.
     * Returns true when it fully handled the action (the generic path must
     * not run), or the recipients to use when the payload named none —
     * a document call never falls back to broadcast-to-everyone.
     */
    private handleDocumentCallVerb;
    /** One person leaves (explicitly). Others get `user-status: left`; the
     *  last one out ends the call. */
    private leaveDocumentCall;
    /** The call is over for everyone: tell them, then drop every trace. */
    private endDocumentCall;
    /**
     * A participant's socket dropped. Everyone else sees them as
     * `reconnecting` for the rejoin grace; if no connection of theirs is back
     * by then, `left`. The call itself survives even when nobody else is in
     * it — a lone host refreshing the page keeps the call.
     */
    private handleDocumentDisconnect;
    private scheduleDocLeave;
    private clearDocLeaveTimer;
    private clearDocLeaveTimerKey;
    sendError(clientId: string, message: string): void;
    getStats(): {
        stateful: true;
        activeCalls: number;
        trackedClients: number;
    };
    /**
     * Read-only accessor exposing a CallStateStore-shaped view of this
     * service's state for the GET /api/calls/active resume endpoint.
     * Prefers the durable Redis stateStore when wired (multi-pod
     * visibility), and falls back to a per-process in-memory adapter
     * over `activeCalls`/`clientToCalls` so single-node deployments
     * still get a working resume dialog. Surface area is intentionally
     * narrow (the three readers the resume route actually uses).
     */
    getResumableStateStore(): import('./CallStateStore').CallStateStore;
}
export default CallService;
//# sourceMappingURL=CallService.d.ts.map