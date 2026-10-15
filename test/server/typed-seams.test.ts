// 0.119 (lane R4): typed services, liveUsersOn, stats, appendServerMessage,
// parseChatPluginMessage, the 256 default channel-name length.
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, chat, type RealtimeHandle, type RealtimeFeaturePlugin } from '../../src/server';
import { parseChatPluginMessage, type ChatMessage } from '../../src/chat';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
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
async function until(fn: () => boolean, ms = 2000) {
    const start = Date.now();
    while (!fn()) { if (Date.now() - start > ms) throw new Error('timeout'); await tick(5); }
}

describe('typed seams (0.119)', () => {
    let server: http.Server, handle: RealtimeHandle, port: number;
    const seen: any[] = [];
    const plugin: RealtimeFeaturePlugin = { name: 'p', onMessage: (info) => { seen.push(info); } };
    beforeAll(async () => {
        server = http.createServer();
        handle = attachRealtime(server, {
            features: [chat({})], path: '/realtime', plugins: [plugin],
            auth: async (req: http.IncomingMessage) => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon' }),
        } as any);
        port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
    });
    afterAll(async () => { await handle.dispose(); await new Promise<void>((r) => server.close(() => r())); });

    it('handle.services.chat is typed; no notification/call without the feature', () => {
        // Compile-time: `appendServerMessage` exists on the typed accessor.
        const svc = handle.services.chat!;
        expect(typeof svc.appendServerMessage).toBe('function');
        expect(handle.services.notification).toBeUndefined();
    });

    it('liveUsersOn answers only subscribed users; appendServerMessage runs plugins and reaches subscribers', async () => {
        const a = await connect(port, 'alice');
        const b = await connect(port, 'bob');
        const channel = 'tenant:ch:' + 'x'.repeat(150); // > 50, < 256
        a.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
        await until(() => a.frames.some((f) => f.type === 'chat' && f.action === 'joined'));
        expect([...await handle.router.liveUsersOn!(channel, ['alice', 'bob', 'carol'])]).toEqual(['alice']);

        seen.length = 0;
        const message = { id: 'm1', channel, clientId: 'server', userId: 'alice', message: 'hi', timestamp: new Date().toISOString() } as ChatMessage;
        await handle.services.chat!.appendServerMessage(channel, message);
        await until(() => a.frames.some((f) => f.action === 'message' && f.message?.id === 'm1'));
        expect(seen.some((i) => i.channelId === channel && i.message?.message?.id === 'm1')).toBe(true);
        expect((await handle.services.chat!.getChannelHistory(channel)).map((m) => m.id)).toContain('m1');
        a.close(); b.close();
    });

    it('stats() and onStats() report sockets and process health', async () => {
        const c = await connect(port, 'carl');
        const s = handle.stats();
        expect(s.sockets).toBeGreaterThanOrEqual(1);
        expect(s.activeCalls).toBe(0);
        expect(s.rssMb).toBeGreaterThan(0);
        expect(typeof s.eventLoopDelayP99Ms).toBe('number');
        const got: number[] = [];
        const off = handle.onStats((x) => got.push(x.sockets), { intervalMs: 20 });
        await until(() => got.length >= 2);
        off();
        const n = got.length;
        await tick(60);
        expect(got.length).toBe(n);
        c.close();
    });
});

describe('parseChatPluginMessage', () => {
    const frame = (message: object) => ({ type: 'chat', action: 'message', message });
    it('accepts a message whose stamped sender is the publisher', () => {
        const r = parseChatPluginMessage({ clientId: 'c', channelId: 'chat:social:dm:a:b', userId: 'u1',
            message: frame({ id: '1', userId: 'u1', message: 'yo', metadata: { displayName: 'U' } }) });
        expect(r).toMatchObject({ channel: 'social:dm:a:b', sender: 'u1', text: 'yo', displayName: 'U' });
    });
    it('refuses a forged stamp, a non-chat frame, and an unattributed publish', () => {
        expect(parseChatPluginMessage({ clientId: 'c', channelId: 'r', userId: 'u1', message: frame({ userId: 'u2', message: 'x' }) })).toBeNull();
        expect(parseChatPluginMessage({ clientId: 'c', channelId: 'r', userId: 'u1', message: { type: 'presence' } })).toBeNull();
        expect(parseChatPluginMessage({ clientId: 'server', channelId: 'r', message: frame({ message: 'x' }) })).toBeNull();
    });
    it('falls back to resolveUserId', () => {
        const r = parseChatPluginMessage({ clientId: 'c9', channelId: 'r', message: frame({ message: 'x' }) }, { resolveUserId: (c) => c === 'c9' ? 'u9' : undefined });
        expect(r?.sender).toBe('u9');
    });
});
