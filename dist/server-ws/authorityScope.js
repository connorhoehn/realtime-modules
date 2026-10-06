"use strict";
// realtime-modules/src/server-ws/authorityScope.ts
//
// A per-OPERATION authority scope: one object the library creates for one
// fan-out, one inbound action or one chat send, and hands to every channel
// authorization (`attachRealtime({ authorize })` receives it as `scope`) and
// membership read (`ChatMembershipStore.listMembers(channel, { scope })`) that
// operation makes. A host may resolve ONE proof per channel per operation in
// `scope.share(key, compute)` instead of one per recipient / per check.
//
// Why: a chat send asked the host the same membership question ~25 times in
// sequence (publish pre-check, three post-persist publish rechecks, the
// recipient list, one subscribe check per recipient, one notify probe per
// live audience member). Each was a strongly consistent read of the same
// rows a few milliseconds apart.
//
// THE CONTRACT. This is NOT a cache, and must never become one.
//
//   1. Lifetime. A scope lives for one operation. `close()` (the library
//      calls it when the operation ends) clears the memo and turns `share`
//      into a pass-through that computes fresh every time. Nothing in a
//      scope outlives its operation; there is no settled positive answer.
//
//   2. Revocation. A host that memoizes a proof in a scope MUST keep that
//      proof revocable for the rest of the operation: observe membership
//      writes / peer revocation hints from BEFORE the proof's read starts,
//      and when one arrives, either `scope.invalidate(key)` (the next check
//      reads fresh) or make the shared proof itself answer deny. Remaining
//      recipients of a fan-out that is still running are then refused. The
//      library's own fences (connection context, subscription token,
//      admission generation) still run per recipient after every decision,
//      shared or not.
//
//   3. Optional. A host that ignores `scope` gets exactly the old behaviour:
//      one authorize call per check. The library never memoizes a decision
//      itself — it only names the operation. The single exception is the
//      opt-in publish proof (0.109, `publishProofMaxAgeMs`), whose own
//      contract (P1-P5) is at the end of this file.
//
// Scopes nest by reuse, not by stacking: an operation that already holds a
// scope passes it down (`sendToChannel(..., { scope })`), and the router uses
// it rather than opening another. A scope the caller passed in is closed by
// the caller, never by the callee.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLISH_PROOF_SKEW_MS = void 0;
exports.createAuthorityScope = createAuthorityScope;
exports.scopeFor = scopeFor;
exports.publishProofKey = publishProofKey;
exports.sharePublishProof = sharePublishProof;
exports.revokePublishProofs = revokePublishProofs;
exports.publishProofStartedAt = publishProofStartedAt;
exports.acceptsOriginPublishProof = acceptsOriginPublishProof;
let nextScopeId = 1;
function createAuthorityScope(operation) {
    const memo = new Map();
    const closers = [];
    let active = true;
    let closing = false;
    let retains = 0;
    const finish = () => {
        if (!active)
            return;
        active = false;
        memo.clear();
        for (const fn of closers.splice(0)) {
            try {
                fn();
            }
            catch { /* a host cleanup never fails the operation */ }
        }
    };
    const scope = {
        id: nextScopeId++,
        operation,
        get active() { return active; },
        memo,
        share(key, compute) {
            if (!active)
                return compute();
            if (memo.has(key))
                return memo.get(key);
            const value = compute();
            memo.set(key, value);
            if (value && typeof value.then === 'function') {
                value.then(undefined, () => {
                    if (memo.get(key) === value)
                        memo.delete(key);
                });
            }
            return value;
        },
        invalidate(key) {
            if (key === undefined)
                memo.clear();
            else
                memo.delete(key);
        },
        onClose(fn) {
            if (!active) {
                try {
                    fn();
                }
                catch { /* ignore */ }
                return;
            }
            closers.push(fn);
        },
        retain() {
            if (!active)
                return () => undefined;
            retains++;
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                retains--;
                if (closing && retains === 0)
                    finish();
            };
        },
        close() {
            closing = true;
            if (retains === 0)
                finish();
        },
    };
    return scope;
}
/** The caller's scope when it is still active, or a new one this call owns. */
function scopeFor(existing, operation) {
    if (existing && existing.active)
        return { scope: existing, owned: false };
    return { scope: createAuthorityScope(operation), owned: true };
}
// ---------------------------------------------------------------------------
// Publish proofs (0.109). OPT-IN: a router does this only when it was built
// with `publishProofMaxAgeMs > 0` (`attachRealtime({ publishProofMaxAgeMs })`,
// `new RedisRealtimeRouter({ publishProofMaxAgeMs })`). Off, every publish
// check asks `authorize`, exactly as before.
//
// Why: one chat send asked the host the SAME sender-side publish question up
// to seven times on its origin node (chat's pre-check, pre-persist and
// post-persist rechecks, the cluster router's pre- and post-local checks, the
// local router's check, the ack recheck) and once more on every peer node.
// Each was a full directory/policy evaluation for one (principal, channel)
// a few milliseconds apart.
//
// THE CONTRACT. Point 3 above ("the library never memoizes a decision
// itself") is relaxed for exactly this case and nothing else:
//
//   P1. What is shared. One `publish` decision per (clientId, channel) per
//       operation scope, keyed `publishProofKey(channel, clientId)` in
//       `scope.memo`. Never `subscribe` decisions: every recipient of every
//       fan-out, on every node, is still asked individually.
//   P2. Lifetime. Only while the scope is active (P2a) AND only while the
//       proof is younger than the router's `publishProofMaxAgeMs`, measured
//       from when its `authorize` call STARTED (P2b). After either, the next
//       check asks fresh and replaces the proof.
//   P3. Identity. A proof is bound to the auth-context object it was asked
//       for. A replaced connection context never reuses it. The router's
//       per-check fences (handle, connection context, subscription token,
//       admission generation) still run after every decision, shared or not.
//   P4. Revocation. A host that observes a revocation during the operation
//       (membership write, peer hint) MUST call `revokePublishProofs(scope)`
//       (or `scope.invalidate()`); the next publish check — chat's
//       post-persist recheck, the cluster router's post-local check — then
//       asks fresh. A rejected or thrown decision is never kept; a denial is
//       kept (it can only deny again).
//   P5. Peers. A cluster router that published under a live allowed proof
//       may carry ONE content-free number to peer nodes: the proof's start
//       time (`publisher.proofAt`, wall clock). A peer whose OWN
//       `publishProofMaxAgeMs` is > 0 accepts it only while
//       `now - proofAt <= its max age` and `proofAt <= now + PUBLISH_PROOF_SKEW_MS`,
//       and then skips ONLY the redundant sender-side publish re-check. It
//       still requires the publisher's live registration (same instance and
//       generation as the frame names) and the origin's live ownership, and
//       it ALWAYS runs its own fresh `subscribe` authorize for every local
//       recipient before delivery — a recipient revoked on the peer is
//       denied whatever the marker says. An absent, stale, future or
//       malformed marker, or a peer with the option off, re-checks the
//       publisher exactly as before.
//
//   P6. Peer operation scopes (0.110, OPT-IN: `RedisRealtimeRouter`'s
//       `peerOperationLingerMs` > 0). A cross-node chat send reached each
//       peer as TWO frames — the notify plugin's readable-subscription probe
//       (`subscription-check`) and the fan-out (`channel`) — and the peer
//       opened a fresh scope for each, so the host read the same membership
//       rows twice for one recipient a few ms apart. Opted in, the origin
//       stamps both with its operation's scope id (`op`, one number), and
//       the peer runs every frame of one (origin instance, op) under ONE
//       scope. That scope is still bound to the operation: it opens with the
//       first frame, stays open while any frame runs, and closes at most
//       `peerOperationLingerMs` (<= 2000) after the last one finishes — or
//       at once when the router fences or shuts down. It is a scope like any
//       other: every check still calls `authorize` (directory, actor, policy
//       per check), recipient `subscribe` checks are never shared (P1), the
//       router's per-recipient fences still run, and a host's shared proof
//       must stay revocable (point 2) for the scope's whole life, so a
//       membership write or peer hint during the linger denies or rereads.
//       A frame without `op`, an over-bound table or the option off gets a
//       per-frame scope (fan-out) or none (probe), exactly as before.
// ---------------------------------------------------------------------------
/** Clock tolerance a peer allows for a publish proof stamped in its future. */
exports.PUBLISH_PROOF_SKEW_MS = 250;
const PUBLISH_PROOF_PREFIX = 'publish-proof\u0000';
/** The scope memo key of one (channel, clientId) publish proof. */
function publishProofKey(channel, clientId) {
    return `${PUBLISH_PROOF_PREFIX}${channel}\u0000${clientId}`;
}
function isPublishProof(value) {
    return !!value && typeof value === 'object' && 'startedAt' in value && 'decision' in value;
}
/**
 * The operation's publish decision for (clientId, channel), asking `ask()`
 * only when there is no live proof for this exact context younger than
 * `maxAgeMs` (P1-P4). Returns `ask()`'s raw decision; callers apply their
 * own per-check fences. With an inactive scope or `maxAgeMs <= 0` this is
 * just `ask()`.
 */
function sharePublishProof(scope, clientId, channel, context, maxAgeMs, ask) {
    if (!scope?.active || !(maxAgeMs > 0))
        return ask();
    const key = publishProofKey(channel, clientId);
    const existing = scope.memo.get(key);
    const now = Date.now();
    if (isPublishProof(existing) && existing.context === context && now - existing.startedAt <= maxAgeMs) {
        return existing.decision;
    }
    scope.memo.delete(key);
    const decision = ask();
    const proof = { startedAt: now, context, decision };
    if (typeof decision === 'boolean') {
        proof.allowed = decision;
    }
    else {
        decision.then(allowed => { proof.allowed = allowed === true; }, () => { if (scope.memo.get(key) === proof)
            scope.memo.delete(key); });
    }
    // A scope that closed while `ask()` ran stores nothing (P2a).
    if (scope.active)
        scope.memo.set(key, proof);
    return decision;
}
/**
 * Drop publish proofs from a running operation (P4): every proof in the
 * scope, or only those for `channel` (the exact channel string the router
 * authorized, e.g. `presence:<ch>` for presence). Returns how many dropped.
 */
function revokePublishProofs(scope, channel) {
    if (!scope)
        return 0;
    const prefix = channel === undefined ? PUBLISH_PROOF_PREFIX : `${PUBLISH_PROOF_PREFIX}${channel}\u0000`;
    let dropped = 0;
    for (const key of [...scope.memo.keys()]) {
        if (typeof key === 'string' && key.startsWith(prefix)) {
            scope.memo.delete(key);
            dropped++;
        }
    }
    return dropped;
}
/**
 * Start time of a live, settled, ALLOWED publish proof for (clientId,
 * channel) that is still younger than `maxAgeMs` — the peer marker (P5) —
 * or null.
 */
function publishProofStartedAt(scope, clientId, channel, maxAgeMs) {
    if (!scope?.active || !(maxAgeMs > 0))
        return null;
    const proof = scope.memo.get(publishProofKey(channel, clientId));
    if (!isPublishProof(proof) || proof.allowed !== true)
        return null;
    return Date.now() - proof.startedAt <= maxAgeMs ? proof.startedAt : null;
}
/** P5, the peer side: may a peer skip the sender-side publish re-check? */
function acceptsOriginPublishProof(proofAt, maxAgeMs, now = Date.now()) {
    if (!(maxAgeMs > 0) || typeof proofAt !== 'number' || !Number.isFinite(proofAt))
        return false;
    return proofAt <= now + exports.PUBLISH_PROOF_SKEW_MS && now - proofAt <= maxAgeMs;
}
//# sourceMappingURL=authorityScope.js.map