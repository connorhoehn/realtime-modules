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

import { dmLobbyAdmits } from '../../call/lobbyChannel';
import { baseChannel } from '../../server-ws/channelAccess';

export type ChannelKind = 'subscribe' | 'publish';

/** The identity fields the shape guards read off a connection's auth context. */
export interface GuardAuth {
    userId?: unknown;
    /** The partition the caller is standing in (its active tenant). */
    org?: unknown;
    /** Every partition the caller holds a grant in. */
    tenants?: unknown;
    [key: string]: unknown;
}

/** A shape guard: may this connection use `name` at all (before any I/O)? */
export type ShapeGuard = (auth: GuardAuth, name: string) => boolean;
/** A channel shape guard (subscribe/publish on a possibly service-prefixed name). */
export type ChannelShapeGuard = (auth: GuardAuth | null, channel: string, kind?: ChannelKind) => boolean;

/**
 * One family of channel names a tenant uses. `A` is the HOST's authority value
 * (a tenant + Cedar action, a role list, anything) — the library never reads
 * it, it only hands it back to the host's `holds`/`meets` callbacks.
 */
export interface ChannelFamily<A = unknown> {
    id: string;
    /** The partition (first name segment) the family lives under. */
    tenant: string;
    /** Matched against the BARE name (no service prefix). Anchor it. */
    pattern: RegExp;
    /** Services offered on the name; a frame for any other service is refused. */
    services: ReadonlySet<string> | readonly string[];
    /** May the name also be a call lobby? Default false. */
    lobby?: boolean;
    /** A host resource kind asked on every CALL / LOBBY decision (the page existing now). */
    lobbyResource?: string;
    /** A host resource kind asked on every CHANNEL decision. */
    channelResource?: string;
    /** Authority for a subscribe, and for a publish on an ephemeral service. */
    read: A;
    /** Authority for a content publish; null = nobody publishes content here. */
    write: A | null;
}

/** A host namespace the families do not cover (a server-push feed, a call's own chat). */
export interface NamespaceRule {
    id: string;
    /** Does this rule own the bare name? */
    match(bare: string): boolean;
    /** The shape rule for a channel in the namespace. Absent: every channel refused. */
    guard?(auth: GuardAuth, channel: string, kind: ChannelKind, bare: string): boolean;
    /** May a name in the namespace be a call lobby? Default false (refused). */
    lobby?: boolean;
}

export interface PartitionGuardOptions {
    /** The caller's id. Default `auth.userId` when a non-empty string. */
    userIdOf?(auth: GuardAuth): string;
    /** The caller's own (active) partition. Default `auth.org` when a string. */
    orgOf?(auth: GuardAuth): string;
    /** Every partition the caller holds. Default the string entries of `auth.tenants`. */
    tenantsOf?(auth: GuardAuth): readonly string[];
    /**
     * Apply the member-addressed DM rule (`<p>:dm:<ids…>` admits only a listed
     * id) before `next`. Default true.
     */
    dm?: boolean;
    /**
     * Decide a name that passed the partition (and is not a DM). Default:
     * refuse — a host that wants a partition open says so here.
     */
    next?(auth: GuardAuth, name: string, at: { partition: string; rest: string; userId: string }): boolean;
}

const stringOr = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The generic multi-tenant name rule: the first segment must be the caller's
 * org or one of its tenants, and a DM lobby admits only its listed members.
 * Fails closed on a missing user id, a name without a partition, an empty
 * remainder, and anything `next` does not admit.
 */
export function partitionGuard(opts: PartitionGuardOptions = {}): ShapeGuard {
    const read = partitionReader(opts);
    const next = opts.next ?? (() => false);
    return (auth, name) => read(auth, name, next);
}

type PartitionNext = (auth: GuardAuth, name: string, at: { partition: string; rest: string; userId: string }) => boolean;

/** The partition + DM half, with the remainder handed to `next` per call. */
function partitionReader(opts: Omit<PartitionGuardOptions, 'next'>): (auth: GuardAuth, name: string, next: PartitionNext) => boolean {
    const userIdOf = opts.userIdOf ?? ((auth: GuardAuth) => stringOr(auth.userId));
    const orgOf = opts.orgOf ?? ((auth: GuardAuth) => stringOr(auth.org));
    const tenantsOf = opts.tenantsOf ?? ((auth: GuardAuth) => (Array.isArray(auth.tenants)
        ? auth.tenants.filter((t): t is string => typeof t === 'string' && t.length > 0) : []));
    const dm = opts.dm !== false;
    return (auth, name, next) => {
        try {
            if (!auth || typeof name !== 'string') return false;
            const userId = userIdOf(auth);
            if (!userId) return false;
            const cut = name.indexOf(':');
            if (cut <= 0) return false;
            const partition = name.slice(0, cut);
            if (partition !== orgOf(auth) && !tenantsOf(auth).includes(partition)) return false;
            const rest = name.slice(cut + 1);
            if (!rest) return false;
            if (dm) {
                const member = dmLobbyAdmits(rest, userId);
                if (member !== null) return member;
            }
            return next(auth, name, { partition, rest, userId }) === true;
        } catch { return false; }
    };
}

/** The service prefixes a family table reads by default (and the bare-name service). */
export const DEFAULT_FAMILY_SERVICES = ['presence', 'reactions', 'cursor', 'chat', 'typing', 'activity', 'pins'] as const;
/** Services that publish under the READ authority ("I am here", not content). */
export const DEFAULT_EPHEMERAL_SERVICES = ['presence', 'typing', 'cursor'] as const;

export interface DefineChannelFamiliesOptions extends Omit<PartitionGuardOptions, 'next'> {
    /** Service prefixes recognised on a channel name. Default {@link DEFAULT_FAMILY_SERVICES}. */
    services?: readonly string[];
    /** Services that publish under the read authority. Default {@link DEFAULT_EPHEMERAL_SERVICES}. */
    ephemeral?: readonly string[];
    /** The service a name without a recognised prefix belongs to. Default `'chat'`. */
    bareService?: string;
    /**
     * Partitions the table governs default-deny: a name under one of these is
     * admitted only when a family lists it. Default: every family's `tenant`.
     * A partition with families that is NOT listed here (a family for one
     * server-push stream under an otherwise host-ruled partition) still has
     * its families matched by `familyOf`, but its names fall to `rules`/`otherPartition`.
     */
    partitions?: Iterable<string>;
    /** Host namespaces decided before the table (see {@link NamespaceRule}). */
    namespaces?: readonly NamespaceRule[];
    /**
     * Host name rules applied after the partition and DM rules and before the
     * table: return true/false to decide, undefined to fall through (team
     * rosters, a channel membership mirror).
     */
    rules?(auth: GuardAuth, name: string, at: { partition: string; rest: string; userId: string; lobby: boolean }): boolean | undefined;
    /** A name under a partition the table does not govern. Default: refuse. */
    otherPartition?(auth: GuardAuth, name: string, at: { partition: string; rest: string; userId: string; lobby: boolean }): boolean;
}

export interface ChannelFamilies<A = unknown, F extends ChannelFamily<A> = ChannelFamily<A>> {
    readonly families: readonly F[];
    /** The partitions governed default-deny. */
    readonly partitions: ReadonlySet<string>;
    /** `presence:acme:doc:1` → `{ service: 'presence', bare: 'acme:doc:1' }`; a bare name is the bare service. */
    serviceOf(channel: string): { service: string; bare: string };
    /** The family listing a BARE name, or null. */
    familyOf(bare: string): F | null;
    /** The authority a frame on `channel` must satisfy, or null when the family does not offer that service/kind. */
    authorityFor(family: F, channel: string, kind: ChannelKind): A | null;
    /** The family of `name` when it is a call lobby in a governed partition, else null. */
    lobbyFamily(name: string): F | null;
    /** Server producers: may a server frame leave onto `channel` (some family lists it)? */
    isProducerChannel(channel: string): boolean;
    /** The namespace rule owning a bare name, or null. */
    namespaceOf(bare: string): NamespaceRule | null;
    /** Sync channel shape guard: namespaces, partition, DM, host rules, then the table. */
    guard: ChannelShapeGuard;
    /** Sync lobby shape guard: the same, with the table's `lobby` flag. */
    lobbyGuard: ShapeGuard;
}

/**
 * Build the default-deny family mechanism over a host's family table.
 * Fail closed throughout: an unknown service, a family without the service, a
 * name no family lists under a governed partition, a throwing host rule.
 */
export function defineChannelFamilies<A, F extends ChannelFamily<A> = ChannelFamily<A>>(
    families: readonly F[],
    opts: DefineChannelFamiliesOptions = {},
): ChannelFamilies<A, F> {
    const services = new Set(opts.services ?? DEFAULT_FAMILY_SERVICES);
    const ephemeral = new Set(opts.ephemeral ?? DEFAULT_EPHEMERAL_SERVICES);
    const bareService = opts.bareService ?? 'chat';
    const table = families.map((family) => ({
        family,
        services: family.services instanceof Set ? family.services as ReadonlySet<string> : new Set(family.services as readonly string[]),
    }));
    const partitions: ReadonlySet<string> = new Set(opts.partitions ?? families.map((f) => f.tenant));
    const namespaces = opts.namespaces ?? [];

    const serviceOf = (channel: string): { service: string; bare: string } => {
        const cut = channel.indexOf(':');
        if (cut > 0) {
            const head = channel.slice(0, cut);
            if (services.has(head)) return { service: head, bare: channel.slice(cut + 1) };
        }
        return { service: bareService, bare: channel };
    };
    const entryOf = (bare: string) => table.find((entry) => entry.family.pattern.test(bare)) ?? null;
    const familyOf = (bare: string): F | null => entryOf(bare)?.family ?? null;
    const authorityFor = (family: F, channel: string, kind: ChannelKind): A | null => {
        const entry = table.find((e) => e.family === family);
        if (!entry) return null;
        const { service } = serviceOf(channel);
        if (!entry.services.has(service)) return null;
        if (kind === 'subscribe' || ephemeral.has(service)) return family.read;
        return family.write;
    };
    const lobbyFamily = (name: string): F | null => {
        const family = familyOf(name);
        return family && family.lobby === true && partitions.has(family.tenant) ? family : null;
    };
    const namespaceOf = (bare: string): NamespaceRule | null => {
        for (const rule of namespaces) {
            try { if (rule.match(bare)) return rule; } catch { /* a throwing matcher owns nothing */ }
        }
        return null;
    };

    const readPartition = partitionReader(opts);
    const admit = (auth: GuardAuth, name: string, lobby: boolean, familyAllows: (family: F) => boolean): boolean =>
        readPartition(auth, name, (a, n, at) => {
            const ruled = opts.rules?.(a, n, { ...at, lobby });
            if (ruled !== undefined) return ruled === true;
            if (partitions.has(at.partition)) {
                const family = familyOf(n);
                return !!family && familyAllows(family);
            }
            return opts.otherPartition?.(a, n, { ...at, lobby }) === true;
        });

    const lobbyGuard: ShapeGuard = (auth, name) => {
        try {
            if (typeof name !== 'string') return false;
            const ns = namespaceOf(name);
            if (ns && ns.lobby !== true) return false;
            return admit(auth, name, true, (family) => family.lobby === true);
        } catch { return false; }
    };
    const guard: ChannelShapeGuard = (auth, channel, kind = 'subscribe') => {
        try {
            if (auth == null || typeof channel !== 'string') return false;
            const bare = baseChannel(channel);
            const ns = namespaceOf(bare);
            if (ns) return ns.guard ? ns.guard(auth, channel, kind, bare) === true : false;
            return admit(auth, bare, false, (family) => authorityFor(family, channel, kind) !== null);
        } catch { return false; }
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
