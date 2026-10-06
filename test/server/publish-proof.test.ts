// 0.109: publish proofs (authorityScope.ts P1-P5), single node.
//
// One chat send asked the host the same sender-side publish question five
// times on a local router (pre-check, pre-persist, post-persist, the router's
// own fan-out check, the ack recheck). With `publishProofMaxAgeMs` it asks
// once per (client, channel) per send; every recipient is still asked; a
// revocation the host reports mid-send makes the next recheck ask fresh.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, chat, LocalRealtimeRouter, createAuthorityScope, revokePublishProofs, publishProofKey,
    type AuthorityScope, type RealtimeHandle } from '../../src/server';
import { InMemoryChatStore } from '../../src/chat';
import { acceptsOriginPublishProof, publishProofStartedAt, sharePublishProof, PUBLISH_PROOF_SKEW_MS } from '../../src/server-ws/authorityScope';

type Sock = WebSocket & { frames: any[] };
type Ask = { kind: string; clientId: string; channel: string; ctx: any; scope?: AuthorityScope };

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
async function until(ws: Sock, match: (f: any) => boolean, ms = 2000): Promise<any> {
    for (let waited = 0; waited < ms; waited += 5) {
        const found = ws.frames.find(match);
        if (found) return found;
        await tick(5);
    }
    throw new Error('frame timeout');
}

class Host {
    asks: Ask[] = [];
    revoked = new Set<string>();
    onAsk: ((a: Ask) => void) | null = null;
    authorize = async (a: Ask): Promise<boolean> => {
        this.asks.push(a);
        this.onAsk?.(a);
        await tick(1);
        return !this.revoked.has(`${a.kind}:${a.ctx?.userId}`);
    };
    publishes() { return this.asks.filter((a) => a.kind === 'publish'); }
    subscribes() { return this.asks.filter((a) => a.kind === 'subscribe'); }
}

async function boot(host: Host, maxAge: number | undefined, store = new InMemoryChatStore()) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [chat({ chatStore: store })],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon' }),
        authorize: (a: any) => host.authorize(a),
        ...(maxAge !== undefined ? { publishProofMaxAgeMs: maxAge } : {}),
    } as any);
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const socks: Sock[] = [];
    for (const u of ['u1', 'u2', 'u3']) {
        const ws = await connect(port, u);
        ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'room' }));
        await until(ws, (f) => f.type === 'chat' && f.action === 'joined');
        socks.push(ws);
    }
    await tick(20);
    host.asks.length = 0;
    return {
        socks,
        close: async () => { for (const ws of socks) ws.close(); await handle.dispose(); await new Promise<void>((r) => server.close(() => r())); },
    };
}

async function sendOnce(socks: Sock[], text: string): Promise<void> {
    socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel: 'room', message: text }));
    await until(socks[0]!, (f) => f.type === 'chat' && f.action === 'sent');
    await Promise.all(socks.slice(1).map((ws) => until(ws, (f) => f.type === 'chat' && f.action === 'message' && f.message?.message === text)));
    await tick(20);
}

describe('publish proofs (0.109)', () => {
    it('off by default: every publish check of a send asks authorize (5 on a local router)', async () => {
        const host = new Host();
        const { socks, close } = await boot(host, undefined);
        await sendOnce(socks, 'before');
        expect(host.publishes()).toHaveLength(5);
        expect(host.subscribes()).toHaveLength(3); // every recipient incl. the echo
        await close();
    });

    it('on: one publish authorize per send; every recipient is still asked; the next send asks again', async () => {
        const host = new Host();
        const { socks, close } = await boot(host, 2000);
        await sendOnce(socks, 'after');
        expect(host.publishes()).toHaveLength(1);
        expect(host.subscribes()).toHaveLength(3);
        host.asks.length = 0;
        await sendOnce(socks, 'again');
        expect(host.publishes()).toHaveLength(1);
        await close();
    });

    it('a revocation the host reports while the message persists makes the post-persist recheck ask fresh and deny', async () => {
        const host = new Host();
        let sendScope: AuthorityScope | undefined;
        host.onAsk = (a) => { if (a.scope?.operation === 'chat.send') sendScope = a.scope; };
        class RevokingStore extends InMemoryChatStore {
            async putMessage(m: any) {
                await super.putMessage(m);
                if (m.message === 'revoked-mid-send') {
                    host.revoked.add('publish:u1');
                    expect(revokePublishProofs(sendScope)).toBe(1); // P4
                }
            }
        }
        const { socks, close } = await boot(host, 2000, new RevokingStore());
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel: 'room', message: 'revoked-mid-send' }));
        await tick(150);
        expect(host.publishes()).toHaveLength(2); // the shared proof, then the fresh recheck
        expect(socks[0]!.frames.some((f) => f.action === 'sent')).toBe(false);
        for (const ws of socks.slice(1)) expect(ws.frames.some((f) => f.message?.message === 'revoked-mid-send')).toBe(false);
        await close();
    });

    it('without a host revocation, a recipient revoked mid-send is still refused (subscribe is never shared)', async () => {
        const host = new Host();
        host.onAsk = (a) => { if (a.kind === 'publish') host.revoked.add('subscribe:u3'); };
        const { socks, close } = await boot(host, 2000);
        socks[0]!.send(JSON.stringify({ service: 'chat', action: 'send', channel: 'room', message: 'x' }));
        await until(socks[1]!, (f) => f.message?.message === 'x');
        await tick(40);
        expect(socks[2]!.frames.some((f) => f.message?.message === 'x')).toBe(false);
        await close();
    });
});

describe('publish proof helpers (P1-P5)', () => {
    const ctx = { userId: 'u1' };

    it('shares per (client, channel, context) only while the scope is active and young enough', async () => {
        const scope = createAuthorityScope('chat.send');
        let n = 0;
        const ask = () => { n++; return Promise.resolve(true); };
        await sharePublishProof(scope, 'c1', 'room', ctx, 1000, ask);
        await sharePublishProof(scope, 'c1', 'room', ctx, 1000, ask);
        expect(n).toBe(1);
        await sharePublishProof(scope, 'c2', 'room', ctx, 1000, ask);   // another client
        await sharePublishProof(scope, 'c1', 'other', ctx, 1000, ask);  // another channel
        await sharePublishProof(scope, 'c1', 'room', { userId: 'u1' }, 1000, ask); // a replaced context (P3)
        expect(n).toBe(4);
        await sharePublishProof(scope, 'c1', 'room', ctx, 0, ask); // off
        expect(n).toBe(5);
        scope.close();
        await sharePublishProof(scope, 'c1', 'room', ctx, 1000, ask); // closed (P2a)
        await sharePublishProof(scope, 'c1', 'room', ctx, 1000, ask);
        expect(n).toBe(7);
        expect(scope.memo.size).toBe(0);
    });

    it('expires by age from when the authorize call started (P2b)', async () => {
        const scope = createAuthorityScope('chat.send');
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            let n = 0;
            const ask = () => { n++; return true; };
            sharePublishProof(scope, 'c1', 'room', ctx, 100, ask);
            now += 100; sharePublishProof(scope, 'c1', 'room', ctx, 100, ask);
            expect(n).toBe(1);
            now += 1; sharePublishProof(scope, 'c1', 'room', ctx, 100, ask);
            expect(n).toBe(2);
        } finally { Date.now = realNow; scope.close(); }
    });

    it('drops rejections, keeps denials, and revokes by channel or all (P4)', async () => {
        const scope = createAuthorityScope('chat.send');
        await expect(sharePublishProof(scope, 'c1', 'room', ctx, 1000, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
        await tick(1);
        expect(scope.memo.has(publishProofKey('room', 'c1'))).toBe(false);
        expect(await sharePublishProof(scope, 'c1', 'room', ctx, 1000, () => Promise.resolve(false))).toBe(false);
        expect(await sharePublishProof(scope, 'c1', 'room', ctx, 1000, () => Promise.resolve(true))).toBe(false);
        sharePublishProof(scope, 'c1', 'presence:room', ctx, 1000, () => true);
        scope.memo.set('members:room', 'host proof');
        expect(revokePublishProofs(scope, 'room')).toBe(1);
        expect(scope.memo.has(publishProofKey('presence:room', 'c1'))).toBe(true);
        expect(revokePublishProofs(scope)).toBe(1);
        expect(scope.memo.get('members:room')).toBe('host proof'); // host keys untouched
        scope.close();
    });

    it('marks only a live, settled, allowed, young proof, and a peer accepts only a fresh one (P5)', async () => {
        const scope = createAuthorityScope('fanout');
        let release!: (v: boolean) => void;
        const pending = sharePublishProof(scope, 'c1', 'room', ctx, 1000, () => new Promise<boolean>((r) => { release = r; }));
        expect(publishProofStartedAt(scope, 'c1', 'room', 1000)).toBeNull(); // pending
        release(true); await pending;
        const at = publishProofStartedAt(scope, 'c1', 'room', 1000);
        expect(typeof at).toBe('number');
        expect(publishProofStartedAt(scope, 'c1', 'room', 0)).toBeNull();
        await sharePublishProof(scope, 'c2', 'room', ctx, 1000, () => Promise.resolve(false));
        expect(publishProofStartedAt(scope, 'c2', 'room', 1000)).toBeNull(); // denied
        scope.close();
        expect(publishProofStartedAt(scope, 'c1', 'room', 1000)).toBeNull(); // closed

        const now = 5_000_000;
        expect(acceptsOriginPublishProof(now - 1000, 1000, now)).toBe(true);
        expect(acceptsOriginPublishProof(now - 1001, 1000, now)).toBe(false);
        expect(acceptsOriginPublishProof(now + PUBLISH_PROOF_SKEW_MS, 1000, now)).toBe(true);
        expect(acceptsOriginPublishProof(now + PUBLISH_PROOF_SKEW_MS + 1, 1000, now)).toBe(false);
        expect(acceptsOriginPublishProof(now, 0, now)).toBe(false);
        for (const bad of [undefined, null, '5000000', NaN, Infinity, {}]) expect(acceptsOriginPublishProof(bad, 1000, now)).toBe(false);
    });

    it('a local router shares the publisher check of one scoped fan-out but asks every recipient', async () => {
        const asks: string[] = [];
        const router = new LocalRealtimeRouter({ publishProofMaxAgeMs: 1000,
            authorize: ({ kind, clientId }) => { asks.push(`${kind}:${clientId}`); return Promise.resolve(true); } });
        const contexts = new Map([['a', { userId: 'a' }], ['b', { userId: 'b' }]]);
        router._setHandle({ getClientContext: (id: string) => contexts.get(id) ?? null, sendToClient: () => true,
            listClients: () => [...contexts.keys()] } as any);
        await router.subscribeToChannel('a', 'room'); await router.subscribeToChannel('b', 'room');
        asks.length = 0;
        const scope = createAuthorityScope('chat.send');
        expect(await router.checkChannel('publish', 'a', 'room', { scope })).toBe(true);
        await router.sendToChannel('room', { hi: 1 }, null, { publisherClientId: 'a', scope });
        await router.sendToChannel('room', { hi: 2 }, null, { publisherClientId: 'a', scope });
        expect(asks.filter((x) => x.startsWith('publish'))).toEqual(['publish:a']);
        expect(asks.filter((x) => x.startsWith('subscribe')).sort()).toEqual(['subscribe:a', 'subscribe:a', 'subscribe:b', 'subscribe:b']);
        // A replaced connection context never reuses the proof (P3).
        contexts.set('a', { userId: 'a' });
        await router.sendToChannel('room', { hi: 3 }, null, { publisherClientId: 'a', scope });
        expect(asks.filter((x) => x.startsWith('publish'))).toEqual(['publish:a', 'publish:a']);
        scope.close();
        expect(() => new LocalRealtimeRouter({ publishProofMaxAgeMs: -1 })).toThrow();
    });
});
