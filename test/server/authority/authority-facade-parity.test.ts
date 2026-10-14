// The consumer's facade contract, run against the 0.116 library primitives.
//
// Ported row for row from aws-agentcore
// middleware/src/lib/gateway/__tests__/authority-facade.test.ts (the "88
// contracts" of docs/realtime-validation/2026-10-08/gateway-split.md §3): same
// directory world, same rows, same VERDICT column. The consumer's second
// column (equality with its pre-split primitive) has no meaning here; what
// this file proves is that `defineChannelFamilies` + `partitionGuard` +
// `createChannelAuthority`, fed the consumer's family table and its host
// callbacks (./host.ts), reach the verdict the consumer's hand-written facade
// reaches for every row — before the consumer deletes its copy.

import { createHost, type Grants, type MemberRow, type Session, type UploadRow, type World } from './host';

type Ctx = Record<string, unknown>;
const T0 = '2026-10-08T12:00:00.000Z';

const DIRECTORY: Record<string, Grants> = {
    alice: { orgiq: ['member'], social: ['participant'] },
    sam: { orgiq: ['sme'] },
    bob: { orgiq: ['member'], social: ['participant'] },
    carol: { social: ['participant'] },
    ava: { assessment: ['assessor'], orgiq: ['member'] },
    pat: { pipelines: ['operator'] },
    root: { orgiq: ['admin'] },
    nobody: { orgiq: ['member'] },
    rhea: { access: ['requester'] },
    omar: { access: ['approver'] },
    priya: { access: ['access-admin'] },
    zed: { access: ['approver'] },
    mixed: { orgiq: ['member'], access: ['requester'] },
};
const POLICY: Record<string, Record<string, string[]>> = {
    orgiq: { member: ['ViewDistillation'], sme: ['DispatchAgentRun'], admin: ['*'] },
    assessment: { assessor: ['ViewAssessment'] },
    pipelines: { operator: ['ViewPipelines'] },
    social: { participant: ['ViewSocial', 'PostMessage', 'StartCall'] },
    access: { requester: ['ViewAccess', 'RequestAccess'], approver: ['ViewAccess', 'RequestAccess', 'DecideAccess'],
        'access-admin': ['ViewAccess', 'RequestAccess', 'DecideAccess', 'ManageAccessCatalog', 'ManageAccessPolicy', 'ProvisionAccess'] },
};

let world: World;
let host: ReturnType<typeof createHost>;
const users = () => world.users;

const session = (sub: string, tenant: string, role?: string, act?: { sub: string; epoch?: number }): Session => ({
    sub, name: sub, tenant, role: role ?? DIRECTORY[sub]![tenant]![0]!, epoch: 0, grants: structuredClone(DIRECTORY[sub]!), iat: 1_700_000_000,
    ...(act ? { act: { sub: act.sub, epoch: act.epoch ?? 0, role: 'admin' as const, tenant: 'orgiq', grants: {} } } : {}),
});
const ctx = (sub: string, tenant: string, role?: string, act?: { sub: string; epoch?: number }): Ctx =>
    host.gatewayContext(session(sub, tenant, role, act));
async function member(channel: string, userId: string, historyFrom: string | null = null, removedAt: string | null = null) {
    const rows = world.members.get(channel) ?? [];
    world.members.set(channel, [...rows.filter((r) => r.userId !== userId), { channel, userId, historyFrom, removedAt } as MemberRow]);
}
const upload = (channel: string, uploader: string, createdAt: string): UploadRow => ({ uploadId: 'u1', channel, uploader, createdAt });

beforeEach(() => {
    world = {
        users: new Map(Object.entries(DIRECTORY).map(([id, grants]) => [id, { id, displayName: id, epoch: 0, grants: structuredClone(grants) }])),
        policy: POLICY,
        deniedActions: new Set(),
        visible: new Set(['orgiq:initiative:p-1', 'assessment:team:TEAM-1', 'pipelines:run:r1']),
        threadReaders: new Map([['access:req:req-0001', new Set(['rhea', 'omar', 'priya', 'mixed'])], ['access:req:req-0004', new Set(['priya'])]]),
        members: new Map(),
        teams: new Map(),
        seats: new Map(),
        loads: 0,
    };
    host = createHost(world);
});

// ── Channels ────────────────────────────────────────────────────────────────

type ChannelRow = { name: string; ctx: () => Ctx | null; kind: 'subscribe' | 'publish'; channel: string; before?: () => Promise<void> | void; verdict: boolean };
const CHANNEL_ROWS: ChannelRow[] = [
    { name: 'orgiq member reads an initiative discussion', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
    { name: 'orgiq member cannot post to it (DispatchAgentRun is the write)', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'orgiq:initiative:p-1', verdict: false },
    { name: 'an SME posts to it', ctx: () => ctx('sam', 'orgiq'), kind: 'publish', channel: 'orgiq:initiative:p-1', verdict: true },
    { name: 'cross-tenant: a pipelines operator holds no orgiq grant', ctx: () => ctx('pat', 'pipelines'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
    { name: 'cross-tenant: an orgiq grant held while standing in assessment is not the active tenant', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
    { name: 'the same person standing in orgiq reads it', ctx: () => ctx('ava', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
    { name: 'revoked grant: the signed role is no longer granted', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
        before: () => { users().get('alice')!.grants.orgiq = []; }, verdict: false },
    { name: 'epoch bump: another sign-in retired this socket', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
        before: () => { users().get('alice')!.epoch = 1; }, verdict: false },
    { name: 'masquerade: an admin actor behind the target is admitted as the target', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'root' }), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
    { name: 'masquerade: an actor who is no longer admin is refused', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'nobody' }), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
    { name: 'masquerade: an actor whose epoch moved is refused', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'root', epoch: 0 }), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
        before: () => { users().get('root')!.epoch = 3; }, verdict: false },
    { name: 'a name no family lists is refused however many grants are held', ctx: () => ctx('root', 'orgiq'), kind: 'subscribe', channel: 'orgiq:nope:1', verdict: false },
    { name: 'page family existence: a team that exists', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'assessment:team:TEAM-1', verdict: true },
    { name: 'page family existence: a team that is gone', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'assessment:team:TEAM-9', verdict: false },
    { name: 'presence on a document (ephemeral: the read authority)', ctx: () => ctx('ava', 'assessment'), kind: 'publish', channel: 'presence:assessment:doc:d1', verdict: true },
    { name: 'cursor on a document canvas', ctx: () => ctx('ava', 'assessment'), kind: 'publish', channel: 'cursor:assessment:doc:d1', verdict: true },
    { name: 'cursor on a family that offers no cursor service', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'cursor:orgiq:work:w1', verdict: false },
    { name: 'cursor from another tenant', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'cursor:assessment:doc:d1', verdict: false },
    { name: 'a social channel member reads it', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:ch:general', before: () => member('social:ch:general', 'alice'), verdict: true },
    { name: 'a social channel non-member is refused', ctx: () => ctx('carol', 'social'), kind: 'subscribe', channel: 'social:ch:general', before: () => member('social:ch:general', 'alice'), verdict: false },
    { name: 'a member whose Social grant was revoked is refused', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:ch:general',
        before: async () => { await member('social:ch:general', 'alice'); users().get('alice')!.grants.social = []; }, verdict: false },
    { name: 'a member denied PostMessage reads but cannot post', ctx: () => ctx('alice', 'social'), kind: 'publish', channel: 'social:ch:general',
        before: async () => { await member('social:ch:general', 'alice'); world.deniedActions.add('alice:PostMessage'); }, verdict: false },
    { name: 'a DM admits one of its ids', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: true },
    { name: 'a DM refuses a third person', ctx: () => ctx('carol', 'social'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: false },
    { name: 'a social grant holder standing in orgiq reaches a social DM (E5)', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: true },
    { name: 'the distillation feed: a plain subscribe standing in orgiq', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: true },
    { name: 'the distillation feed: never a publish', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'orgiq:distill:jobs', verdict: false },
    { name: 'the distillation feed: an orgiq grant held from assessment is not enough', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: false },
    { name: 'the distillation feed: an admin reads it from anywhere', ctx: () => ctx('root', 'orgiq', 'admin'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: true },
    { name: 'a huddle chat name is never admitted by grant alone', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:huddle:c1', verdict: false },
    { name: 'no context is refused', ctx: () => null, kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
    { name: 'access: the requester reads her request thread', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
    { name: 'access: the requester posts to it (ViewAccess is the write)', ctx: () => ctx('rhea', 'access'), kind: 'publish', channel: 'access:req:req-0001', verdict: true },
    { name: 'access: the live approver reads it', ctx: () => ctx('omar', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
    { name: 'access: an access-admin reads it', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
    { name: 'access: an approver outside the request\'s read rule is refused', ctx: () => ctx('zed', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
    { name: 'access: the requester is refused someone else\'s request', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0004', verdict: false },
    { name: 'access: an approver who left the read rule (a decided chain) is refused now', ctx: () => ctx('omar', 'access'), kind: 'publish', channel: 'access:req:req-0001',
        before: () => { world.threadReaders.get('access:req:req-0001')!.delete('omar'); }, verdict: false },
    { name: 'access: a reader whose access grant was revoked is refused', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0001',
        before: () => { users().get('rhea')!.grants.access = []; }, verdict: false },
    { name: 'access: an access grant held while standing in orgiq is not the active tenant', ctx: () => ctx('mixed', 'orgiq'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
    { name: 'access: the same person standing in access reads it', ctx: () => ctx('mixed', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
    { name: 'access: cross-tenant, an orgiq-only member is refused', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
    { name: 'access: presence on the thread (ephemeral: the read authority)', ctx: () => ctx('omar', 'access'), kind: 'publish', channel: 'presence:access:req:req-0001', verdict: true },
    { name: 'access: no cursor service on a request thread', ctx: () => ctx('rhea', 'access'), kind: 'publish', channel: 'cursor:access:req:req-0001', verdict: false },
    { name: 'access: a name no family lists is refused', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:lobby:x', verdict: false },
    { name: 'access: a malformed request id is refused', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:req:nope', verdict: false },
];

describe('authorizeChannel: the consumer verdict for every row', () => {
    it.each(CHANNEL_ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
        await row.before?.();
        const context = row.ctx();
        expect(await host.admitChannel({ kind: row.kind, clientId: 'c1', channel: row.channel, ctx: context })).toBe(row.verdict);
        const thin = row.kind === 'subscribe' ? await host.admitSubscribe(context, row.channel, { clientId: 'c1' }) : await host.admitPublish(context, row.channel, { clientId: 'c1' });
        expect(thin).toBe(row.verdict);
    });

    it('admitCursor is the router decision on cursor:<channel>', async () => {
        expect(await host.admitCursor(ctx('ava', 'assessment'), 'assessment:doc:d1', 'publish')).toBe(true);
        expect(await host.admitCursor(ctx('ava', 'assessment'), 'cursor:assessment:doc:d1', 'publish')).toBe(true);
        expect(await host.admitCursor(ctx('alice', 'orgiq'), 'assessment:doc:d1', 'publish')).toBe(false);
        expect(await host.admitCursor(ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe')).toBe(false);
    });
});

describe('admitDistillation: the cookie path equals the /ws path', () => {
    const contexts: Array<[string, () => Ctx | null]> = [
        ['orgiq member', () => ctx('alice', 'orgiq')], ['assessment-standing orgiq grant holder', () => ctx('ava', 'assessment')],
        ['admin', () => ctx('root', 'orgiq', 'admin')], ['pipelines operator', () => ctx('pat', 'pipelines')], ['no context', () => null],
    ];
    it.each(contexts)('%s', async (_name, make) => {
        const context = make();
        for (const channel of ['orgiq:distill:jobs', 'orgiq:distill:levels', 'orgiq:distill:review', 'orgiq:distill:other']) {
            for (const kind of ['subscribe', 'publish'] as const) {
                expect(await host.admitDistillation(context, channel, kind)).toBe(await host.admitChannel({ kind, clientId: 'c1', channel, ctx: context }));
            }
        }
        expect(await host.admitDistillationDelivery(context)).toBe(await host.admitDistillation(context, 'orgiq:distill:jobs', 'subscribe'));
    });
    it('fails closed on an epoch bump between frames', async () => {
        const context = ctx('alice', 'orgiq');
        expect(await host.admitDistillationDelivery(context)).toBe(true);
        users().get('alice')!.epoch = 2;
        expect(await host.admitDistillationDelivery(context)).toBe(false);
    });
});

// ── Calls ───────────────────────────────────────────────────────────────────

const lobbies = new Map<string, string>([['c-init', 'orgiq:initiative:p-1'], ['c-team', 'assessment:team:TEAM-1']]);
const stored = async (callId: string) => lobbies.get(callId) ?? null;
const noStoredCall = async () => null;

type CallRow = { name: string; ctx: () => Ctx; action: string; payload: Record<string, unknown>; before?: () => Promise<void> | void; verdict: boolean };
const CALL_ROWS: CallRow[] = [
    { name: 'join an initiative lobby as an orgiq member', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, verdict: true },
    { name: 'join an initiative that no longer exists', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-gone' }, verdict: false },
    { name: 'a work item is a discussion, not a lobby', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:work:w1' }, verdict: false },
    { name: 'a huddle chat name is not a lobby', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:huddle:c1' }, verdict: false },
    { name: 'cross-tenant: pipelines cannot join an orgiq lobby', ctx: () => ctx('pat', 'pipelines'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, verdict: false },
    { name: 'invite must name the caller as callerId', ctx: () => ctx('alice', 'orgiq'), action: 'invite', payload: { callId: 'x', lobbyName: 'orgiq:initiative:p-1', callerId: 'bob', targetUserIds: ['bob'] }, verdict: false },
    { name: 'invite by the caller', ctx: () => ctx('alice', 'orgiq'), action: 'invite', payload: { callId: 'x', lobbyName: 'orgiq:initiative:p-1', callerId: 'alice', targetUserIds: ['bob'] }, verdict: true },
    { name: 'a stored call cannot be renamed into another lobby', ctx: () => ctx('alice', 'orgiq'), action: 'accepted', payload: { callId: 'c-init', lobbyName: 'orgiq:initiative:p-2' }, verdict: false },
    { name: 'a stored call resolves its lobby from the store', ctx: () => ctx('alice', 'orgiq'), action: 'accepted', payload: { callId: 'c-init' }, verdict: true },
    { name: 'a team huddle on a team that is gone', ctx: () => ctx('ava', 'assessment'), action: 'join', payload: { lobbyName: 'assessment:team:TEAM-1' }, before: () => { world.visible.delete('assessment:team:TEAM-1'); }, verdict: false },
    { name: 'a team huddle on a team that exists', ctx: () => ctx('ava', 'assessment'), action: 'join', payload: { lobbyName: 'assessment:team:TEAM-1' }, verdict: true },
    { name: 'non-member lobby: a private social channel refuses a non-member ring', ctx: () => ctx('carol', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' }, before: () => member('social:ch:private', 'alice'), verdict: false },
    { name: 'a member with StartCall joins the channel call', ctx: () => ctx('alice', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' }, before: () => member('social:ch:private', 'alice'), verdict: true },
    { name: 'a member denied StartCall cannot', ctx: () => ctx('alice', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' },
        before: async () => { await member('social:ch:private', 'alice'); world.deniedActions.add('alice:StartCall'); }, verdict: false },
    { name: 'revoked grant mid-call', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, before: () => { users().get('alice')!.grants.orgiq = []; }, verdict: false },
    { name: 'epoch bump', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, before: () => { users().get('alice')!.epoch = 1; }, verdict: false },
    { name: 'nested envelope is normalised like the public service', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { data: { lobbyName: 'orgiq:initiative:p-1' } }, verdict: true },
];

describe('authorizeCall / authorizeCallRecipient / authorizeLobby', () => {
    it.each(CALL_ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
        await row.before?.();
        expect(await host.admitCall(row.ctx(), row.action, row.payload, stored)).toBe(row.verdict);
    });

    it('the lobby-access route form asks with no stored call behind it', async () => {
        expect(await host.admitCall(ctx('alice', 'orgiq'), 'join', { lobbyName: 'orgiq:initiative:p-1' }, noStoredCall)).toBe(true);
        expect(await host.admitCall(ctx('alice', 'orgiq'), 'join', { callId: 'c-init' }, noStoredCall)).toBe(true);
        expect(await host.admitCall(ctx('pat', 'pipelines'), 'join', { lobbyName: 'orgiq:initiative:p-1' }, noStoredCall)).toBe(false);
    });

    it('a recipient is admitted by its own fresh authority', async () => {
        for (const [context, verdict] of [[ctx('bob', 'orgiq'), true], [ctx('pat', 'pipelines'), false], [ctx('ava', 'assessment'), false]] as const) {
            expect(await host.admitCallRecipient(context, { callId: 'c-init' }, stored)).toBe(verdict);
        }
        users().get('bob')!.epoch = 1;
        expect(await host.admitCallRecipient(ctx('bob', 'orgiq'), { callId: 'c-init' }, stored)).toBe(false);
    });

    it.each([
        ['an orgiq member reads the initiative call log', () => ctx('alice', 'orgiq'), 'orgiq:initiative:p-1', 'ok'],
        ['a discussion is no lobby', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'not-a-lobby'],
        ['a social channel is no tenant lobby', () => ctx('alice', 'social'), 'social:ch:general', 'not-a-lobby'],
        ['a team that is gone', () => ctx('ava', 'assessment'), 'assessment:team:TEAM-9', 'gone'],
        ['cross-tenant is denied', () => ctx('pat', 'pipelines'), 'orgiq:initiative:p-1', 'denied'],
        ['a pipelines run its operator may read', () => ctx('pat', 'pipelines'), 'pipelines:run:r1', 'ok'],
    ] as const)('lobby read: %s', async (_name, make, lobby, verdict) => {
        expect(await host.admitLobbyRead(make(), lobby)).toBe(verdict);
    });
});

// ── Conversation chat ───────────────────────────────────────────────────────

describe('admitConversationChat / admitSocialConversation', () => {
    it.each([
        ['a member reads a work-item thread', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', undefined, true],
        ['explicit rows close the thread to non-members', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'bob'), false],
        ['explicit rows admit a listed member', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'alice'), true],
        ['a removed row refuses', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'alice', null, T0), false],
        ['social names are refused here (they keep chatAccess)', () => ctx('alice', 'social'), 'social:ch:general', 'subscribe', () => member('social:ch:general', 'alice'), false],
        ['cross-tenant', () => ctx('pat', 'pipelines'), 'orgiq:work:w1', 'subscribe', undefined, false],
        ['revoked grant', () => ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => { users().get('alice')!.grants.orgiq = []; }, false],
        ['a run its operator may read', () => ctx('pat', 'pipelines'), 'pipelines:run:r1', 'subscribe', undefined, true],
    ] as const)('%s', async (_name, make, channel, kind, before, verdict) => {
        const context = make();
        await before?.();
        expect(await host.admitConversationChat({ ctx: context, channel, kind, clientId: 'rest:test' })).toBe(verdict);
    });

    it.each([
        ['a channel member', 'alice', 'social:ch:general', () => member('social:ch:general', 'alice'), true],
        ['a non-member', 'carol', 'social:ch:general', () => member('social:ch:general', 'alice'), false],
        ['a removed member', 'alice', 'social:ch:general', () => member('social:ch:general', 'alice', null, T0), false],
        ['a DM id', 'alice', 'social:dm:alice:bob', undefined, true],
        ['a DM outsider', 'carol', 'social:dm:alice:bob', undefined, false],
        ['a room is the platform\'s visibility, not chat', 'carol', 'social:room:r1', undefined, true],
        ['a malformed team name', 'alice', 'social:team:x', undefined, false],
    ] as const)('social conversation: %s', async (_name, userId, channel, before, verdict) => {
        await before?.();
        expect(await host.admitSocialConversation(userId, channel, ctx(userId, 'social'))).toBe(verdict);
    });
});

// ── Uploads: the history floor ──────────────────────────────────────────────

describe('admitUploadRead', () => {
    it.each([
        ['the uploader always reads their own file', 'bob', null, true],
        ['a member whose floor is older than the file reads it', 'alice', '2026-10-08T11:00:00.000Z', true],
        ['a member added after the file was shared never sees it', 'alice', '2026-10-08T13:00:00.000Z', false],
        ['a member with no floor reads it', 'alice', null, true],
    ] as const)('%s', async (_name, reader, historyFrom, verdict) => {
        await member('social:ch:general', 'alice', historyFrom); await member('social:ch:general', 'bob');
        expect(await host.admitUploadRead(upload('social:ch:general', 'bob', T0), ctx(reader, 'social'))).toBe(verdict);
    });
    it('a non-member cannot read a file shared in the channel', async () => {
        await member('social:ch:general', 'bob');
        expect(await host.admitUploadRead(upload('social:ch:general', 'bob', T0), ctx('carol', 'social'))).toBe(false);
    });
    it('a tenant thread file follows the family read, no floor', async () => {
        expect(await host.admitUploadRead(upload('orgiq:work:w1', 'bob', T0), ctx('alice', 'orgiq'))).toBe(true);
        expect(await host.admitUploadRead(upload('orgiq:work:w1', 'bob', T0), ctx('pat', 'pipelines'))).toBe(false);
    });
});

// ── Readers, principals, producers ──────────────────────────────────────────

describe('admitReader / admitPrincipal / producerChannelAllowed / holdsFamilyAuthority', () => {
    it('a reader is asked by id: the family read over every granted role, the page, the rows', async () => {
        expect(await host.admitReader('alice', 'orgiq:work:w1')).toBe(true);
        expect(await host.admitReader('pat', 'orgiq:work:w1')).toBe(false);
        expect(await host.admitReader('ava', 'assessment:team:TEAM-1')).toBe(true);
        expect(await host.admitReader('ava', 'assessment:team:TEAM-9')).toBe(false);
        await member('orgiq:work:w1', 'bob');
        expect(await host.admitReader('alice', 'orgiq:work:w1')).toBe(false);
        users().get('ava')!.grants.assessment = [];
        expect(await host.admitReader('ava', 'assessment:team:TEAM-1')).toBe(false);
        expect(await host.admitReader('alice', 'orgiq:nope:1')).toBe(false);
    });

    it('an access request thread\'s reader is the request\'s read rule for that id, now', async () => {
        expect(await host.admitReader('rhea', 'access:req:req-0001')).toBe(true);
        expect(await host.admitReader('omar', 'access:req:req-0001')).toBe(true);
        expect(await host.admitReader('zed', 'access:req:req-0001')).toBe(false);
        expect(await host.admitReader('rhea', 'access:req:req-0004')).toBe(false);
        expect(await host.admitReader('alice', 'access:req:req-0001')).toBe(false);
        world.threadReaders.get('access:req:req-0001')!.delete('omar');
        expect(await host.admitReader('omar', 'access:req:req-0001')).toBe(false);
        users().get('rhea')!.grants.access = [];
        expect(await host.admitReader('rhea', 'access:req:req-0001')).toBe(false);
    });

    it('a principal is current until its epoch moves or its grant goes', async () => {
        const context = ctx('alice', 'orgiq');
        expect(await host.admitPrincipal(context)).toBe(true);
        expect(await host.admitPrincipal(null)).toBe(false);
        expect(await host.admitPrincipal(ctx('alice', 'orgiq', undefined, { sub: 'nobody' }))).toBe(false);
        users().get('alice')!.epoch = 1;
        expect(await host.admitPrincipal(context)).toBe(false);
    });

    it('a producer only leaves onto a family name', () => {
        expect(host.producerChannelAllowed('pipelines:run:r1')).toBe(true);
        expect(host.producerChannelAllowed('orgiq:initiative:p-1')).toBe(true);
        expect(host.producerChannelAllowed('pipelines:nope')).toBe(false);
        expect(host.producerChannelAllowed('orgiq:huddle:c1')).toBe(false);
        expect(host.producerChannelAllowed('social:ch:general')).toBe(false);
    });

    it('a session holds a family authority exactly as its REST route would decide', async () => {
        expect(await host.holdsFamilyAuthority(session('ava', 'assessment'), 'assessment:team:TEAM-1', 'subscribe')).toBe(true);
        expect(await host.holdsFamilyAuthority(session('ava', 'assessment'), 'assessment:team:TEAM-1', 'publish')).toBe(true);
        expect(await host.holdsFamilyAuthority(session('ava', 'orgiq'), 'assessment:team:TEAM-1', 'subscribe')).toBe(false);
        expect(await host.holdsFamilyAuthority(session('alice', 'orgiq'), 'orgiq:initiative:p-1', 'publish')).toBe(false);
        expect(await host.holdsFamilyAuthority(session('sam', 'orgiq'), 'orgiq:initiative:p-1', 'publish')).toBe(true);
        expect(await host.holdsFamilyAuthority(session('alice', 'orgiq'), 'orgiq:nope:1', 'subscribe')).toBe(false);
    });
});

// ── Beyond the port: what the library adds on the same world ────────────────

describe('library guarantees on the consumer world', () => {
    it('nothing settles: every decision reloads the directory, and an epoch bump after an admit refuses the next ask', async () => {
        const context = ctx('alice', 'orgiq');
        const before = world.loads;
        expect(await host.admitSubscribe(context, 'orgiq:initiative:p-1')).toBe(true);
        expect(world.loads).toBeGreaterThan(before);
        const mid = world.loads;
        expect(await host.admitSubscribe(context, 'orgiq:initiative:p-1')).toBe(true);
        expect(world.loads).toBeGreaterThan(mid);
        users().get('alice')!.epoch = 5;
        expect(await host.admitSubscribe(context, 'orgiq:initiative:p-1')).toBe(false);
    });

    it('recheckAfterIo: an epoch bump DURING the resource read refuses (channel, lobby read, call)', async () => {
        const bumpDuring = (kind: string) => {
            const resourceHost = createHost({ ...world, visible: new Proxy(world.visible, {
                get(target, prop) {
                    if (prop === 'has') return (name: string) => { if (name.startsWith(kind)) users().get('ava')!.epoch += 1; return target.has(name); };
                    const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
                },
            }) });
            return resourceHost;
        };
        let h = bumpDuring('assessment:team');
        expect(await h.admitSubscribe(ctx('ava', 'assessment'), 'assessment:team:TEAM-1')).toBe(false);
        users().get('ava')!.epoch = 0;
        h = bumpDuring('assessment:team');
        expect(await h.admitLobbyRead(ctx('ava', 'assessment'), 'assessment:team:TEAM-1')).toBe('denied');
        users().get('ava')!.epoch = 0;
        h = bumpDuring('assessment:team');
        expect(await h.admitCall(ctx('ava', 'assessment'), 'join', { lobbyName: 'assessment:team:TEAM-1' }, noStoredCall)).toBe(false);
    });

    it('authorizeLobby(join) gives the four-way verdict the agent-loop route maps to 409/403/404', async () => {
        const join = (c: Ctx, name: string) => host.authority.authorizeLobby(c, name, 'join');
        expect(await join(ctx('alice', 'orgiq'), 'orgiq:initiative:p-1')).toBe('ok');
        expect(await join(ctx('alice', 'orgiq'), 'orgiq:work:w1')).toBe('not-a-lobby');
        expect(await join(ctx('alice', 'orgiq'), 'orgiq:huddle:c1')).toBe('not-a-lobby');
        expect(await join(ctx('alice', 'orgiq'), 'orgiq:initiative:p-gone')).toBe('gone');
        expect(await join(ctx('pat', 'pipelines'), 'orgiq:initiative:p-1')).toBe('denied');
    });

    it('a spoofed callerId is refused even when every other rule would admit', async () => {
        expect(await host.admitCall(ctx('sam', 'orgiq'), 'invite', { callId: 'y', lobbyName: 'orgiq:initiative:p-1', callerId: 'alice', targetUserIds: ['alice'] }, noStoredCall)).toBe(false);
        expect(await host.admitCall(ctx('sam', 'orgiq'), 'invite', { callId: 'y', lobbyName: 'orgiq:initiative:p-1', targetUserIds: ['alice'] }, noStoredCall)).toBe(false);
    });

    it('the shape guards fail closed on garbage', () => {
        const g = host.channelGuard;
        expect(g(null, 'orgiq:initiative:p-1')).toBe(false);
        expect(g({ userId: '', org: 'orgiq' }, 'orgiq:initiative:p-1')).toBe(false);
        expect(g({ userId: 'a', org: 'orgiq' }, ':initiative')).toBe(false);
        expect(g({ userId: 'a', org: 'orgiq' }, 'orgiq:')).toBe(false);
        expect(g({ userId: 'a', org: 'orgiq' }, 'orgiq:dm')).toBe(false);
        expect(g({ userId: 'a', org: 'orgiq' }, 'orgiq:dm:a')).toBe(true);
        expect(host.lobbyGuard({ userId: 'a', org: 'orgiq' }, 'orgiq:distill:jobs')).toBe(false);
        expect(host.lobbyGuard({ userId: 'a', org: 'orgiq', tenants: 'orgiq' }, 'assessment:doc:1')).toBe(false);
        expect(host.lobbyGuard({ userId: 'a', org: 'orgiq' }, 'orgiq:initiative:p-1')).toBe(true);
    });
});
