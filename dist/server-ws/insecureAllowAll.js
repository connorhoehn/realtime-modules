"use strict";
// realtime-modules/src/server-ws/insecureAllowAll.ts
//
// 0.147.0 (lane: fail-closed): every authorization hook is required. A
// constructor or attach point whose hook is missing throws at startup, unless
// the host passes `insecureAllowAll: true`, the one shared opt-out. It is for
// local development only: it logs one loud warning and is refused outright
// when NODE_ENV is 'production'.
Object.defineProperty(exports, "__esModule", { value: true });
exports.acceptInsecureAllowAll = acceptInsecureAllowAll;
exports.routerAllowsAll = routerAllowsAll;
exports.requireHook = requireHook;
exports._resetInsecureAllowAllWarning = _resetInsecureAllowAllWarning;
let warned = false;
/** Whether this process runs with NODE_ENV=production. */
function isProduction() {
    try {
        return typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
    }
    catch {
        return false;
    }
}
/**
 * Accept or refuse the `insecureAllowAll` opt-out for `component`. Returns
 * true when the flag is set and allowed. Throws when it is set under
 * NODE_ENV=production. The first acceptance in the process logs one warning.
 */
function acceptInsecureAllowAll(component, flag) {
    if (flag !== true)
        return false;
    if (isProduction()) {
        throw new Error(`${component}: insecureAllowAll is refused when NODE_ENV=production; pass the authorization hooks instead`);
    }
    if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn(`[realtime-modules] WARNING: insecureAllowAll is on (${component}). Authorization hooks are skipped: any connection may read and write anything. Local development only; never deploy this.`);
    }
    return true;
}
/** Routers a service accepted under the opt-out (a custom router with no channel check). */
const openRouters = new WeakSet();
/**
 * True when a router was built with the opt-out, or a service accepted the
 * opt-out for it (its warning already ran). The shared channel check lets
 * such a router's channels through instead of refusing them.
 */
function routerAllowsAll(router) {
    if (!router || typeof router !== 'object')
        return false;
    return router.insecureAllowAll === true || openRouters.has(router);
}
/**
 * Throw unless `present`, or the opt-out is accepted (`flag`, or a router built
 * with it). `hook` names what the host must pass, e.g. "an auth hook".
 */
function requireHook(component, hook, present, flag, router) {
    if (present)
        return;
    if (routerAllowsAll(router) && !isProduction())
        return;
    if (acceptInsecureAllowAll(component, flag)) {
        // Only a router with no channel check of its own is opened; an
        // enforcing router keeps enforcing for every other service.
        if (router && typeof router === 'object' && typeof router.checkChannel !== 'function') {
            openRouters.add(router);
        }
        return;
    }
    throw new Error(`${component}: ${hook} is required (or insecureAllowAll: true, local development only)`);
}
/** Test seam: let the next acceptance warn again. */
function _resetInsecureAllowAllWarning() {
    warned = false;
}
//# sourceMappingURL=insecureAllowAll.js.map