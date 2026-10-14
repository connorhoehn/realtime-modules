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
function withPrincipalRevalidation(hooks, principal) {
    const recheck = principal.recheckAfterIo !== false;
    const inner = hooks.authorize;
    const filter = hooks.filterClientMessage;
    const authorize = async (args) => {
        if (!await principalIsCurrent(principal, args.ctx, args.scope))
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
            if (recheck && !await principalIsCurrent(principal, args.ctx, args.scope))
                return false;
        }
        return true;
    };
    const filterClientMessage = async (args) => {
        if (!await principalIsCurrent(principal, args.ctx))
            return null;
        if (!filter)
            return args.message;
        const filtered = await filter(args);
        if (filtered == null)
            return null;
        if (recheck && !await principalIsCurrent(principal, args.ctx))
            return null;
        return filtered;
    };
    return { authorize, filterClientMessage };
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