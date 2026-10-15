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
export declare function principalIsCurrent(principal: PrincipalRevalidation, ctx: WsAuthContext | null | undefined, scope?: AuthorityScope): Promise<boolean>;
/** The upgrade's `auth`, then a revalidation of the context it returned (throws → 401). */
export declare function revalidatingAuth(auth: WsAuthFn | undefined, principal: PrincipalRevalidation): WsAuthFn;
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
export declare function withPrincipalRevalidation(hooks: {
    authorize?: ChannelAuthorize | undefined;
    filterClientMessage?: ClientMessageFilter | undefined;
    authorizeBatch?: ChannelAuthorizeBatch | undefined;
}, principal: PrincipalRevalidation, opts?: {
    /**
     * 0.119 (lane R6): told the connection whose principal was refused —
     * the verdict cache drops its entries here (verdictCache.ts V4).
     */
    onStale?: (clientId: string) => void;
}): {
    authorize: ChannelAuthorize;
    filterClientMessage: ClientMessageFilter;
    authorizeBatch?: ChannelAuthorizeBatch;
};
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
export declare function gateOnPrincipal<Args extends [string, ...unknown[]]>(principal: FeaturePrincipal | undefined, hook: ((...args: Args) => boolean | Promise<boolean>) | undefined): ((...args: Args) => Promise<boolean>) | undefined;
//# sourceMappingURL=principal.d.ts.map