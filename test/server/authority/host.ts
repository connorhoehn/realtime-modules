// A test HOST for the 0.116 authority primitives: the multi-tenant world of
// aws-agentcore's gateway facade (middleware/src/lib/gateway/authority.ts over
// lib/live-principal.ts and lib/tenant-channels.ts), rebuilt on
// `defineChannelFamilies` + `createChannelAuthority`. Everything the library
// must NOT know — tenants, Cedar actions, Social membership rows, huddle
// seats, the distillation feed — lives here as host callbacks and data, so the
// ported facade table proves the library mechanism gives the consumer's
// verdict for every row.

import {
    createChannelAuthority,
    defineChannelFamilies,
    type AuthorityContext,
    type ChannelFamily,
    type GuardAuth,
} from '../../../src/server';

export type Grants = Record<string, string[]>;
export interface UserInfo { id: string; displayName: string; epoch: number; grants: Grants }
export interface Session {
    sub: string; name?: string; tenant: string; role: string; epoch: number; grants: Grants; iat: number;
    act?: { sub: string; epoch: number; role: 'admin'; tenant: string; grants: Grants };
}
export interface Principal { session: Session; auth: GuardAuth & { userId: string } }
export interface MemberRow { channel: string; userId: string; historyFrom: string | null; removedAt: string | null }
export interface UploadRow { uploadId: string; channel: string; uploader: string; createdAt: string }

/** The family authority value: who may act (active tenant or any grant holder) plus an optional Cedar action. */
export interface Authority { tenant: string; activeTenant: boolean; action: string | null }
export interface Family extends ChannelFamily<Authority> { cursors?: true }

const TENANTS = ['orgiq', 'assessment', 'pipelines', 'social', 'access'];
const ADMIN_ROLE = 'admin';

// ── The family table (lib/tenant-channels.ts, verbatim data) ─────────────────

const RID = '\\S{1,256}';
const ALL = ['chat', 'presence', 'typing', 'cursor', 'reactions', 'activity', 'pins'];
const DISCUSSION = ['chat', 'presence', 'typing', 'reactions'];
const DISCUSSION_CURSORS = ['chat', 'presence', 'typing', 'reactions', 'cursor'];
const PRESENCE = ['presence'];
const SERVER_HINT = ['chat'];
const WORK_GRAPH_FAMILY = /^orgiq:workgraph(?::(?:workspace|(?:initiative|person):[A-Za-z0-9][A-Za-z0-9._-]{0,99}))?$/;
const PIPELINES_WORK_GRAPH_FAMILY = /^pipelines:workgraph(?::(?:workspace|run:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/;
const ASSESSMENT_WORK_GRAPH_FAMILY = /^assessment:workgraph(?::(?:workspace|team:TEAM-[A-Za-z0-9-]{1,120}))?$/;
const SOCIAL_WORK_GRAPH_FAMILY = /^social:workgraph(?::(?:workspace|conversation:social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/;
const tenantOnly = (tenant: string, action: string | null = null): Authority => ({ tenant, activeTenant: true, action });

export const FAMILIES: readonly Family[] = [
    { id: 'orgiq:invoke', tenant: 'orgiq', pattern: /^orgiq:invoke$/, services: DISCUSSION, lobby: false, read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
    { id: 'orgiq:session', tenant: 'orgiq', pattern: new RegExp(`^orgiq:session:${RID}$`), services: DISCUSSION, lobby: false, read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
    { id: 'orgiq:initiative', tenant: 'orgiq', pattern: new RegExp(`^orgiq:initiative:${RID}$`), services: DISCUSSION_CURSORS, lobby: true,
        lobbyResource: 'orgiq-initiative', cursors: true, read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
    { id: 'orgiq:work', tenant: 'orgiq', pattern: new RegExp(`^orgiq:work:${RID}$`), services: DISCUSSION, lobby: false, cursors: true,
        read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
    { id: 'orgiq:workgraph', tenant: 'orgiq', pattern: WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false, read: tenantOnly('orgiq'), write: null },
    { id: 'pipelines:workgraph', tenant: 'pipelines', pattern: PIPELINES_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false, read: tenantOnly('pipelines', 'ViewPipelines'), write: null },
    { id: 'assessment:workgraph', tenant: 'assessment', pattern: ASSESSMENT_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false, read: tenantOnly('assessment', 'ViewAssessment'), write: null },
    { id: 'social:workgraph', tenant: 'social', pattern: SOCIAL_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false, read: tenantOnly('social', 'ViewSocial'), write: null },
    // The consumer asks the deck row inline (initiativeDeckVisible); here it is the family's channel resource.
    { id: 'orgiq:deck', tenant: 'orgiq', pattern: new RegExp(`^orgiq:deck:${RID}$`), services: PRESENCE, lobby: false, channelResource: 'initiative-deck', read: tenantOnly('orgiq'), write: null },
    { id: 'assessment:doc', tenant: 'assessment', pattern: new RegExp(`^assessment:doc:${RID}$`), services: ALL, lobby: true, cursors: true,
        read: tenantOnly('assessment', 'ViewAssessment'), write: tenantOnly('assessment', 'ViewAssessment') },
    { id: 'assessment:team', tenant: 'assessment', pattern: /^assessment:team:TEAM-[A-Za-z0-9-]{1,120}$/, services: DISCUSSION_CURSORS, lobby: true,
        lobbyResource: 'assessment-team', channelResource: 'assessment-team', cursors: true,
        read: tenantOnly('assessment', 'ViewAssessment'), write: tenantOnly('assessment', 'ViewAssessment') },
    { id: 'assessment:knowledge', tenant: 'assessment', pattern: new RegExp(`^assessment:knowledge:${RID}$`), services: PRESENCE, lobby: false, read: tenantOnly('assessment', 'ViewAssessment'), write: null },
    { id: 'assessment:deck', tenant: 'assessment', pattern: new RegExp(`^assessment:deck:${RID}$`), services: PRESENCE, lobby: false, read: tenantOnly('assessment', 'ViewAssessment'), write: null },
    { id: 'pipelines:deck', tenant: 'pipelines', pattern: new RegExp(`^pipelines:deck:${RID}$`), services: PRESENCE, lobby: false, read: tenantOnly('pipelines', 'ViewPipelines'), write: null },
    { id: 'pipelines:run', tenant: 'pipelines', pattern: new RegExp(`^pipelines:run:${RID}$`), services: DISCUSSION_CURSORS, lobby: true,
        lobbyResource: 'pipelines-run', cursors: true, read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
    { id: 'pipelines:def', tenant: 'pipelines', pattern: new RegExp(`^pipelines:def:${RID}$`), services: DISCUSSION, lobby: false,
        read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
    { id: 'access:req', tenant: 'access', pattern: /^access:req:req-[A-Za-z0-9-]{1,64}$/, services: DISCUSSION, lobby: false, cursors: true,
        channelResource: 'access-request', read: tenantOnly('access', 'ViewAccess'), write: tenantOnly('access', 'ViewAccess') },
    ...(['orgiq', 'assessment', 'pipelines'] as const).map((tenant): Family => ({
        id: `${tenant}:lobby`, tenant, pattern: new RegExp(`^${tenant}:lobby$`), services: PRESENCE, lobby: false,
        read: { tenant, activeTenant: false, action: null }, write: null,
    })),
];

// ── Host name shapes (call chat, distillation, flow runs, Social decks) ─────

const HUDDLE = /^orgiq:huddle:([a-zA-Z0-9:_-]{1,256})$/;
export const huddleCallId = (name: string): string | null => HUDDLE.exec(name)?.[1] ?? null;
const inHuddleNamespace = (name: string) => name === 'orgiq:huddle' || name.startsWith('orgiq:huddle:');
const DISTILL = new Set(['orgiq:distill:levels', 'orgiq:distill:jobs', 'orgiq:distill:review']);
export const isDistillationChannel = (name: string) => DISTILL.has(name);
// lib/flow-runs/channel.ts and lib/social-deck-channel.ts, verbatim rules.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FLOW_RUN = new RegExp(`^(social|assessment|orgiq|pipelines):flowrun:(([a-z]{2,8})-${UUID})$`);
const FLOW_RUN_ID_TENANT: Record<string, string> = {
    sum: 'social', sdk: 'social', adr: 'assessment', osm: 'orgiq', asm: 'assessment', psm: 'pipelines', pdr: 'pipelines',
    sdg: 'social', sdc: 'social', odg: 'orgiq', odc: 'orgiq', adg: 'assessment', adc: 'assessment', pdg: 'pipelines', pdc: 'pipelines',
    sag: 'social', oag: 'orgiq', aag: 'assessment', pag: 'pipelines',
};
const parseFlowRun = (name: string): { tenant: string; runId: string } | null => {
    const m = FLOW_RUN.exec(name);
    return m && FLOW_RUN_ID_TENANT[m[3]!] === m[1] ? { tenant: m[1]!, runId: m[2]! } : null;
};
const SOCIAL_DECK = /^social:deck:(sdeck-[0-9a-f-]{36})$/;
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;
const SOCIAL_CHANNEL_PREFIX = 'social:ch:';
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOCIAL_WORK_GRAPH_CONVERSATION = /^social:workgraph:conversation:(social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v : []);

export function mayReadDistillation(auth: GuardAuth | null | undefined): boolean {
    if (!auth || !str(auth.userId)) return false;
    return str(auth.org) === 'orgiq' || auth.role === ADMIN_ROLE;
}

/** The directory world a test mutates between rows. */
export interface World {
    users: Map<string, UserInfo>;
    policy: Record<string, Record<string, string[]>>;
    deniedActions: Set<string>;
    visible: Set<string>;
    threadReaders: Map<string, Set<string>>;
    members: Map<string, MemberRow[]>;
    teams: Map<string, Set<string>>;
    /** Current huddle seats: callId → userIds. */
    seats: Map<string, Set<string>>;
    /** Directory reads, for the "fresh per call" assertions. */
    loads: number;
}

export function createHost(world: World) {
    // ── the directory (lib/live-principal.ts currentLiveSession) ──
    const epochOf = (value: unknown): number => {
        const v = value === undefined ? 0 : value;
        if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error('Invalid session provenance');
        return Number(v);
    };
    const gatewayContext = (session: Session): Record<string, unknown> => ({
        userId: session.sub, displayName: session.name ?? session.sub, org: session.tenant, role: session.role,
        epoch: session.epoch, sessionIat: session.iat,
        tenants: Object.entries(session.grants).filter(([, roles]) => roles.length > 0).map(([t]) => t),
        ...(session.act ? { act: { sub: session.act.sub, epoch: session.act.epoch } } : {}),
    });
    const user = (id: string): UserInfo | null => { world.loads += 1; const u = world.users.get(id); return u ? structuredClone(u) : null; };
    async function load(ctx: AuthorityContext): Promise<Principal> {
        if (!ctx || typeof ctx.userId !== 'string' || typeof ctx.org !== 'string' || typeof ctx.role !== 'string') throw new Error('Unauthenticated');
        if (!TENANTS.includes(ctx.org)) throw new Error('Invalid session provenance');
        const actor = ctx.act as { sub?: unknown; epoch?: unknown } | undefined;
        if (actor !== undefined && (!actor || typeof actor !== 'object' || typeof actor.sub !== 'string' || !actor.sub)) throw new Error('Invalid actor provenance');
        const signedEpoch = epochOf(ctx.epoch);
        const [u, a] = [user(ctx.userId), actor ? user(actor.sub as string) : null];
        if (!u || u.epoch !== signedEpoch || !u.grants[ctx.org]?.includes(ctx.role)
            || (actor && (!a || a.epoch !== epochOf(actor.epoch) || !Object.values(a.grants).some((roles) => roles.includes(ADMIN_ROLE))))) {
            throw new Error('The session is no longer current');
        }
        const session: Session = {
            sub: ctx.userId, name: u.displayName, tenant: ctx.org, role: ctx.role, epoch: u.epoch, grants: structuredClone(u.grants),
            iat: Number(ctx.sessionIat ?? 0),
            ...(actor ? { act: { sub: actor.sub as string, epoch: epochOf(actor.epoch), role: 'admin' as const, tenant: 'orgiq', grants: {} } } : {}),
        };
        return { session, auth: { ...ctx, ...gatewayContext(session) } as Principal['auth'] };
    }
    const isAllowed = async (p: { sub: string; tenant: string; role: string }, action: string): Promise<boolean> => {
        if (world.deniedActions.has(`${p.sub}:${action}`)) return false;
        const allowed = world.policy[p.tenant]?.[p.role] ?? [];
        return allowed.includes('*') || allowed.includes(action);
    };
    // ── the family authority (sessionMeets + holdsChannelAuthority) ──
    const meets = (session: Session, authority: Authority): boolean => {
        const granted = Object.entries(session.grants).some(([t, roles]) => t === authority.tenant && roles.length > 0);
        if (!authority.activeTenant) return granted || session.role === ADMIN_ROLE;
        return session.tenant === authority.tenant || session.role === ADMIN_ROLE;
    };
    const holds = async (session: Session, authority: Authority): Promise<boolean> =>
        meets(session, authority) && (!authority.action || isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, authority.action));
    // ── Social: membership rows and the action role ──
    const rows = (channel: string) => world.members.get(channel) ?? [];
    const isActiveMember = (channel: string, userId: string) => rows(channel).some((r) => r.userId === userId && r.removedAt == null);
    const membershipAllows = (channel: string, userId: string) => rows(channel).length === 0 || isActiveMember(channel, userId);
    const socialActionRole = async (session: Session, action: string): Promise<string | null> => {
        for (const role of session.grants.social ?? []) if (await isAllowed({ sub: session.sub, tenant: 'social', role }, action)) return role;
        return null;
    };
    /** A membership proof that a later write invalidates (MirroredMembershipStore observers). */
    const proof = (channel: string, userId: string) => {
        const allowed = membershipAllows(channel, userId);
        const snapshot = JSON.stringify(rows(channel));
        return () => allowed && JSON.stringify(rows(channel)) === snapshot;
    };

    // ── the shape: the library mechanism over the host table and host rules ──
    const families = defineChannelFamilies<Authority, Family>(FAMILIES, {
        partitions: ['orgiq', 'assessment', 'pipelines', 'access'],
        namespaces: [
            { id: 'call-chat', match: inHuddleNamespace, guard: (auth, channel, _kind, bare) => {
                const callId = huddleCallId(bare);
                return !!callId && (channel === bare || channel === `reactions:${bare}`) && !!str(auth.userId)
                    && ['orgiq', 'assessment'].some((t) => str(auth.org) === t || list(auth.tenants).includes(t));
            } },
            { id: 'distillation', match: (b) => b.startsWith('orgiq:distill:'), guard: (auth, channel, kind, bare) =>
                kind === 'subscribe' && channel === bare && isDistillationChannel(bare) && mayReadDistillation(auth) },
            { id: 'flow-run', match: (b) => /^[^:]+:flowrun(?::|$)/.test(b), guard: (auth, channel, kind, bare) => {
                const ref = parseFlowRun(bare);
                return !!ref && kind === 'subscribe' && channel === bare && !!str(auth.userId)
                    && (ref.tenant === str(auth.org) || list(auth.tenants).includes(ref.tenant));
            } },
            { id: 'social-deck', match: (b) => /^social:deck(?::|$)/.test(b), guard: (auth, channel, _kind, bare) => {
                const ref = SOCIAL_DECK.exec(bare);
                return !!ref && channel === `presence:${bare}` && !!str(auth.userId)
                    && (str(auth.org) === 'social' || list(auth.tenants).includes('social'));
            } },
        ],
        rules: (_auth, name, at) => {
            const team = TEAM_CHANNEL.exec(name);
            if (team) return world.teams.get(team[1])?.has(at.userId) ?? false;
            if (at.partition === 'social' && at.rest.startsWith('team:')) return false;
            if (name.startsWith(SOCIAL_CHANNEL_PREFIX)) return SLUG.test(name.slice(SOCIAL_CHANNEL_PREFIX.length)) && isActiveMember(name, at.userId);
            return undefined;
        },
        otherPartition: (_auth, _name, at) => at.partition === 'social',
    });

    const authority = createChannelAuthority<Principal, Authority, Family>({
        families,
        principal: { load, auth: (p) => p.auth },
        holds: (p, a) => holds(p.session, a),
        meets: (p, a) => meets(p.session, a),
        resource: (kind, name, p, use) => {
            if (kind === 'access-request') return use === 'channel' && (world.threadReaders.get(name)?.has(p.session.sub) ?? false);
            return world.visible.has(name);
        },
        namespaces: [
            // Huddle chat: a current seat of the call, never a grant alone (CallChatRuntime.assertChannelAccess).
            { id: 'call-chat', match: inHuddleNamespace, channel: async (args, kit) => {
                const callId = huddleCallId(args.base);
                if (!callId) return false;
                const first = await kit.load(args.ctx);
                if (!kit.guard(first.auth, args.channel, args.kind)) return false;
                if (!world.seats.get(callId)?.has(first.session.sub)) return false;
                const latest = await kit.load(args.ctx);
                return latest.session.sub === first.session.sub && kit.guard(latest.auth, args.channel, args.kind);
            } },
            // `social:workgraph*` is default deny: only the family's own names.
            { id: 'social-workgraph-deny', match: (b) => /^social:workgraph(?::|$)/.test(b) && !families.familyOf(b), channel: () => false },
            { id: 'social-workgraph-conversation', match: (b) => SOCIAL_WORK_GRAPH_CONVERSATION.test(b), channel: async (args, kit) => {
                const conversation = SOCIAL_WORK_GRAPH_CONVERSATION.exec(args.base)?.[1];
                const family = families.familyOf(args.base);
                const auth = family ? families.authorityFor(family, args.channel, args.kind) : null;
                if (!conversation || !auth) return false;
                let p = await kit.load(args.ctx);
                const role = await socialActionRole(p.session, 'ViewSocial');
                if (role === null || !await holds(p.session, auth)) return false;
                if (!socialConversationReadable(p.session.sub, conversation, p.auth)) return false;
                p = await kit.load(args.ctx);
                return !!p.session.grants.social?.includes(role) && meets(p.session, auth) && kit.guard(p.auth, args.channel, args.kind);
            } },
        ],
        channelSteps: [
            // A Social name: the action (ViewSocial/PostMessage) and the conversation's membership proof.
            async (p, q) => {
                if (!q.base.startsWith('social:')) return undefined;
                const role = await socialActionRole(p.session, q.kind === 'subscribe' ? 'ViewSocial' : 'PostMessage');
                if (role === null) return false;
                const allows = proof(q.base, p.session.sub);
                if (!allows()) return false;
                return { recheck: (latest) => !!latest.session.grants.social?.includes(role) && allows() };
            },
        ],
        callSteps: [
            // The work graph's stream names are never a place to call into, well-formed or not.
            (_p, q) => (q.lobby && /^social:workgraph(?::|$)/.test(q.lobby) ? false : undefined),
            async (p, q) => {
                if (!q.lobby?.startsWith('social:')) return undefined;
                const role = await socialActionRole(p.session, q.receiving ? 'ViewSocial' : 'StartCall');
                if (role === null) return false;
                const allows = proof(q.lobby, p.session.sub);
                if (!allows()) return false;
                return { recheck: (latest) => !!latest.session.grants.social?.includes(role) && allows() };
            },
        ],
    });

    function socialConversationReadable(userId: string, conversation: string, auth: GuardAuth): boolean {
        if (conversation.startsWith('social:room:')) return true;
        if (!families.guard(auth, conversation, 'subscribe')) return false;
        return membershipAllows(conversation, userId);
    }

    // ── The facade (lib/gateway/authority.ts), each a host composition of library primitives ──
    type Ctx = Record<string, unknown> | null;
    const facade = {
        families,
        authority,
        channelGuard: families.guard,
        lobbyGuard: families.lobbyGuard,
        admitChannel: authority.authorizeChannel,
        admitSubscribe: (ctx: Ctx, channel: string, o: { clientId?: string } = {}) =>
            authority.authorizeChannel({ kind: 'subscribe', clientId: o.clientId ?? 'http', channel, ctx }),
        admitPublish: (ctx: Ctx, channel: string, o: { clientId?: string } = {}) =>
            authority.authorizeChannel({ kind: 'publish', clientId: o.clientId ?? 'http', channel, ctx }),
        admitCursor: (ctx: Ctx, channel: string, kind: 'subscribe' | 'publish') =>
            authority.authorizeChannel({ kind, clientId: 'http', channel: channel.startsWith('cursor:') ? channel : `cursor:${channel}`, ctx }),
        admitCall: (ctx: Ctx, action: string, payload: Record<string, unknown>, getLobby: (callId: string) => Promise<string | null>) =>
            authority.authorizeCall(ctx, action, payload, { getLobby }),
        admitCallRecipient: (ctx: Ctx, data: Record<string, unknown>, getLobby: (callId: string) => Promise<string | null>) =>
            authority.authorizeCallRecipient(ctx, data, { getLobby }),
        admitLobbyRead: (ctx: Ctx, lobby: string) => authority.authorizeLobby(ctx, lobby, 'read'),
        admitDistillation: async (ctx: Ctx, channel: string, kind: 'subscribe' | 'publish') => {
            if (kind === 'publish' || !isDistillationChannel(channel)) return false;
            try { return mayReadDistillation((await load(ctx)).auth); } catch { return false; }
        },
        admitDistillationDelivery: async (ctx: Ctx) => {
            try { return mayReadDistillation((await load(ctx)).auth); } catch { return false; }
        },
        admitConversationChat: async (args: { ctx: Ctx; channel: string; kind: 'subscribe' | 'publish'; clientId: string }) => {
            try {
                const first = await load(args.ctx);
                const callId = huddleCallId(args.channel);
                if (callId) {
                    if (!world.seats.get(callId)?.has(first.session.sub)) return false;
                    return (await load(args.ctx)).session.sub === first.session.sub;
                }
                const family = families.familyOf(args.channel);
                if (!family || !families.partitions.has(family.tenant) || !(family.services as string[]).includes('chat')) return false;
                if (!await authority.authorizeChannel(args)) return false;
                const r = rows(args.channel);
                if (r.length && !r.some((row) => row.userId === first.session.sub && row.removedAt == null)) return false;
                const latest = await load(args.ctx);
                const a = families.authorityFor(family, args.channel, args.kind);
                return !!a && latest.session.sub === first.session.sub && meets(latest.session, a);
            } catch { return false; }
        },
        admitSocialConversation: async (userId: string, conversation: string, auth: GuardAuth) =>
            socialConversationReadable(userId, conversation, auth),
        admitUploadRead: async (found: UploadRow, ctx: Record<string, unknown>) => {
            if (found.uploader === ctx.userId) return true;
            if (!await authority.authorizeChannel({ kind: 'subscribe', clientId: 'http', channel: found.channel, ctx })) return false;
            if (!found.channel.startsWith('social:') && !found.channel.startsWith('orgiq:huddle')) return true;
            const member = rows(found.channel).find((r) => r.userId === ctx.userId);
            const floor = member?.historyFrom ? Date.parse(member.historyFrom) : NaN;
            if (!Number.isFinite(floor)) return true;
            const sent = Date.parse(found.createdAt);
            return Number.isFinite(sent) && sent > floor;
        },
        admitReader: async (userId: string, bare: string) => {
            try {
                const family = families.familyOf(bare);
                if (!family || !(family.services as string[]).includes('chat')) return false;
                const u = user(userId);
                const roles = u?.grants[family.tenant] ?? [];
                if (!u || !roles.length) return false;
                let ok = false;
                for (const role of roles) {
                    const session: Session = { sub: userId, tenant: family.tenant, role, grants: u.grants, epoch: u.epoch, iat: 0 };
                    if (await authority.holdsFamily({ session, auth: { userId } }, bare, 'subscribe')) { ok = true; break; }
                }
                if (!ok) return false;
                if (family.channelResource) {
                    const visible = family.channelResource === 'access-request'
                        ? world.threadReaders.get(bare)?.has(userId) ?? false : world.visible.has(bare);
                    if (!visible) return false;
                }
                const r = rows(bare);
                return !r.length || r.some((row) => row.userId === userId && row.removedAt == null);
            } catch { return false; }
        },
        admitPrincipal: (ctx: Ctx) => authority.current(ctx),
        producerChannelAllowed: (channel: string) => families.isProducerChannel(channel),
        holdsFamilyAuthority: (session: Session, channel: string, kind: 'subscribe' | 'publish') =>
            authority.holdsFamily({ session, auth: { userId: session.sub } }, channel, kind),
        gatewayContext,
    };
    return facade;
}
