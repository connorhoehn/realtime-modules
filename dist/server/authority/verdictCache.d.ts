import type { WsAuthContext } from '../../server-ws/types';
import type { ChannelAuthorize, ChannelAuthorizeBatch } from '../router';
export interface AuthorityCacheOptions {
    /**
     * The principal's current directory epoch. Read on EVERY check, so it
     * must be cheap and current (an in-memory directory mirror, a session
     * epoch the host updates when it bumps it). null/undefined: do not cache.
     */
    epoch(ctx: WsAuthContext, clientId: string): string | number | null | undefined;
    /** Entry lifetime. Default 5000 ms; 1–300000. */
    maxAgeMs?: number;
    /** Bound on stored verdicts. Default 100000. */
    maxEntries?: number;
    /** Kinds to cache. Default both. */
    kinds?: ReadonlyArray<'subscribe' | 'publish'>;
    /** Clock, for tests. */
    now?: () => number;
}
export interface AuthorityCacheStats {
    entries: number;
    hits: number;
    misses: number;
    stores: number;
    /** Entries dropped by an epoch change, a context change or a revalidation failure. */
    fenced: number;
    /** Explicit invalidation calls. */
    invalidations: number;
}
export interface AuthorityVerdictCache {
    /** Drop every verdict on this channel (all service prefixes of its base name). */
    invalidateChannel(channel: string): void;
    /** Drop every verdict held by this user's connections. */
    invalidateUser(userId: string): void;
    /** Drop every verdict of one connection. */
    invalidateConnection(clientId: string): void;
    /** Drop everything. */
    clear(): void;
    stats(): AuthorityCacheStats;
}
/**
 * Wrap a host `authorize` (and optionally its `authorizeBatch`) with the
 * verdict cache. Compose principal revalidation OUTSIDE the result (V4):
 *
 *   const cached = withAuthorityCache(hostAuthorize, { epoch: ctx => directory.epochOf(ctx.sid) });
 *   const hooks = withPrincipalRevalidation({ authorize: cached.authorize }, principal,
 *       { onStale: id => cached.cache.invalidateConnection(id) });
 *   membership.onCommittedWrite(channel => cached.cache.invalidateChannel(channel));
 */
export declare function withAuthorityCache(authorize: ChannelAuthorize, opts: AuthorityCacheOptions, authorizeBatch?: ChannelAuthorizeBatch): {
    authorize: ChannelAuthorize;
    authorizeBatch?: ChannelAuthorizeBatch;
    cache: AuthorityVerdictCache;
};
//# sourceMappingURL=verdictCache.d.ts.map