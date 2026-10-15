// realtime-modules/src/server/authority/verdictCache.ts
//
// 0.119 (lane R6) — an opt-in cache of POSITIVE channel verdicts per
// (connection, channel, directory epoch).
//
// Why: under a burst the host's `authorize` dominated the OrgIQ BFF —
// ~19.5k membership queries per node against 400 history reads
// (aws-agentcore docs/realtime-validation/2026-10-05/capacity-progress.md).
// The per-operation scope (authorityScope.ts) only shares a proof inside one
// send; the next send by the same socket to the same channel asks again.
//
// THE CONTRACT (V1–V7). The cache is safe only together with the host's
// epoch fence and membership events; it is opt-in for that reason.
//
//   V1. Key. An entry is (connection, auth-context object, kind, channel,
//       epoch). `epoch(ctx, clientId)` is the host's CURRENT directory epoch
//       for that principal, read on every check. A different epoch, or a
//       replaced context, is a miss and drops every entry of that connection.
//       `epoch` returning null/undefined (or throwing) disables caching for
//       that check: the host is asked, nothing is stored.
//   V2. Only `true` is stored. A refusal (false, throw, rejection) is never
//       cached and deletes any entry for that key, so a refusal can never
//       outlive anything — let alone an epoch.
//   V3. Membership events. `invalidateChannel(channel)` (any service prefix
//       of the same base channel included), `invalidateUser(userId)`,
//       `invalidateConnection(clientId)` and `clear()` take effect for the
//       very next check. A verdict whose host call was IN FLIGHT when a
//       matching invalidation arrived is returned to that caller but not
//       stored.
//   V4. Principal fence. `withPrincipalRevalidation` wraps OUTSIDE the cache
//       (attachRealtime composes it that way), so `revalidate` still runs on
//       every check, hits included; a revalidation failure drops the
//       connection's entries (`onStale`).
//   V5. Age. An entry older than `maxAgeMs` (default 5 s, max 300 s) is a
//       miss. This bounds staleness for a host that misses an event; it is
//       not the revocation path (V1/V3 are).
//   V6. Size. At most `maxEntries` (default 100k); the oldest is evicted.
//   V7. Disconnect. The connection's entries are dropped when it closes
//       (attachRealtime wires `invalidateConnection` to the disconnect).

import { baseChannel } from '../../server-ws/channelAccess';
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

type Entry = { key: string; clientId: string; userId: string | null; base: string; ctx: WsAuthContext; epoch: string | number; at: number };
type InFlight = { clientId: string; userId: string | null; base: string; tainted: boolean };

const SEP = '\u0000';

function addTo(index: Map<string, Set<string>>, k: string, key: string): void {
    const set = index.get(k);
    if (set) set.add(key); else index.set(k, new Set([key]));
}
function removeFrom(index: Map<string, Set<string>>, k: string | null, key: string): void {
    if (k === null) return;
    const set = index.get(k);
    if (!set) return;
    set.delete(key);
    if (!set.size) index.delete(k);
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
export function withAuthorityCache(
    authorize: ChannelAuthorize,
    opts: AuthorityCacheOptions,
    authorizeBatch?: ChannelAuthorizeBatch,
): { authorize: ChannelAuthorize; authorizeBatch?: ChannelAuthorizeBatch; cache: AuthorityVerdictCache } {
    if (typeof opts?.epoch !== 'function') throw new Error('authorityCache.epoch must be a function');
    const maxAgeMs = opts.maxAgeMs ?? 5000;
    const maxEntries = opts.maxEntries ?? 100_000;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300_000) throw new Error('authorityCache.maxAgeMs must be 1–300000');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('authorityCache.maxEntries must be a positive integer');
    const kinds = new Set(opts.kinds ?? ['subscribe', 'publish']);
    const now = opts.now ?? Date.now;

    const entries = new Map<string, Entry>();
    const byConn = new Map<string, Set<string>>();
    const byBase = new Map<string, Set<string>>();
    const byUser = new Map<string, Set<string>>();
    const inFlight = new Set<InFlight>();
    const counters = { hits: 0, misses: 0, stores: 0, fenced: 0, invalidations: 0 };

    const drop = (key: string): void => {
        const e = entries.get(key);
        if (!e) return;
        entries.delete(key);
        removeFrom(byConn, e.clientId, key);
        removeFrom(byBase, e.base, key);
        removeFrom(byUser, e.userId, key);
    };
    const dropAll = (keys: Set<string> | undefined): number => {
        if (!keys) return 0;
        const list = [...keys];
        for (const key of list) drop(key);
        return list.length;
    };
    const userOf = (ctx: WsAuthContext | null | undefined): string | null =>
        ctx && typeof ctx.userId === 'string' && ctx.userId ? ctx.userId : null;
    const epochOf = (ctx: WsAuthContext, clientId: string): string | number | null => {
        try {
            const e = opts.epoch(ctx, clientId);
            return typeof e === 'string' || (typeof e === 'number' && Number.isFinite(e)) ? e : null;
        } catch { return null; }
    };

    const cache: AuthorityVerdictCache = {
        invalidateChannel(channel: string): void {
            counters.invalidations++;
            const base = baseChannel(channel);
            dropAll(byBase.get(base));
            for (const f of inFlight) if (f.base === base) f.tainted = true;
        },
        invalidateUser(userId: string): void {
            counters.invalidations++;
            dropAll(byUser.get(userId));
            for (const f of inFlight) if (f.userId === userId) f.tainted = true;
        },
        invalidateConnection(clientId: string): void {
            counters.invalidations++;
            dropAll(byConn.get(clientId));
            for (const f of inFlight) if (f.clientId === clientId) f.tainted = true;
        },
        clear(): void {
            counters.invalidations++;
            entries.clear(); byConn.clear(); byBase.clear(); byUser.clear();
            for (const f of inFlight) f.tainted = true;
        },
        stats: () => ({ entries: entries.size, ...counters }),
    };

    /** A live hit, or null. Fences (V1, V5) drop what they find stale. */
    const lookup = (kind: string, clientId: string, channel: string, ctx: WsAuthContext, epoch: string | number): boolean => {
        const key = clientId + SEP + kind + SEP + channel;
        const e = entries.get(key);
        if (!e) return false;
        if (e.ctx !== ctx || e.epoch !== epoch) {
            // V1: the epoch (or the principal object) moved — nothing this
            // connection proved under the old one survives.
            counters.fenced += dropAll(byConn.get(clientId));
            return false;
        }
        if (now() - e.at >= maxAgeMs) { drop(key); return false; }
        return true;
    };
    const store = (kind: string, clientId: string, channel: string, ctx: WsAuthContext, epoch: string | number): void => {
        const key = clientId + SEP + kind + SEP + channel;
        drop(key);
        // A context/epoch change seen at store time also fences the rest.
        const first = byConn.get(clientId);
        if (first && first.size) {
            const sample = entries.get(first.values().next().value as string);
            if (sample && (sample.ctx !== ctx || sample.epoch !== epoch)) counters.fenced += dropAll(byConn.get(clientId));
        }
        while (entries.size >= maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            drop(oldest);
        }
        const e: Entry = { key, clientId, userId: userOf(ctx), base: baseChannel(channel), ctx, epoch, at: now() };
        entries.set(key, e);
        addTo(byConn, clientId, key);
        addTo(byBase, e.base, key);
        if (e.userId !== null) addTo(byUser, e.userId, key);
        counters.stores++;
    };

    /** Ask the host for one check, storing a clean positive (V2, V3). */
    const askOne = async (args: Parameters<ChannelAuthorize>[0], epoch: string | number | null): Promise<boolean> => {
        const { kind, clientId, channel, ctx } = args;
        const flight: InFlight = { clientId, userId: userOf(ctx), base: baseChannel(channel), tainted: false };
        inFlight.add(flight);
        let allowed = false;
        try {
            allowed = (await authorize(args)) === true;
        } catch {
            allowed = false;
        } finally {
            inFlight.delete(flight);
        }
        if (!ctx || epoch === null) return allowed;
        if (!allowed) { drop(clientId + SEP + kind + SEP + channel); return false; }
        // Store only if nothing matching was invalidated during the call and
        // the epoch is still the one we asked under.
        if (!flight.tainted && epochOf(ctx, clientId) === epoch) store(kind, clientId, channel, ctx, epoch);
        return true;
    };

    const cachedAuthorize: ChannelAuthorize = (args) => {
        const { kind, clientId, channel, ctx } = args;
        if (!ctx || !kinds.has(kind)) return askOne(args, null);
        const epoch = epochOf(ctx, clientId);
        if (epoch === null) return askOne(args, null);
        if (lookup(kind, clientId, channel, ctx, epoch)) { counters.hits++; return true; }
        counters.misses++;
        return askOne(args, epoch);
    };

    let cachedBatch: ChannelAuthorizeBatch | undefined;
    if (authorizeBatch) {
        cachedBatch = async (args) => {
            const { channel, recipients } = args;
            const verdicts: boolean[] = new Array(recipients.length).fill(false);
            const missIdx: number[] = [];
            const epochs: Array<string | number | null> = new Array(recipients.length).fill(null);
            const cacheable = kinds.has('subscribe');
            recipients.forEach((r, i) => {
                const epoch = cacheable ? epochOf(r.ctx, r.clientId) : null;
                epochs[i] = epoch;
                if (epoch !== null && lookup('subscribe', r.clientId, channel, r.ctx, epoch)) { counters.hits++; verdicts[i] = true; return; }
                if (epoch !== null) counters.misses++;
                missIdx.push(i);
            });
            if (!missIdx.length) return verdicts;
            const flights = missIdx.map(i => ({ clientId: recipients[i].clientId, userId: userOf(recipients[i].ctx), base: baseChannel(channel), tainted: false }));
            for (const f of flights) inFlight.add(f);
            let answers: ReadonlyArray<boolean> | null = null;
            try {
                const out = await authorizeBatch({ ...args, recipients: missIdx.map(i => recipients[i]) });
                answers = Array.isArray(out) && out.length === missIdx.length ? out : null;
            } catch {
                answers = null;
            } finally {
                for (const f of flights) inFlight.delete(f);
            }
            missIdx.forEach((i, j) => {
                const r = recipients[i];
                const allowed = answers !== null && answers[j] === true;
                verdicts[i] = allowed;
                const epoch = epochs[i];
                if (epoch === null) return;
                if (!allowed) { drop(r.clientId + SEP + 'subscribe' + SEP + channel); return; }
                if (!flights[j].tainted && epochOf(r.ctx, r.clientId) === epoch) store('subscribe', r.clientId, channel, r.ctx, epoch);
            });
            return verdicts;
        };
    }

    return { authorize: cachedAuthorize, ...(cachedBatch ? { authorizeBatch: cachedBatch } : {}), cache };
}
