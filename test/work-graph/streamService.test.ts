// 0.108: the server half of useWorkGraph's stream.
//
// Default deny (no channelFor, null mapping, an unenforced router), router
// gating at subscribe and at every delivery, per-subscriber frames from the
// host source (never the raw change), catch-up from the snapshot cursor,
// revocation as a content-free invalidate, access-restored placeholders and
// the client gateway transport driving the unchanged hook protocol.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, workGraph, type RealtimeHandle, type AuthorityScope } from '../../src/server';
import {
    WorkGraphStreamService,
    type WorkGraphSource,
    type WorkGraphStreamConfig,
    type WorkGraphStreamSubscription,
    type WorkGraphStreamTrigger,
} from '../../src/work-graph/server';
import { createWorkGraphGatewayTransport } from '../../src/client/work-graph/gatewayTransport';

type Sock = WebSocket & { frames: any[] };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const SCOPE = { personId: 'p-001', day: '2026-10-06', timezone: 'UTC' };

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
const wg = (ws: Sock, action: string, gen = 'g1') => ws.frames.filter((f) => f.type === 'work-graph' && f.action === action && f.subscriptionGeneration === gen);
const refusals = (ws: Sock, gen = 'g1') => ws.frames.filter((f) => f.type === 'error' && f.service === 'work-graph' && f.subscriptionGeneration === gen);

function delta(sub: WorkGraphStreamSubscription, n: number, marker: string) {
    return { kind: 'delta', batch: { schemaVersion: 1, subscriptionGeneration: sub.subscriptionGeneration, previousWatermark: n - 1, watermark: n, cursor: `c${n}`, policyRevision: 'r1', operations: [], marker } };
}

/** A host source: one delta per call, numbered from the subscription's cursor. */
class Source implements WorkGraphSource {
    calls: Array<{ sub: WorkGraphStreamSubscription; trigger: WorkGraphStreamTrigger; scope: AuthorityScope }> = [];
    next?: (sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger) => readonly unknown[] | Promise<readonly unknown[]>;
    frames(sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger, opts: { scope: AuthorityScope }) {
        this.calls.push({ sub, trigger, scope: opts.scope });
        if (this.next) return this.next(sub, trigger);
        const n = Number(sub.cursor.slice(1)) + 1;
        return [delta(sub, n, `for-${String(sub.userContext?.userId)}`)];
    }
}

const allowed = new Set(['alice', 'bob']);
async function boot(config: WorkGraphStreamConfig, opts: { authorize?: boolean } = {}) {
    const server = http.createServer();
    const checks: Array<{ kind: string; channel: string; user: string; scope?: AuthorityScope }> = [];
    const handle: RealtimeHandle = attachRealtime(server, {
        features: [workGraph(config)],
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => ({ userId: new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon', org: 'acme' }),
        ...(opts.authorize === false ? {} : {
            authorize: async ({ kind, channel, ctx, scope }: any) => {
                checks.push({ kind, channel, user: ctx?.userId, scope });
                return allowed.has(ctx?.userId);
            },
        }),
    } as any);
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const service = handle.services['work-graph'] as unknown as WorkGraphStreamService;
    return { handle, port, service, checks, close: async () => { await handle.dispose(); await new Promise<void>((r) => server.close(() => r())); } };
}
const channelFor: WorkGraphStreamConfig['channelFor'] = (scope, ctx) => `${String(ctx.userContext?.org)}:work-graph:${scope.personId}:${scope.day}`;
const CH = 'acme:work-graph:p-001:2026-10-06';
const subscribe = (ws: Sock, extra: Record<string, unknown> = {}) =>
    ws.send(JSON.stringify({ service: 'work-graph', action: 'subscribe', subscriptionGeneration: 'g1', scope: SCOPE, cursor: 'c0', ...extra }));

afterEach(() => { allowed.clear(); allowed.add('alice'); allowed.add('bob'); });

describe('workGraph() stream (0.108)', () => {
    it('refuses by default: no channelFor, a null mapping, an unenforced router, no source', async () => {
        const source = new Source();
        for (const [config, opts] of [
            [{ source }, {}],
            [{ source, channelFor: () => null }, {}],
            [{ source, channelFor }, { authorize: false }],
            [{ channelFor }, {}],
        ] as Array<[WorkGraphStreamConfig, { authorize?: boolean }]>) {
            const t = await boot(config, opts);
            const ws = await connect(t.port, 'alice');
            subscribe(ws);
            await until(() => refusals(ws).length === 1);
            expect(refusals(ws)[0].code).toBe('WORK_GRAPH_SUBSCRIBE_REFUSED');
            expect(wg(ws, 'subscribed')).toHaveLength(0);
            expect(source.calls).toHaveLength(0);
            ws.close();
            await t.close();
        }
    });

    it('the router authorize gates subscribe', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const ws = await connect(t.port, 'mallory');
        subscribe(ws);
        await until(() => refusals(ws).length === 1);
        expect(ws.frames.some((f) => f.code === 'AUTHZ_CHANNEL_DENIED' && f.channel === CH)).toBe(true);
        expect(source.calls).toHaveLength(0);
        ws.close();
        await t.close();
    });

    it('catches up on subscribe, then each publish sends every subscriber its own frames under one scope', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const a = await connect(t.port, 'alice');
        const b = await connect(t.port, 'bob');
        subscribe(a);
        subscribe(b, { cursor: 'c5' });
        await until(() => wg(a, 'message').length === 1 && wg(b, 'message').length === 1);
        expect(wg(a, 'subscribed')).toHaveLength(1);
        expect(source.calls.map((c) => c.trigger.reason)).toEqual(['subscribe', 'subscribe']);
        expect(wg(a, 'message')[0].message.batch.cursor).toBe('c1');
        expect(wg(b, 'message')[0].message.batch.cursor).toBe('c6');

        source.calls.length = 0;
        t.checks.length = 0;
        const secret = { private: 'never on the wire' };
        await expect(t.service.publish(CH, secret)).resolves.toEqual({ delivered: 2 });
        await until(() => wg(a, 'message').length === 2 && wg(b, 'message').length === 2);
        // Continued from each subscriber's own cursor, filtered per viewer.
        expect(wg(a, 'message')[1].message.batch).toMatchObject({ cursor: 'c2', marker: 'for-alice' });
        expect(wg(b, 'message')[1].message.batch).toMatchObject({ cursor: 'c7', marker: 'for-bob' });
        expect(source.calls.every((c) => c.trigger.reason === 'change' && (c.trigger as any).change === secret)).toBe(true);
        expect(JSON.stringify([...a.frames, ...b.frames])).not.toContain('never on the wire');
        // Every check of the publish (before and after the source) shares one scope, closed after.
        const scopes = new Set(t.checks.map((c) => c.scope));
        expect(t.checks.length).toBeGreaterThanOrEqual(4);
        expect(scopes.size).toBe(1);
        const [scope] = [...scopes];
        expect(scope?.operation).toBe('work-graph.publish');
        expect(scope?.active).toBe(false);
        expect(source.calls[0]!.scope).toBe(scope);
        // Another channel: nothing.
        await expect(t.service.publish('acme:work-graph:p-002:2026-10-06', {})).resolves.toEqual({ delivered: 0 });
        a.close(); b.close();
        await t.close();
    });

    it('a revoked subscriber gets a content-free invalidate and nothing after', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const a = await connect(t.port, 'alice');
        subscribe(a);
        await until(() => wg(a, 'message').length === 1);
        // Revoked while the source computes the frames.
        source.next = (sub) => { allowed.delete('alice'); return [delta(sub, 2, 'leak')]; };
        await t.service.publish(CH, {});
        await until(() => wg(a, 'message').length === 2);
        expect(wg(a, 'message')[1].message).toEqual({ kind: 'invalidate', subscriptionGeneration: 'g1', reason: 'policy-changed' });
        expect(JSON.stringify(a.frames)).not.toContain('leak');
        source.next = undefined;
        allowed.add('alice');
        await expect(t.service.publish(CH, {})).resolves.toEqual({ delivered: 0 });
        expect(t.service.getStats().subscriptions).toBe(0);
        a.close();
        await t.close();
    });

    it('drops frames for another generation; a source failure ends the stream with source-unavailable', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const a = await connect(t.port, 'alice');
        subscribe(a);
        await until(() => wg(a, 'message').length === 1);
        source.next = () => [{ kind: 'reset-required', subscriptionGeneration: 'someone-else', reason: 'gap' }];
        await expect(t.service.publish(CH, {})).resolves.toEqual({ delivered: 0 });
        source.next = () => { throw new Error('platform down'); };
        await t.service.publish(CH, {});
        await until(() => wg(a, 'message').length === 2);
        expect(wg(a, 'message')[1].message).toEqual({ kind: 'reset-required', subscriptionGeneration: 'g1', reason: 'source-unavailable' });
        expect(t.service.getStats().subscriptions).toBe(0);
        a.close();
        await t.close();
    });

    it('unsubscribe and disconnect forget the subscription; clients cannot publish', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const a = await connect(t.port, 'alice');
        subscribe(a);
        await until(() => wg(a, 'message').length === 1);
        a.send(JSON.stringify({ service: 'work-graph', action: 'publish', subscriptionGeneration: 'g1', channel: CH }));
        await until(() => refusals(a).length === 1);
        expect(refusals(a)[0].code).toBe('WORK_GRAPH_BAD_REQUEST');
        a.send(JSON.stringify({ service: 'work-graph', action: 'unsubscribe', subscriptionGeneration: 'g1' }));
        await until(() => t.service.getStats().subscriptions === 0);
        const b = await connect(t.port, 'bob');
        subscribe(b);
        await until(() => wg(b, 'message').length === 1);
        b.close();
        await until(() => t.service.getStats().clients === 0);
        a.close();
        await t.close();
    });

    it('awaitAccess holds a content-free placeholder until the router admits the access signal', async () => {
        const t = await boot({ channelFor });
        const a = await connect(t.port, 'carol');
        a.send(JSON.stringify({ service: 'work-graph', action: 'subscribe', subscriptionGeneration: 'g1', scope: SCOPE, awaitAccess: 1 }));
        await until(() => wg(a, 'awaiting').length === 1);
        await expect(t.service.signalAccess(CH)).resolves.toEqual({ restored: 0 });
        allowed.add('carol');
        await expect(t.service.signalAccess(CH)).resolves.toEqual({ restored: 1 });
        await until(() => wg(a, 'message').length === 1);
        expect(wg(a, 'message')[0].message).toEqual({ kind: 'reset-required', subscriptionGeneration: 'g1', reason: 'access-restored' });
        expect(t.service.getStats().awaiting).toBe(0);
        a.close();
        await t.close();
    });

    it('createWorkGraphGatewayTransport speaks the protocol for the unchanged hook', async () => {
        const source = new Source();
        const t = await boot({ source, channelFor });
        const ws = await connect(t.port, 'alice');
        const handlers = new Set<(m: any) => void>();
        ws.on('message', (raw) => { const m = JSON.parse(String(raw)); for (const h of handlers) h(m); });
        const transport = createWorkGraphGatewayTransport({
            gateway: { send: (f) => ws.send(JSON.stringify(f)), onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); } },
            fetchSnapshot: async () => ({}),
        });
        const got: unknown[] = [];
        let errors = 0;
        const socket = transport.openWebSocket({
            scope: { ...SCOPE, viewerId: 'alice' }, cursor: 'c0', subscriptionGeneration: 'g1',
            onMessage: (m) => got.push(m), onClose: () => undefined, onError: () => { errors++; },
        });
        await until(() => got.length === 1);
        expect(got[0]).toMatchObject({ kind: 'delta', batch: { subscriptionGeneration: 'g1', cursor: 'c1' } });
        socket.close();
        await until(() => t.service.getStats().subscriptions === 0);
        // A refusal reaches onError.
        allowed.delete('alice');
        transport.openWebSocket({
            scope: { ...SCOPE, viewerId: 'alice' }, cursor: 'c0', subscriptionGeneration: 'g2',
            onMessage: () => undefined, onClose: () => undefined, onError: () => { errors++; },
        });
        await until(() => errors === 1);
        ws.close();
        await t.close();
    });
});
