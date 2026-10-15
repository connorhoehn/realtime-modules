"use strict";
// realtime-modules/src/server/authority/principal.ts
//
// 0.116 — principal revalidation. A valid token is not a current session: the
// host's directory may have bumped the session epoch, revoked the signed role
// or retired a masquerading actor since the socket was admitted. The host
// supplies `revalidate(ctx)` (its directory read); the library owns WHEN it
// runs:
//
//   - at upgrade, after `auth` (a stale principal is never registered);
//   - before every channel `authorize` and, with `recheckAfterIo` (default),
//     again after the host's own decision resolved — so an epoch bump that
//     lands during the host's policy/row I/O still refuses;
//   - before (and after) every recipient filter, so a frame is not delivered
//     to a socket whose principal went stale between subscribe and fan-out;
//   - before (and after) the feature hooks that make their own decisions
//     (`calls()` frames, `notifications()` actions) through
//     `FeatureContext.principal`.
//
// `revalidate` returns false, throws or rejects → refuse. Nothing is cached:
// it runs every time.
Object.defineProperty(exports, "__esModule", { value: true });
exports.principalIsCurrent = principalIsCurrent;
exports.revalidatingAuth = revalidatingAuth;
exports.withPrincipalRevalidation = withPrincipalRevalidation;
exports.gateOnPrincipal = gateOnPrincipal;
/** Fail-closed wrapper: true only when `revalidate` resolved without refusing. */
async function principalIsCurrent(principal, ctx, scope) {
    if (!ctx)
        return false;
    try {
        return (await principal.revalidate(ctx, scope)) !== false;
    }
    catch {
        return false;
    }
}
/** The upgrade's `auth`, then a revalidation of the context it returned (throws → 401). */
function revalidatingAuth(auth, principal) {
    return async (req) => {
        const ctx = (auth ? await auth(req) : {}) || {};
        if (!await principalIsCurrent(principal, ctx))
            throw new Error('principal is not current');
        return ctx;
    };
}
/**
 * Wrap a router's `authorize` / `filterClientMessage` with principal
 * revalidation — what `attachRealtime({ principal })` does for its local
 * router. A host passing its own router (`attachRealtime({ router })`, the
 * Redis router) wraps that router's hooks with this.
 *
 * With no `authorize` the wrapped hook is revalidation alone (the router then
 * enforces: every subscribe and fan-out asks it); with no
 * `filterClientMessage`, the same for delivery.
 */
function withPrincipalRevalidation(hooks, principal, opts = {}) {
    const recheck = principal.recheckAfterIo !== false;
    const inner = hooks.authorize;
    const filter = hooks.filterClientMessage;
    const stale = (clientId) => {
        try {
            opts.onStale?.(clientId);
        }
        catch { /* observer only */ }
        return false;
    };
    const current = async (clientId, ctx, scope) => (await principalIsCurrent(principal, ctx, scope)) || stale(clientId);
    const authorize = async (args) => {
        if (!await current(args.clientId, args.ctx, args.scope))
            return false;
        if (inner) {
            let allowed = false;
            try {
                allowed = (await inner(args)) === true;
            }
            catch {
                return false;
            }
            if (!allowed)
                return false;
            if (recheck && !await current(args.clientId, args.ctx, args.scope))
                return false;
        }
        return true;
    };
    const filterClientMessage = async (args) => {
        if (!await current(args.clientId, args.ctx))
            return null;
        if (!filter)
            return args.message;
        const filtered = await filter(args);
        if (filtered == null)
            return null;
        if (recheck && !await current(args.clientId, args.ctx))
            return null;
        return filtered;
    };
    const batch = hooks.authorizeBatch;
    // Every recipient of a batch is revalidated before (and, with
    // recheckAfterIo, after) the one host call — the same fence per
    // recipient as the per-recipient path, with one policy call.
    const authorizeBatch = batch ? async (args) => {
        const verdicts = new Array(args.recipients.length).fill(false);
        const live = await Promise.all(args.recipients.map(r => current(r.clientId, r.ctx, args.scope)));
        const idx = live.flatMap((ok, i) => ok ? [i] : []);
        if (!idx.length)
            return verdicts;
        let answers = null;
        try {
            const out = await batch({ ...args, recipients: idx.map(i => args.recipients[i]) });
            answers = Array.isArray(out) && out.length === idx.length ? out : null;
        }
        catch {
            answers = null;
        }
        if (!answers)
            return verdicts;
        const allowed = idx.filter((_, j) => answers[j] === true);
        const after = recheck ? await Promise.all(allowed.map(i => current(args.recipients[i].clientId, args.recipients[i].ctx, args.scope)))
            : allowed.map(() => true);
        allowed.forEach((i, j) => { verdicts[i] = after[j]; });
        return verdicts;
    } : undefined;
    return { authorize, filterClientMessage, ...(authorizeBatch ? { authorizeBatch } : {}) };
}
/**
 * Gate a feature hook `(clientId, …) => boolean | Promise<boolean>` on the
 * connection's principal before and (with `recheckAfterIo`) after it.
 * Absent principal: the hook unchanged.
 */
function gateOnPrincipal(principal, hook) {
    if (!principal)
        return hook ? (async (...args) => (await hook(...args)) === true) : undefined;
    return async (...args) => {
        const clientId = args[0];
        if (!await principal.current(clientId))
            return false;
        if (!hook)
            return true;
        let allowed = false;
        try {
            allowed = (await hook(...args)) === true;
        }
        catch {
            return false;
        }
        if (!allowed)
            return false;
        return !principal.recheckAfterIo || await principal.current(clientId);
    };
}
//# sourceMappingURL=principal.js.map