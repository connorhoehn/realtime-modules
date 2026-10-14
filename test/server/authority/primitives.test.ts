// 0.116 authority primitives on a plain host (not the aws-agentcore world):
// the DM rule, the partition guard, the family table mechanism, the bearer
// subprotocol, principal revalidation through attachRealtime, and the call
// defaults (verifyCaller, refuseEmptyTargets, onCallMissed audience).

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
    attachRealtime,
    bearerSubprotocolAuth,
    calls,
    createChannelAuthority,
    defineChannelFamilies,
    dmLobbyAdmits,
    partitionGuard,
    tokenFromSubprotocol,
    withPrincipalRevalidation,
    BEARER_SUBPROTOCOL,
    type ChannelAuthorize,
    type PrincipalRevalidation,
    type RealtimeHandle,
} from '../../../src/server';
import { CallService } from '../../../src/call/CallService';
import { InMemoryCallStateStore } from '../../../src/call/CallStateStore';
import { dmLobbyName } from '../../../src/call';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('dmLobbyAdmits — the one DM admission rule', () => {
    it.each([
        ['acme:dm:alice:bob', 'alice', 'acme:', true],
        ['acme:dm:alice:bob', 'bob', 'acme:', true],
        ['acme:dm:alice:bob', 'carol', 'acme:', false],
        ['acme:dm', 'alice', 'acme:', false],
        ['acme:dm:', 'alice', 'acme:', false],
        ['acme:dm:alice', 'alice', 'acme:', true],
        ['acme:dm::alice', 'alice', 'acme:', true],
        ['acme:dm:alice:bob', '', 'acme:', false],
        ['acme:room:x', 'alice', 'acme:', null],
        ['acme:dmg:abc', 'alice', 'acme:', null],
        ['globex:dm:alice:bob', 'alice', 'acme:', null],
        ['dm:alice:bob', 'alice', undefined, true],
        ['dm:alice:bob', 'zed', undefined, false],
    ] as const)('%s for %s (prefix %s) → %s', (lobby, user, prefix, verdict) => {
        expect(dmLobbyAdmits(lobby, user, prefix === undefined ? {} : { prefix })).toBe(verdict);
    });
    it('reads exactly what dmLobbyName writes', () => {
        const name = dmLobbyName(['bob', 'alice'], { prefix: 'acme:' });
        expect(dmLobbyAdmits(name, 'alice', { prefix: 'acme:' })).toBe(true);
        expect(dmLobbyAdmits(name, 'bob', { prefix: 'acme:' })).toBe(true);
        expect(dmLobbyAdmits(name, 'mallory', { prefix: 'acme:' })).toBe(false);
    });
});

describe('partitionGuard', () => {
    const guard = partitionGuard({ next: (_a, _n, at) => at.rest.startsWith('open:') });
    it.each([
        [{ userId: 'u', org: 'acme' }, 'acme:open:1', true],
        [{ userId: 'u', org: 'acme' }, 'acme:closed:1', false],
        [{ userId: 'u', org: 'acme' }, 'globex:open:1', false],
        [{ userId: 'u', org: 'acme', tenants: ['globex'] }, 'globex:open:1', true],
        [{ userId: 'u', org: 'acme', tenants: 'globex' }, 'globex:open:1', false],
        [{ userId: '', org: 'acme' }, 'acme:open:1', false],
        [{ org: 'acme' }, 'acme:open:1', false],
        [{ userId: 'u', org: 'acme' }, 'acme', false],
        [{ userId: 'u', org: 'acme' }, ':open:1', false],
        [{ userId: 'u', org: 'acme' }, 'acme:', false],
        [{ userId: 'u', org: 'acme' }, 'acme:dm:u:v', true],
        [{ userId: 'w', org: 'acme' }, 'acme:dm:u:v', false],
    ] as const)('%j on %s → %s', (auth, name, verdict) => {
        expect(guard(auth, name)).toBe(verdict);
    });
    it('defaults to refusing anything past the partition and a throwing rule refuses', () => {
        expect(partitionGuard()({ userId: 'u', org: 'acme' }, 'acme:anything')).toBe(false);
        expect(partitionGuard({ next: () => { throw new Error('x'); } })({ userId: 'u', org: 'acme' }, 'acme:x')).toBe(false);
        expect(partitionGuard({ dm: false, next: () => true })({ userId: 'w', org: 'acme' }, 'acme:dm:u:v')).toBe(true);
    });
});

// A small host: two tenants, a document family (lobby, page resource), a presence-only lobby.
type Auth = { tenant: string; action: string | null };
const families = defineChannelFamilies<Auth>([
    { id: 'doc', tenant: 'acme', pattern: /^acme:doc:[a-z0-9]+$/, services: ['chat', 'presence', 'reactions'], lobby: true,
        lobbyResource: 'doc', channelResource: 'doc', read: { tenant: 'acme', action: null }, write: { tenant: 'acme', action: 'Post' } },
    { id: 'lobby', tenant: 'acme', pattern: /^acme:lobby$/, services: ['presence'], read: { tenant: 'acme', action: null }, write: null },
    { id: 'g-doc', tenant: 'globex', pattern: /^globex:doc:[a-z0-9]+$/, services: ['chat'], lobby: true, read: { tenant: 'globex', action: null }, write: null },
], {
    namespaces: [{ id: 'feed', match: (b) => b.startsWith('acme:feed:'), guard: (_a, ch, kind, bare) => kind === 'subscribe' && ch === bare }],
});

describe('defineChannelFamilies', () => {
    const alice = { userId: 'alice', org: 'acme' };
    it('reads services, authorities and lobbies off the table', () => {
        expect(families.serviceOf('presence:acme:doc:1')).toEqual({ service: 'presence', bare: 'acme:doc:1' });
        expect(families.serviceOf('acme:doc:1')).toEqual({ service: 'chat', bare: 'acme:doc:1' });
        const doc = families.familyOf('acme:doc:1')!;
        expect(doc.id).toBe('doc');
        expect(families.authorityFor(doc, 'acme:doc:1', 'publish')).toEqual({ tenant: 'acme', action: 'Post' });
        expect(families.authorityFor(doc, 'presence:acme:doc:1', 'publish')).toEqual({ tenant: 'acme', action: null });
        expect(families.authorityFor(doc, 'cursor:acme:doc:1', 'subscribe')).toBeNull();
        expect(families.lobbyFamily('acme:doc:1')?.id).toBe('doc');
        expect(families.lobbyFamily('acme:lobby')).toBeNull();
        expect(families.isProducerChannel('acme:doc:1')).toBe(true);
        expect(families.isProducerChannel('acme:nope')).toBe(false);
        expect([...families.partitions].sort()).toEqual(['acme', 'globex']);
    });
    it('the channel guard is default deny under a governed partition', () => {
        expect(families.guard(alice, 'acme:doc:1', 'publish')).toBe(true);
        expect(families.guard(alice, 'presence:acme:lobby', 'publish')).toBe(true);
        expect(families.guard(alice, 'acme:lobby', 'subscribe')).toBe(false); // presence only
        expect(families.guard(alice, 'acme:nope:1')).toBe(false);
        expect(families.guard(alice, 'globex:doc:1')).toBe(false);
        expect(families.guard({ ...alice, tenants: ['globex'] }, 'globex:doc:1')).toBe(true);
        expect(families.guard(alice, 'acme:feed:x', 'subscribe')).toBe(true);
        expect(families.guard(alice, 'acme:feed:x', 'publish')).toBe(false);
        expect(families.guard(alice, 'acme:dm:alice:bob')).toBe(true);
        expect(families.guard(alice, 'acme:dm:bob:carol')).toBe(false);
        expect(families.guard(null, 'acme:doc:1')).toBe(false);
    });
    it('the lobby guard admits family lobbies and DMs only, never a namespace', () => {
        expect(families.lobbyGuard(alice, 'acme:doc:1')).toBe(true);
        expect(families.lobbyGuard(alice, 'acme:lobby')).toBe(false);
        expect(families.lobbyGuard(alice, 'acme:feed:x')).toBe(false);
        expect(families.lobbyGuard(alice, 'acme:dm:alice:bob')).toBe(true);
        expect(families.lobbyGuard(alice, 'other:x')).toBe(false);
    });
});

describe('createChannelAuthority on the small host', () => {
    const directory = new Map<string, { epoch: number; tenants: string[]; actions: string[] }>();
    const docs = new Set(['acme:doc:1']);
    let loads = 0;
    const authority = createChannelAuthority<{ userId: string; org: string; tenants: string[]; actions: string[] }, Auth>({
        families,
        principal: {
            load: (ctx) => {
                loads += 1;
                const user = directory.get(String(ctx?.userId));
                if (!user || user.epoch !== ctx?.epoch || !user.tenants.includes(String(ctx?.org))) throw new Error('stale');
                return { userId: String(ctx!.userId), org: String(ctx!.org), tenants: user.tenants, actions: user.actions };
            },
            auth: (p) => ({ userId: p.userId, org: p.org, tenants: p.tenants }),
        },
        holds: (p, a) => p.org === a.tenant && (!a.action || p.actions.includes(a.action)),
        meets: (p, a) => p.org === a.tenant,
        resource: (_kind, name) => docs.has(name),
    });
    beforeEach(() => {
        loads = 0;
        directory.set('alice', { epoch: 0, tenants: ['acme'], actions: ['Post'] });
        directory.set('bob', { epoch: 0, tenants: ['acme'], actions: [] });
    });
    const alice = { userId: 'alice', org: 'acme', epoch: 0 };
    const bob = { userId: 'bob', org: 'acme', epoch: 0 };
    it('channel: shape, holds, resource, reload, recheck — each time', async () => {
        expect(await authority.authorizeChannel({ kind: 'publish', clientId: 'c', channel: 'acme:doc:1', ctx: alice })).toBe(true);
        expect(loads).toBe(2);
        expect(await authority.authorizeChannel({ kind: 'publish', clientId: 'c', channel: 'acme:doc:1', ctx: bob })).toBe(false);
        expect(await authority.authorizeChannel({ kind: 'publish', clientId: 'c', channel: 'presence:acme:doc:1', ctx: bob })).toBe(true);
        expect(await authority.authorizeChannel({ kind: 'subscribe', clientId: 'c', channel: 'acme:doc:2', ctx: alice })).toBe(false);
        directory.get('alice')!.epoch = 1;
        expect(await authority.authorizeChannel({ kind: 'subscribe', clientId: 'c', channel: 'acme:doc:1', ctx: alice })).toBe(false);
        expect(await authority.authorizeChannel({ kind: 'subscribe', clientId: 'c', channel: 'acme:doc:1', ctx: null })).toBe(false);
    });
    it('lobby verdicts', async () => {
        expect(await authority.authorizeLobby(alice, 'acme:doc:1', 'read')).toBe('ok');
        expect(await authority.authorizeLobby(alice, 'acme:doc:2', 'read')).toBe('gone');
        expect(await authority.authorizeLobby(alice, 'acme:lobby', 'read')).toBe('not-a-lobby');
        expect(await authority.authorizeLobby(alice, 'globex:doc:1', 'read')).toBe('denied');
        expect(await authority.authorizeLobby(alice, 'acme:doc:1', 'join')).toBe('ok');
        expect(await authority.authorizeLobby(alice, 'acme:doc:2', 'join')).toBe('gone');
        expect(await authority.authorizeLobby(alice, 'acme:dm:alice:bob', 'join')).toBe('not-a-lobby');
        expect(await authority.authorizeLobby(alice, 'acme:doc:1', 'leave' as never)).toBe('denied');
    });
    it('calls: callerId must be the principal; stored lobbies cannot be renamed; recipients need a lobby', async () => {
        expect(await authority.authorizeCall(alice, 'invite', { callId: 'k', lobbyName: 'acme:doc:1', callerId: 'bob' })).toBe(false);
        expect(await authority.authorizeCall(alice, 'invite', { callId: 'k', lobbyName: 'acme:doc:1', callerId: 'alice' })).toBe(true);
        expect(await authority.authorizeCall(alice, 'invite', { callId: 'k', lobbyName: 'acme:dm:alice:bob', callerId: 'alice' })).toBe(true);
        expect(await authority.authorizeCall(alice, 'accepted', { callId: 'k', lobbyName: 'acme:doc:9' }, { getLobby: () => 'acme:doc:1' })).toBe(false);
        expect(await authority.authorizeCallRecipient(bob, { callId: 'k' }, { getLobby: () => 'acme:doc:1' })).toBe(true);
        expect(await authority.authorizeCallRecipient(bob, { callId: 'unknown' }, { getLobby: () => null })).toBe(false);
        expect(await authority.authorizeCall(alice, 'join', { lobbyName: 'acme:feed:x' })).toBe(false);
        const loose = createChannelAuthority<{ userId: string }, Auth>({ families, verifyCaller: false,
            principal: { load: (ctx) => ({ userId: String(ctx!.userId) }), auth: (p) => ({ userId: p.userId, org: 'acme' }) },
            holds: () => true, meets: () => true, resource: () => true });
        expect(await loose.authorizeCall(alice, 'invite', { callId: 'k', lobbyName: 'acme:doc:1', callerId: 'bob' })).toBe(true);
    });
    it('a throwing host callback is a refusal, never an admit', async () => {
        const broken = createChannelAuthority<{ userId: string }, Auth>({ families,
            principal: { load: (ctx) => ({ userId: String(ctx!.userId) }), auth: (p) => ({ userId: p.userId, org: 'acme' }) },
            holds: () => { throw new Error('policy down'); }, meets: () => true });
        expect(await broken.authorizeChannel({ kind: 'subscribe', clientId: 'c', channel: 'acme:doc:1', ctx: alice })).toBe(false);
        expect(await broken.authorizeLobby(alice, 'acme:doc:1', 'read')).toBe('denied');
        expect(await broken.authorizeCall(alice, 'join', { lobbyName: 'acme:doc:1' })).toBe(false);
        // No resource callback: a family that names a resource refuses.
        const noResource = createChannelAuthority<{ userId: string }, Auth>({ families,
            principal: { load: (ctx) => ({ userId: String(ctx!.userId) }), auth: (p) => ({ userId: p.userId, org: 'acme' }) },
            holds: () => true, meets: () => true });
        expect(await noResource.authorizeChannel({ kind: 'subscribe', clientId: 'c', channel: 'acme:doc:1', ctx: alice })).toBe(false);
    });
});

describe('tokenFromSubprotocol', () => {
    it.each([
        ['bearer-token-v1, abc', 'abc'],
        ['bearer-token-v1,abc', 'abc'],
        [['bearer-token-v1', 'abc'], 'abc'],
        ['abc, bearer-token-v1', null],
        ['bearer-token-v1', null],
        ['bearer-token-v1, abc, def', null],
        ['document-grant-v1, abc', null],
        ['', null],
        [undefined, null],
    ] as const)('%j → %s', (header, token) => {
        expect(tokenFromSubprotocol(header as string | string[] | undefined)).toBe(token);
    });
    it('takes another marker', () => {
        expect(tokenFromSubprotocol('document-grant-v1, abc', { protocol: 'document-grant-v1' })).toBe('abc');
    });
});

// ── Over real sockets ───────────────────────────────────────────────────────

type Conn = { ws: WebSocket; frames: any[] };
async function serve(opts: Parameters<typeof attachRealtime>[1]) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, { path: '/rt', ...opts });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const conns: Conn[] = [];
    const connect = (query: string, protocols?: string[], headers?: Record<string, string>) => new Promise<Conn>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/rt${query}`, protocols, headers ? { headers } : {});
        const c: Conn = { ws, frames: [] };
        ws.on('message', (raw) => { try { c.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
        ws.on('open', () => { conns.push(c); resolve(c); });
        ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
        ws.on('error', reject);
    });
    const stop = async () => {
        for (const c of conns) c.ws.terminate();
        await handle.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    };
    return { handle, connect, stop };
}
const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify(frame));

describe('bearerSubprotocolAuth over a socket', () => {
    const tokens: Record<string, { userId: string; org: string }> = { 'tok-alice': { userId: 'alice', org: 'acme' }, 'tok-nouser': { userId: '', org: 'acme' } };
    const auth = bearerSubprotocolAuth({
        verify: (token) => { const ctx = tokens[token]; if (!ctx) throw new Error('bad token'); return ctx; },
        allowOrigin: (origin) => origin === 'https://app.example',
    });
    it('admits a verified token offered as `bearer-token-v1, <jwt>` and negotiates only the marker', async () => {
        const srv = await serve({ features: [], auth });
        try {
            const c = await srv.connect('', [BEARER_SUBPROTOCOL, 'tok-alice']);
            expect(c.ws.protocol).toBe(BEARER_SUBPROTOCOL);
            const ids = srv.handle.listClients();
            expect(srv.handle.getClientContext(ids[0]!)).toMatchObject({ userId: 'alice', org: 'acme' });
        } finally { await srv.stop(); }
    });
    it('refuses (401) a missing header, a bad token, an identity without a user and a foreign origin', async () => {
        const srv = await serve({ features: [], auth });
        try {
            await expect(srv.connect('')).rejects.toThrow('401');
            await expect(srv.connect('', [BEARER_SUBPROTOCOL, 'tok-forged'])).rejects.toThrow('401');
            await expect(srv.connect('', [BEARER_SUBPROTOCOL, 'tok-nouser'])).rejects.toThrow('401');
            await expect(srv.connect('', [BEARER_SUBPROTOCOL, 'tok-alice'], { origin: 'https://evil.example' })).rejects.toThrow('401');
            await expect(srv.connect('', [BEARER_SUBPROTOCOL, 'tok-alice'], { origin: 'https://app.example' })).resolves.toBeDefined();
        } finally { await srv.stop(); }
    });
});

describe('attachRealtime({ principal }) — revalidation at upgrade, authorize, delivery and feature hooks', () => {
    const epochs = new Map<string, number>();
    const principal: PrincipalRevalidation = { revalidate: (ctx) => epochs.get(String(ctx.userId)) === ctx.epoch };
    const queryAuth = async (req: http.IncomingMessage) => {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        return { userId: q.get('sub') ?? '', org: 'acme', epoch: Number(q.get('epoch') ?? 0) };
    };
    beforeEach(() => { epochs.set('alice', 0); epochs.set('bob', 0); });

    it('refuses a stale principal at upgrade', async () => {
        const srv = await serve({ features: [], auth: queryAuth, principal });
        try {
            epochs.set('alice', 3);
            await expect(srv.connect('?sub=alice&epoch=0')).rejects.toThrow('401');
            await expect(srv.connect('?sub=alice&epoch=3')).resolves.toBeDefined();
        } finally { await srv.stop(); }
    });

    it('refuses a subscribe after an epoch bump, and stops delivery to a stale recipient', async () => {
        const srv = await serve({ features: [], auth: queryAuth, principal, authorize: () => true });
        try {
            const alice = await srv.connect('?sub=alice&epoch=0');
            const bob = await srv.connect('?sub=bob&epoch=0');
            send(alice, { service: 'subscribe', action: 'subscribe', channel: 'acme:x' });
            send(bob, { service: 'subscribe', action: 'subscribe', channel: 'acme:x' });
            await sleep(80);
            expect(alice.frames.some((f) => f.action === 'subscribed')).toBe(true);
            await srv.handle.router.sendToChannel('acme:x', { type: 'note', n: 1 });
            await sleep(50);
            expect(bob.frames.filter((f) => f.type === 'note')).toHaveLength(1);
            epochs.set('bob', 1); // bob signed in elsewhere
            await srv.handle.router.sendToChannel('acme:x', { type: 'note', n: 2 });
            await sleep(50);
            expect(bob.frames.filter((f) => f.type === 'note')).toHaveLength(1);
            expect(alice.frames.filter((f) => f.type === 'note')).toHaveLength(2);
            send(bob, { service: 'subscribe', action: 'subscribe', channel: 'acme:y' });
            await sleep(80);
            expect(bob.frames.some((f) => f.action === 'subscribed' && f.channel === 'acme:y')).toBe(false);
        } finally { await srv.stop(); }
    });

    it('recheckAfterIo: an epoch bump while the host decides refuses the decision', async () => {
        let bumped = false;
        const slowAuthorize: ChannelAuthorize = async ({ ctx }) => {
            await sleep(20);
            if (!bumped) { bumped = true; epochs.set(String(ctx?.userId), 9); }
            return true;
        };
        const srv = await serve({ features: [], auth: queryAuth, principal, authorize: slowAuthorize });
        try {
            const alice = await srv.connect('?sub=alice&epoch=0');
            send(alice, { service: 'subscribe', action: 'subscribe', channel: 'acme:x' });
            await sleep(120);
            expect(alice.frames.some((f) => f.action === 'subscribed')).toBe(false);
        } finally { await srv.stop(); }
        epochs.set('alice', 0);
        bumped = false;
        const lax = await serve({ features: [], auth: queryAuth, principal: { ...principal, recheckAfterIo: false }, authorize: slowAuthorize });
        try {
            // Without the recheck the decision that straddled the bump stands
            // (the bump itself is still seen by the NEXT check).
            const alice = await lax.connect('?sub=alice&epoch=0');
            epochs.set('alice', 0);
            const decisions: boolean[] = [];
            const hooks = withPrincipalRevalidation({ authorize: slowAuthorize }, { ...principal, recheckAfterIo: false });
            bumped = false;
            decisions.push(await hooks.authorize({ kind: 'subscribe', clientId: 'c', channel: 'acme:x', ctx: { userId: 'alice', epoch: 0 } }));
            decisions.push(await hooks.authorize({ kind: 'subscribe', clientId: 'c', channel: 'acme:x', ctx: { userId: 'alice', epoch: 0 } }));
            expect(decisions).toEqual([true, false]);
            void alice;
        } finally { await lax.stop(); }
    });

    it('gates calls() frames on the principal', async () => {
        const srv = await serve({ features: [calls({})], auth: queryAuth, principal });
        try {
            const alice = await srv.connect('?sub=alice&epoch=0');
            const bob = await srv.connect('?sub=bob&epoch=0');
            send(alice, { service: 'call', action: 'invite', callId: 'k1', lobbyName: 'acme:dm:alice:bob', callerId: 'alice', targetUserIds: ['bob'] });
            await sleep(80);
            expect(bob.frames.filter((f) => f.type === 'call' && f.action === 'invite')).toHaveLength(1);
            epochs.set('alice', 2);
            send(alice, { service: 'call', action: 'invite', callId: 'k2', lobbyName: 'acme:dm:alice:bob', callerId: 'alice', targetUserIds: ['bob'] });
            await sleep(80);
            expect(bob.frames.filter((f) => f.type === 'call' && f.action === 'invite' && f.data?.callId === 'k2')).toHaveLength(0);
            // Not even the refusal reaches alice: her principal is stale, so the
            // recipient filter suppresses every frame to her socket.
            expect(alice.frames.filter((f) => f.type === 'error')).toHaveLength(0);
            send(bob, { service: 'call', action: 'status', lobbyName: 'acme:dm:alice:bob' });
            await sleep(60);
            expect(bob.frames.find((f) => f.action === 'active-call')?.data?.callId).not.toBe('k2');
        } finally { await srv.stop(); }
    });

    it('withPrincipalRevalidation wraps a custom router\'s hooks the same way', async () => {
        const hooks = withPrincipalRevalidation({ authorize: () => true }, principal);
        expect(await hooks.authorize({ kind: 'subscribe', clientId: 'c', channel: 'x', ctx: { userId: 'alice', epoch: 0 } })).toBe(true);
        expect(await hooks.authorize({ kind: 'subscribe', clientId: 'c', channel: 'x', ctx: { userId: 'alice', epoch: 1 } })).toBe(false);
        expect(await hooks.authorize({ kind: 'subscribe', clientId: 'c', channel: 'x', ctx: null })).toBe(false);
        expect(await hooks.filterClientMessage({ clientId: 'c', message: { a: 1 }, ctx: { userId: 'alice', epoch: 0 } })).toEqual({ a: 1 });
        expect(await hooks.filterClientMessage({ clientId: 'c', message: { a: 1 }, ctx: { userId: 'alice', epoch: 5 } })).toBeNull();
        const throwing = withPrincipalRevalidation({}, { revalidate: () => { throw new Error('directory down'); } });
        expect(await throwing.authorize({ kind: 'subscribe', clientId: 'c', channel: 'x', ctx: { userId: 'alice' } })).toBe(false);
    });
});

describe('calls() defaults', () => {
    const queryAuth = async (req: http.IncomingMessage) => {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        return { userId: q.get('sub') ?? '', org: 'acme' };
    };
    const invites = (c: Conn, callId: string) => c.frames.filter((f) => f.type === 'call' && f.action === 'invite' && f.data?.callId === callId);

    it('verifyCaller (default): a spoofed or missing callerId is refused before anyone is rung', async () => {
        const srv = await serve({ features: [calls({})], auth: queryAuth });
        try {
            const alice = await srv.connect('?sub=alice');
            const bob = await srv.connect('?sub=bob');
            send(alice, { service: 'call', action: 'invite', callId: 's1', lobbyName: 'acme:dm:alice:bob', callerId: 'bob', targetUserIds: ['bob'] });
            send(alice, { service: 'call', action: 'invite', callId: 's2', lobbyName: 'acme:dm:alice:bob', targetUserIds: ['bob'] });
            send(alice, { service: 'call', action: 'invite', data: { callId: 's3', lobbyName: 'acme:dm:alice:bob', callerId: 'bob', targetUserIds: ['bob'] } });
            await sleep(100);
            expect(invites(bob, 's1')).toHaveLength(0);
            expect(invites(bob, 's2')).toHaveLength(0);
            expect(invites(bob, 's3')).toHaveLength(0);
            send(alice, { service: 'call', action: 'invite', callId: 's4', lobbyName: 'acme:dm:alice:bob', callerId: 'alice', targetUserIds: ['bob'] });
            await sleep(80);
            expect(invites(bob, 's4')).toHaveLength(1);
        } finally { await srv.stop(); }
    });

    it('verifyCaller: false restores the old trust; an anonymous socket cannot invite by default', async () => {
        const loose = await serve({ features: [calls({ verifyCaller: false })], auth: queryAuth });
        try {
            const alice = await loose.connect('?sub=alice');
            const bob = await loose.connect('?sub=bob');
            send(alice, { service: 'call', action: 'invite', callId: 'l1', lobbyName: 'acme:dm:alice:bob', callerId: 'bob', targetUserIds: ['bob'] });
            await sleep(80);
            expect(invites(bob, 'l1')).toHaveLength(1);
        } finally { await loose.stop(); }
        const anon = await serve({ features: [calls({})] });
        try {
            const a = await anon.connect('');
            send(a, { service: 'call', action: 'invite', callId: 'a1', lobbyName: 'dm:x:y', callerId: 'x', targetUserIds: ['y'] });
            await sleep(80);
            expect(a.frames.some((f) => f.type === 'error')).toBe(true);
        } finally { await anon.stop(); }
    });

    it('an empty target list is refused by default, for every lobby kind', async () => {
        const srv = await serve({ features: [calls({})], auth: queryAuth });
        try {
            const alice = await srv.connect('?sub=alice');
            const mallory = await srv.connect('?sub=mallory');
            for (const [callId, lobbyName] of [['e1', 'acme:dm:alice:bob'], ['e2', 'acme:room:x'], ['e3', 'room:x']]) {
                send(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: 'alice', targetUserIds: [] });
            }
            await sleep(120);
            expect(alice.frames.filter((f) => f.code === 'untargeted-invite')).toHaveLength(3);
            expect(mallory.frames.filter((f) => f.type === 'call')).toHaveLength(0);
        } finally { await srv.stop(); }
    });
});

describe('onCallMissed carries who was rung and from which conversation', () => {
    const users: Record<string, string> = { 'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-carol': 'u-carol' };
    const router = {
        sendToClient: () => true,
        broadcastToAll: () => undefined,
        getClientsByUserId: (ids: string[]) => Object.entries(users).filter(([, u]) => ids.includes(u)).map(([clientId, userId]) => ({ clientId, userId })),
        getUserIdForClient: (clientId: string) => users[clientId] ?? null,
    };
    const flush = () => new Promise((r) => setImmediate(r));
    it('the union of every invite, the caller excluded, and the invite channel', async () => {
        const onCallMissed = jest.fn();
        const svc = new CallService({ messageRouter: router as never, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
            stateStore: new InMemoryCallStateStore(), rejoinGraceMs: 0, config: { onCallMissed } });
        const lobby = 'acme:room:standup';
        await svc.handleCallEvent('c-alice', 'invite', { callId: 'm1', lobbyName: lobby, callerId: 'u-alice', targetUserIds: ['u-bob'], channel: 'acme:ch:general' } as never);
        await svc.handleCallEvent('c-alice', 'invite', { callId: 'm1', lobbyName: lobby, callerId: 'u-alice', targetUserIds: ['u-carol', 'u-alice'] } as never);
        await svc.handleCallEvent('c-alice', 'cancelled', { callId: 'm1', lobbyName: lobby, callerId: 'u-alice', targetUserIds: ['u-bob'] } as never);
        await flush();
        expect(onCallMissed).toHaveBeenCalledTimes(1);
        const summary = onCallMissed.mock.calls[0]![0];
        expect(summary.targetUserIds.sort()).toEqual(['u-bob', 'u-carol']);
        expect(summary.channel).toBe('acme:ch:general');
        svc.dispose();
    });
});
