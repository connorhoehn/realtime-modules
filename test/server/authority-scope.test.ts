// 0.107: per-operation authority scope.
//
// One chat send names ONE operation. The router pre-check, the membership
// gate, the three post-persist publish rechecks, every recipient's fan-out
// check, the unread-recipient list and the unread probes all receive the same
// scope, so a host can resolve one membership proof per channel per send.
// The scope closes with the operation: the next send reads again.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, chat, LocalRealtimeRouter, createAuthorityScope, type AuthorityScope, type RealtimeHandle } from '../../src/server';
import { MemoryChatMembershipStore, type ChatMember, type ChatMembershipStore } from '../../src/chat/ChatMembershipStore';

type Sock = WebSocket & { frames: any[] };

function connect(port: number, user: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?user=${user}`) as Sock;
        ws.frames = [];
        ws.on('message', (raw) => { try { ws.frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function nextFrame(ws: Sock, match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
    const seen = ws.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        const onMsg = (raw: WebSocket.RawData) => {
            try {
                const frame = JSON.parse(String(raw));
                if (match(frame)) { clearTimeout(timer); ws.off('message', onMsg); resolve(frame); }
            } catch { /* ignore */ }
        };
        ws.on('message', onMsg);
    });
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * A host membership authority in the shape the scope contract asks for:
 * one strongly consistent read per channel per scope, an observer taken
 * before the read, and a revocation that poisons the shared proof so the
 * remaining checks of a running operation deny.
 */
class HostAuthority implements ChatMembershipStore {
    reads = 0;
    readonly inner = new MemoryChatMembershipStore();
    private readonly observers = new Set<{ channel: string; revoked: boolean }>();
    readonly scopes: Array<AuthorityScope | undefined> = [];

    async listMembers(channel: string, opts?: { scope?: AuthorityScope }): Promise<ChatMember[]> {
        return (await this.proof(channel, opts?.scope)).rows;
    }
    getMember(channel: string, userId: string) { return this.inner.getMember(channel, userId); }
    putMember(member: ChatMember) { return this.inner.putMember(member); }

    proof(channel: string, scope?: AuthorityScope): Promise<{ rows: ChatMember[]; observer: { revoked: boolean } }> {
        this.scopes.push(scope);
        const read = () => {
            const observer = { channel, revoked: false };
            this.observers.add(observer);
            scope?.onClose(() => this.observers.delete(observer));
            this.reads++;
            return tick(2).then(async () => ({ rows: await this.inner.listMembers(channel), observer }));
        };
        return scope ? scope.share(`members:${channel}`, read) : read();
    }

    /** A membership write (or a peer hint) for `channel`. */
    revoke(channel: string, userId: string): void {
        void this.inner.getMember(channel, userId).then((m) => m && this.inner.putMember({ ...m, removedAt: new Date().toISOString() }));
        for (const o of this.observers) if (o.channel === channel) o.revoked = true;
    }

    authorize = async ({ channel, ctx, scope }: { kind?: string; channel: string; ctx: any; scope?: AuthorityScope }): Promise<boolean> => {
        const p = await this.proof(channel, scope);
        if (p.observer.revoked) return false;
        if (p.rows.length === 0) return true;
        return p.rows.some((r) => r.userId === ctx?.userId && !r.removedAt);
    };
}

async function boot(host: HostAuthority, chatOpts: Record<string, unknown> = {}) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [chat({ membershipStore: host, ...chatOpts })],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon' }),
        authorize: (args: any) => host.authorize(args),
    } as any);
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    return {
        handle, port,
        close: async () => { await handle.dispose(); await new Promise<void>((r) => server.close(() => r())); },
    };
}

async function member(host: HostAuthority, channel: string, userId: string): Promise<void> {
    await host.inner.putMember({ channel, userId, role: 'member', addedBy: 'a', addedAt: new Date(0).toISOString(), historyFrom: null, removedAt: null });
}

describe('AuthorityScope', () => {
    it('shares while active, then passes through; rejections are not memoized', async () => {
        const scope = createAuthorityScope('t');
        let n = 0;
        expect(scope.share('k', () => ++n)).toBe(1);
        expect(scope.share('k', () => ++n)).toBe(1);
        scope.invalidate('k');
        expect(scope.share('k', () => ++n)).toBe(2);
        const failing = scope.share('f', () => Promise.reject(new Error('x')));
        await expect(failing).rejects.toThrow('x');
        expect(scope.share('f', () => 'fresh')).toBe('fresh');
        const closed = jest.fn();
        scope.onClose(closed);
        const release = scope.retain();
        scope.close();
        expect(scope.active).toBe(true);
        release();
        release();
        expect(scope.active).toBe(false);
        expect(closed).toHaveBeenCalledTimes(1);
        expect(scope.memo.size).toBe(0);
        expect(scope.share('k', () => ++n)).toBe(3);
        expect(scope.share('k', () => ++n)).toBe(4);
    });

    it('a local fan-out hands every recipient check one scope and closes it', async () => {
        const seen: Array<AuthorityScope | undefined> = [];
        const router = new LocalRealtimeRouter({ authorize: ({ scope }) => { seen.push(scope); return true; } });
        const contexts = new Map([['a', { userId: 'a' }], ['b', { userId: 'b' }], ['c', { userId: 'c' }]]);
        router._setHandle({
            getClientContext: (id: string) => contexts.get(id) ?? null,
            sendToClient: () => true,
            listClients: () => [...contexts.keys()],
        } as any);
        for (const id of contexts.keys()) router.subscribeToChannel(id, 'room');
        seen.length = 0;
        await router.sendToChannel('room', { hi: 1 }, null, { publisherClientId: 'a' });
        expect(seen).toHaveLength(4); // publisher + three recipients
        expect(new Set(seen).size).toBe(1);
        expect(seen[0]!.operation).toBe('fanout');
        expect(seen[0]!.active).toBe(false);
        // A caller-owned scope is used, and left open for its owner.
        const mine = createAuthorityScope('chat.send');
        seen.length = 0;
        await router.sendToChannel('room', { hi: 2 }, null, { publisherClientId: 'a', scope: mine });
        expect(seen.every((s) => s === mine)).toBe(true);
        expect(mine.active).toBe(true);
        mine.close();
        // isClientSubscribed forwards a probe's scope.
        const probe = createAuthorityScope('probe');
        seen.length = 0;
        await expect(router.isClientSubscribed('b', 'room', { scope: probe })).resolves.toBe(true);
        expect(seen).toEqual([probe]);
    });

    it('one chat send resolves one membership proof for every check it makes', async () => {
        const host = new HostAuthority();
        const channel = 'acme:ch:general';
        const users = ['u1', 'u2', 'u3', 'u4'];
        for (const u of users) await member(host, channel, u);
        let hookScope: AuthorityScope | undefined;
        let hookScopeActiveLater: boolean | undefined;
        let hookMembers: string[] = [];
        const { port, close } = await boot(host, {
            onChannelMessage: async (info: { scope?: AuthorityScope; members: string[] }) => {
                hookScope = info.scope;
                // An unread probe in the tail of the same send.
                await tick(5);
                hookScopeActiveLater = info.scope?.active;
                hookMembers = [...info.members].sort();
            },
        });
        const socks: Sock[] = [];
        let joinReadsBefore = 0;
        for (const u of users) {
            joinReadsBefore = host.reads;
            const ws = await connect(port, u);
            ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
            await nextFrame(ws, (f) => f.type === 'chat' && f.action === 'joined');
            socks.push(ws);
        }
        await tick(40);
        // A join: one scoped proof plus the deliberately fresh final history read.
        expect(host.reads - joinReadsBefore).toBe(2); // let the last join's history tail finish
        host.reads = 0;
        host.scopes.length = 0;
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'hello' }));
        await nextFrame(socks[0]!, (f) => f.type === 'chat' && f.action === 'sent');
        await Promise.all(socks.slice(1).map((ws) => nextFrame(ws, (f) => f.type === 'chat' && f.action === 'message')));
        await tick(30);

        // Pre-check, membership gate, three rechecks, four recipients, the
        // recipient list: one scope, one read.
        const named = host.scopes.filter(Boolean) as AuthorityScope[];
        expect(host.scopes.length).toBeGreaterThanOrEqual(10);
        expect(named).toHaveLength(host.scopes.length);
        expect(new Set(named).size).toBe(1);
        expect(named[0]!.operation).toBe('chat.send');
        expect(host.reads).toBe(1);
        expect(hookScope).toBe(named[0]);
        expect(hookScopeActiveLater).toBe(true);
        expect(hookMembers).toEqual(['u2', 'u3', 'u4']);
        expect(named[0]!.active).toBe(false);

        // Not a settled cache: the next send reads again.
        socks[1]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'again' }));
        await nextFrame(socks[1]!, (f) => f.type === 'chat' && f.action === 'sent');
        expect(host.reads).toBe(2);
        for (const ws of socks) ws.close();
        await close();
    });

    it('a revocation during the operation denies the remaining recipients', async () => {
        const host = new HostAuthority();
        const channel = 'acme:ch:secret';
        for (const u of ['u1', 'u2', 'u3']) await member(host, channel, u);
        const { port, close } = await boot(host);
        const socks: Sock[] = [];
        for (const u of ['u1', 'u2', 'u3']) {
            const ws = await connect(port, u);
            ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
            await nextFrame(ws, (f) => f.type === 'chat' && f.action === 'joined');
            socks.push(ws);
        }
        // Revoke u3 when the fan-out's first recipient check starts.
        const authorize = host.authorize;
        let armed = true;
        host.authorize = async (args) => {
            if (armed && args.kind === 'subscribe' && args.scope?.operation === 'chat.send') {
                armed = false;
                host.revoke(channel, 'u3');
            }
            return authorize(args);
        };
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'after-revoke' }));
        await tick(80);
        expect(armed).toBe(false);
        expect(socks[2]!.frames.some((f) => f.type === 'chat' && f.action === 'message' && f.message?.message === 'after-revoke')).toBe(false);
        for (const ws of socks) ws.close();
        await close();
    });
});
