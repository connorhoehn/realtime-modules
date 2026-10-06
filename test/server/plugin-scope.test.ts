// 0.108: router plugins observe the operation's authority scope.
//
// A chat send's onMessage plugins (the host's unread/notify probes) receive
// the send's own scope, so their membership reads and readable-subscription
// probes join the one proof the send's authorize checks resolved. The router
// retains the scope while a plugin's promise is pending and releases it when
// it settles (or after PLUGIN_SCOPE_RETAIN_MAX_MS); after that every read is
// fresh. A revocation observed during the operation denies the plugin's
// remaining probes.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
    attachRealtime, chat, LocalRealtimeRouter, createAuthorityScope, PLUGIN_SCOPE_RETAIN_MAX_MS,
    type AuthorityScope, type RealtimeHandle, type RealtimeFeaturePlugin,
} from '../../src/server';
import { MemoryChatMembershipStore, type ChatMember, type ChatMembershipStore } from '../../src/chat/ChatMembershipStore';

type Sock = WebSocket & { frames: any[] };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function connect(port: number, user: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?user=${user}`) as Sock;
        ws.frames = [];
        ws.on('message', (raw) => { try { ws.frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition timeout');
        await tick(5);
    }
}

/** Same host shape as authority-scope.test.ts: one read per channel per scope, revocable. */
class HostAuthority implements ChatMembershipStore {
    reads = 0;
    readonly inner = new MemoryChatMembershipStore();
    private readonly observers = new Set<{ channel: string; revoked: boolean }>();

    async listMembers(channel: string, opts?: { scope?: AuthorityScope }): Promise<ChatMember[]> {
        return (await this.proof(channel, opts?.scope)).rows;
    }
    getMember(channel: string, userId: string) { return this.inner.getMember(channel, userId); }
    putMember(member: ChatMember) { return this.inner.putMember(member); }

    proof(channel: string, scope?: AuthorityScope): Promise<{ rows: ChatMember[]; observer: { revoked: boolean } }> {
        const read = () => {
            const observer = { channel, revoked: false };
            this.observers.add(observer);
            scope?.onClose(() => this.observers.delete(observer));
            this.reads++;
            return tick(2).then(async () => ({ rows: await this.inner.listMembers(channel), observer }));
        };
        return scope ? scope.share(`members:${channel}`, read) : read();
    }
    revoke(channel: string, userId: string): void {
        void this.inner.getMember(channel, userId).then((m) => m && this.inner.putMember({ ...m, removedAt: new Date().toISOString() }));
        for (const o of this.observers) if (o.channel === channel) o.revoked = true;
    }
    authorize = async ({ channel, ctx, scope }: { channel: string; ctx: any; scope?: AuthorityScope }): Promise<boolean> => {
        const p = await this.proof(channel, scope);
        if (p.observer.revoked) return false;
        if (p.rows.length === 0) return true;
        return p.rows.some((r) => r.userId === ctx?.userId && !r.removedAt);
    };
}

async function boot(host: HostAuthority, plugins: RealtimeFeaturePlugin[]) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [chat({ membershipStore: host })],
        path: '/realtime',
        plugins,
        auth: async (req: http.IncomingMessage) => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon' }),
        authorize: (args: any) => host.authorize(args),
    } as any);
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    return { handle, port, close: async () => { await handle.dispose(); await new Promise<void>((r) => server.close(() => r())); } };
}

async function joinAll(port: number, host: HostAuthority, channel: string, users: string[]): Promise<Sock[]> {
    const socks: Sock[] = [];
    for (const u of users) {
        await host.inner.putMember({ channel, userId: u, role: 'member', addedBy: 'a', addedAt: new Date(0).toISOString(), historyFrom: null, removedAt: null });
    }
    for (const u of users) {
        const ws = await connect(port, u);
        ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
        await until(() => ws.frames.some((f) => f.type === 'chat' && f.action === 'joined'));
        socks.push(ws);
    }
    await tick(30);
    return socks;
}

describe('plugin authority scope (0.108)', () => {
    it('a chat send hands onMessage plugins its scope; their probes share the one proof', async () => {
        const host = new HostAuthority();
        const channel = 'acme:ch:general';
        let handle: RealtimeHandle | null = null;
        const seen: Array<{ scope?: AuthorityScope; activeAfterAwait?: boolean; readable: string[] }> = [];
        const notify: RealtimeFeaturePlugin = {
            name: 'notify',
            onMessage: async (info) => {
                const msg = info.message as any;
                if (msg?.type !== 'chat' || msg.action !== 'message') return;
                const entry: { scope?: AuthorityScope; activeAfterAwait?: boolean; readable: string[] } = { scope: info.scope, readable: [] };
                seen.push(entry);
                const opts = info.scope ? { scope: info.scope } : undefined;
                const rows = await host.listMembers(info.channelId, opts);
                await tick(5);
                entry.activeAfterAwait = info.scope?.active;
                const router = handle!.router;
                for (const row of rows) {
                    for (const { clientId } of router.getClientsByUserId!([row.userId]) as { clientId: string }[]) {
                        if (await router.isClientSubscribed!(clientId, info.channelId, opts)) entry.readable.push(row.userId);
                    }
                }
            },
        };
        const booted = await boot(host, [notify]);
        handle = booted.handle;
        const socks = await joinAll(booted.port, host, channel, ['u1', 'u2', 'u3', 'u4']);
        host.reads = 0;
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'hello' }));
        await until(() => seen.length === 1 && seen[0]!.readable.length === 4);
        await tick(20);
        expect(seen[0]!.scope?.operation).toBe('chat.send');
        expect(seen[0]!.activeAfterAwait).toBe(true);
        // Pre-check, gate, rechecks, fan-out, recipient list, plugin list and
        // four plugin probes: one membership read for the whole send.
        expect(host.reads).toBe(1);
        // Released once the plugin settled: the scope is closed, not a cache.
        expect(seen[0]!.scope!.active).toBe(false);
        socks[1]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'again' }));
        await until(() => seen.length === 2 && seen[1]!.readable.length === 4);
        expect(host.reads).toBe(2);
        expect(seen[1]!.scope).not.toBe(seen[0]!.scope);
        for (const ws of socks) ws.close();
        await booted.close();
    });

    it('a revocation during the plugin tail denies its remaining probes', async () => {
        const host = new HostAuthority();
        const channel = 'acme:ch:secret';
        let handle: RealtimeHandle | null = null;
        const readable: string[] = [];
        let done = false;
        const notify: RealtimeFeaturePlugin = {
            name: 'notify',
            onMessage: async (info) => {
                const msg = info.message as any;
                if (msg?.type !== 'chat' || msg.action !== 'message') return;
                const router = handle!.router;
                const opts = info.scope ? { scope: info.scope } : undefined;
                for (const user of ['u2', 'u3']) {
                    if (user === 'u3') host.revoke(channel, 'u3');
                    for (const { clientId } of router.getClientsByUserId!([user]) as { clientId: string }[]) {
                        if (await router.isClientSubscribed!(clientId, channel, opts)) readable.push(user);
                    }
                }
                done = true;
            },
        };
        const booted = await boot(host, [notify]);
        handle = booted.handle;
        const socks = await joinAll(booted.port, host, channel, ['u1', 'u2', 'u3']);
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'x' }));
        await until(() => done);
        // The shared proof was poisoned by the revocation: u2 (probed before)
        // was readable, u3 (after) is denied — and so would anyone after it.
        expect(readable).toEqual(['u2']);
        for (const ws of socks) ws.close();
        await booted.close();
    });

    it('server fan-out and subscribe hand plugins their scope; sync plugins release at once', async () => {
        const scopes: Array<{ hook: string; scope?: AuthorityScope }> = [];
        const router = new LocalRealtimeRouter({
            authorize: () => true,
            plugins: [{
                name: 'p',
                onConnect: (info) => { scopes.push({ hook: 'connect', scope: info.scope }); },
                onMessage: (info) => { scopes.push({ hook: 'message', scope: info.scope }); },
            }],
        });
        const contexts = new Map([['a', { userId: 'a' }]]);
        router._setHandle({ getClientContext: (id: string) => contexts.get(id) ?? null, sendToClient: () => true, listClients: () => ['a'] } as any);
        const sub = createAuthorityScope('chat.join');
        await router.subscribeToChannel('a', 'room', { scope: sub });
        await router.subscribeToChannel('a', 'room2');
        await router.sendToChannel('room', { hi: 1 });
        expect(scopes[0]).toEqual({ hook: 'connect', scope: sub });
        expect(scopes[1]).toEqual({ hook: 'connect' });
        expect(scopes[2]!.hook).toBe('message');
        expect(scopes[2]!.scope?.operation).toBe('fanout');
        expect(scopes[2]!.scope?.active).toBe(false);
        sub.close();
        expect(sub.active).toBe(false);
    });

    it('a hung plugin holds the scope at most PLUGIN_SCOPE_RETAIN_MAX_MS', async () => {
        jest.useFakeTimers();
        try {
            let captured: AuthorityScope | undefined;
            const router = new LocalRealtimeRouter({
                plugins: [{ name: 'hung', onMessage: (info) => { captured = info.scope; return new Promise<void>(() => undefined); } }],
            });
            router._setHandle({ getClientContext: () => ({ userId: 'a' }), sendToClient: () => true, listClients: () => [] } as any);
            await router.sendToChannel('room', { hi: 1 });
            expect(captured?.active).toBe(true);
            jest.advanceTimersByTime(PLUGIN_SCOPE_RETAIN_MAX_MS);
            expect(captured?.active).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });
});
