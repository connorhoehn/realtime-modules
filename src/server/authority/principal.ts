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

import type { AuthorityScope } from '../../server-ws/authorityScope';
import type { WsAuthContext, WsAuthFn } from '../../server-ws/types';
import type { ChannelAuthorize, ChannelAuthorizeBatch, ClientMessageFilter } from '../router';

export interface PrincipalRevalidation {
    /**
     * Is this connection's principal still current? Read the host directory
     * (epoch, grants, actor). Return false or throw to refuse.
     */
    revalidate(ctx: WsAuthContext, scope?: AuthorityScope): boolean | void | Promise<boolean | void>;
    /** Revalidate again after the host's decision resolved. Default true. */
    recheckAfterIo?: boolean;
}

/** Fail-closed wrapper: true only when `revalidate` resolved without refusing. */
export async function principalIsCurrent(principal: PrincipalRevalidation, ctx: WsAuthContext | null | undefined,
    scope?: AuthorityScope): Promise<boolean> {
    if (!ctx) return false;
    try { return (await principal.revalidate(ctx, scope)) !== false; } catch { return false; }
}

/** The upgrade's `auth`, then a revalidation of the context it returned (throws → 401). */
export function revalidatingAuth(auth: WsAuthFn | undefined, principal: PrincipalRevalidation): WsAuthFn {
    return async (req) => {
        const ctx = (auth ? await auth(req) : {}) || {};
        if (!await principalIsCurrent(principal, ctx)) throw new Error('principal is not current');
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
export function withPrincipalRevalidation(
    hooks: { authorize?: ChannelAuthorize | undefined; filterClientMessage?: ClientMessageFilter | undefined;
        authorizeBatch?: ChannelAuthorizeBatch | undefined },
    principal: PrincipalRevalidation,
    opts: {
        /**
         * 0.119 (lane R6): told the connection whose principal was refused —
         * the verdict cache drops its entries here (verdictCache.ts V4).
         */
        onStale?: (clientId: string) => void;
    } = {},
): { authorize: ChannelAuthorize; filterClientMessage: ClientMessageFilter; authorizeBatch?: ChannelAuthorizeBatch } {
    const recheck = principal.recheckAfterIo !== false;
    const inner = hooks.authorize;
    const filter = hooks.filterClientMessage;
    const stale = (clientId: string): false => {
        try { opts.onStale?.(clientId); } catch { /* observer only */ }
        return false;
    };
    const current = async (clientId: string, ctx: WsAuthContext | null | undefined, scope?: AuthorityScope): Promise<boolean> =>
        (await principalIsCurrent(principal, ctx, scope)) || stale(clientId);
    const authorize: ChannelAuthorize = async (args) => {
        if (!await current(args.clientId, args.ctx, args.scope)) return false;
        if (inner) {
            let allowed = false;
            try { allowed = (await inner(args)) === true; } catch { return false; }
            if (!allowed) return false;
            if (recheck && !await current(args.clientId, args.ctx, args.scope)) return false;
        }
        return true;
    };
    const filterClientMessage: ClientMessageFilter = async (args) => {
        if (!await current(args.clientId, args.ctx)) return null;
        if (!filter) return args.message;
        const filtered = await filter(args);
        if (filtered == null) return null;
        if (recheck && !await current(args.clientId, args.ctx)) return null;
        return filtered;
    };
    const batch = hooks.authorizeBatch;
    // Every recipient of a batch is revalidated before (and, with
    // recheckAfterIo, after) the one host call — the same fence per
    // recipient as the per-recipient path, with one policy call.
    const authorizeBatch: ChannelAuthorizeBatch | undefined = batch ? async (args) => {
        const verdicts: boolean[] = new Array(args.recipients.length).fill(false);
        const live = await Promise.all(args.recipients.map(r => current(r.clientId, r.ctx, args.scope)));
        const idx = live.flatMap((ok, i) => ok ? [i] : []);
        if (!idx.length) return verdicts;
        let answers: ReadonlyArray<boolean> | null = null;
        try {
            const out = await batch({ ...args, recipients: idx.map(i => args.recipients[i]) });
            answers = Array.isArray(out) && out.length === idx.length ? out : null;
        } catch { answers = null; }
        if (!answers) return verdicts;
        const allowed = idx.filter((_, j) => answers![j] === true);
        const after = recheck ? await Promise.all(allowed.map(i => current(args.recipients[i].clientId, args.recipients[i].ctx, args.scope)))
            : allowed.map(() => true);
        allowed.forEach((i, j) => { verdicts[i] = after[j]; });
        return verdicts;
    } : undefined;
    return { authorize, filterClientMessage, ...(authorizeBatch ? { authorizeBatch } : {}) };
}

/** What `FeatureContext.principal` gives a feature: the connection's principal, asked fresh. */
export interface FeaturePrincipal {
    /** Is `clientId`'s principal current now? False for an unknown connection. */
    current(clientId: string): Promise<boolean>;
    /** Revalidate again after the feature's own I/O. */
    readonly recheckAfterIo: boolean;
}

/**
 * Gate a feature hook `(clientId, …) => boolean | Promise<boolean>` on the
 * connection's principal before and (with `recheckAfterIo`) after it.
 * Absent principal: the hook unchanged.
 */
export function gateOnPrincipal<Args extends [string, ...unknown[]]>(
    principal: FeaturePrincipal | undefined,
    hook: ((...args: Args) => boolean | Promise<boolean>) | undefined,
): ((...args: Args) => Promise<boolean>) | undefined {
    if (!principal) return hook ? (async (...args: Args) => (await hook(...args)) === true) : undefined;
    return async (...args: Args) => {
        const clientId = args[0];
        if (!await principal.current(clientId)) return false;
        if (!hook) return true;
        let allowed = false;
        try { allowed = (await hook(...args)) === true; } catch { return false; }
        if (!allowed) return false;
        return !principal.recheckAfterIo || await principal.current(clientId);
    };
}
