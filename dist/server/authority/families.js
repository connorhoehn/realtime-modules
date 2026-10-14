"use strict";
// realtime-modules/src/server/authority/families.ts
//
// 0.116 — the channel-family MECHANISM a multi-tenant host used to write by
// hand. The family TABLE stays host data (which names a tenant uses, which
// services each offers, which authority each mirrors); this file owns how a
// name is read against it:
//
//   - `partitionGuard`: a name's first segment is its partition, admitted only
//     when it is the caller's own org or one of the tenants it holds, and a
//     member-addressed DM (`<p>:dm:<a>:<b>…`) admits only its listed ids;
//   - `defineChannelFamilies`: the default-deny family table — a name under a
//     partition the table governs passes only when a family lists it, and only
//     for the services that family offers (`presence:`, `chat`, …); call
//     lobbies only where the family says `lobby: true`.
//
// Everything here is synchronous and pure (no I/O, no cache): it answers the
// SHAPE question before any directory read. The fresh per-request authority
// over it is `createChannelAuthority` (./engine.ts).
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EPHEMERAL_SERVICES = exports.DEFAULT_FAMILY_SERVICES = void 0;
exports.partitionGuard = partitionGuard;
exports.defineChannelFamilies = defineChannelFamilies;
const lobbyChannel_1 = require("../../call/lobbyChannel");
const channelAccess_1 = require("../../server-ws/channelAccess");
const stringOr = (value) => (typeof value === 'string' ? value : '');
/**
 * The generic multi-tenant name rule: the first segment must be the caller's
 * org or one of its tenants, and a DM lobby admits only its listed members.
 * Fails closed on a missing user id, a name without a partition, an empty
 * remainder, and anything `next` does not admit.
 */
function partitionGuard(opts = {}) {
    const read = partitionReader(opts);
    const next = opts.next ?? (() => false);
    return (auth, name) => read(auth, name, next);
}
/** The partition + DM half, with the remainder handed to `next` per call. */
function partitionReader(opts) {
    const userIdOf = opts.userIdOf ?? ((auth) => stringOr(auth.userId));
    const orgOf = opts.orgOf ?? ((auth) => stringOr(auth.org));
    const tenantsOf = opts.tenantsOf ?? ((auth) => (Array.isArray(auth.tenants)
        ? auth.tenants.filter((t) => typeof t === 'string' && t.length > 0) : []));
    const dm = opts.dm !== false;
    return (auth, name, next) => {
        try {
            if (!auth || typeof name !== 'string')
                return false;
            const userId = userIdOf(auth);
            if (!userId)
                return false;
            const cut = name.indexOf(':');
            if (cut <= 0)
                return false;
            const partition = name.slice(0, cut);
            if (partition !== orgOf(auth) && !tenantsOf(auth).includes(partition))
                return false;
            const rest = name.slice(cut + 1);
            if (!rest)
                return false;
            if (dm) {
                const member = (0, lobbyChannel_1.dmLobbyAdmits)(rest, userId);
                if (member !== null)
                    return member;
            }
            return next(auth, name, { partition, rest, userId }) === true;
        }
        catch {
            return false;
        }
    };
}
/** The service prefixes a family table reads by default (and the bare-name service). */
exports.DEFAULT_FAMILY_SERVICES = ['presence', 'reactions', 'cursor', 'chat', 'typing', 'activity', 'pins'];
/** Services that publish under the READ authority ("I am here", not content). */
exports.DEFAULT_EPHEMERAL_SERVICES = ['presence', 'typing', 'cursor'];
/**
 * Build the default-deny family mechanism over a host's family table.
 * Fail closed throughout: an unknown service, a family without the service, a
 * name no family lists under a governed partition, a throwing host rule.
 */
function defineChannelFamilies(families, opts = {}) {
    const services = new Set(opts.services ?? exports.DEFAULT_FAMILY_SERVICES);
    const ephemeral = new Set(opts.ephemeral ?? exports.DEFAULT_EPHEMERAL_SERVICES);
    const bareService = opts.bareService ?? 'chat';
    const table = families.map((family) => ({
        family,
        services: family.services instanceof Set ? family.services : new Set(family.services),
    }));
    const partitions = new Set(opts.partitions ?? families.map((f) => f.tenant));
    const namespaces = opts.namespaces ?? [];
    const serviceOf = (channel) => {
        const cut = channel.indexOf(':');
        if (cut > 0) {
            const head = channel.slice(0, cut);
            if (services.has(head))
                return { service: head, bare: channel.slice(cut + 1) };
        }
        return { service: bareService, bare: channel };
    };
    const entryOf = (bare) => table.find((entry) => entry.family.pattern.test(bare)) ?? null;
    const familyOf = (bare) => entryOf(bare)?.family ?? null;
    const authorityFor = (family, channel, kind) => {
        const entry = table.find((e) => e.family === family);
        if (!entry)
            return null;
        const { service } = serviceOf(channel);
        if (!entry.services.has(service))
            return null;
        if (kind === 'subscribe' || ephemeral.has(service))
            return family.read;
        return family.write;
    };
    const lobbyFamily = (name) => {
        const family = familyOf(name);
        return family && family.lobby === true && partitions.has(family.tenant) ? family : null;
    };
    const namespaceOf = (bare) => {
        for (const rule of namespaces) {
            try {
                if (rule.match(bare))
                    return rule;
            }
            catch { /* a throwing matcher owns nothing */ }
        }
        return null;
    };
    const readPartition = partitionReader(opts);
    const admit = (auth, name, lobby, familyAllows) => readPartition(auth, name, (a, n, at) => {
        const ruled = opts.rules?.(a, n, { ...at, lobby });
        if (ruled !== undefined)
            return ruled === true;
        if (partitions.has(at.partition)) {
            const family = familyOf(n);
            return !!family && familyAllows(family);
        }
        return opts.otherPartition?.(a, n, { ...at, lobby }) === true;
    });
    const lobbyGuard = (auth, name) => {
        try {
            if (typeof name !== 'string')
                return false;
            const ns = namespaceOf(name);
            if (ns && ns.lobby !== true)
                return false;
            return admit(auth, name, true, (family) => family.lobby === true);
        }
        catch {
            return false;
        }
    };
    const guard = (auth, channel, kind = 'subscribe') => {
        try {
            if (auth == null || typeof channel !== 'string')
                return false;
            const bare = (0, channelAccess_1.baseChannel)(channel);
            const ns = namespaceOf(bare);
            if (ns)
                return ns.guard ? ns.guard(auth, channel, kind, bare) === true : false;
            return admit(auth, bare, false, (family) => authorityFor(family, channel, kind) !== null);
        }
        catch {
            return false;
        }
    };
    return {
        families,
        partitions,
        serviceOf,
        familyOf,
        authorityFor,
        lobbyFamily,
        isProducerChannel: (channel) => familyOf(channel) !== null,
        namespaceOf,
        guard,
        lobbyGuard,
    };
}
//# sourceMappingURL=families.js.map