// 0.107: activity() and pipeline() are secure by default.
//
//  activity  no client publish, no broadcast auto-subscribe, history only
//            through the router's subscribe check (fail closed without one),
//            a server-side publish(channel, event) with per-channel history,
//            and `channel` on every activity:event frame.
//  pipeline  the cross-run firehoses are opt-in, and channelFor maps a wire
//            channel to the router channel the authorize hook judges.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, activity, pipeline, type RealtimeFeature, type RealtimeHandle } from '../../src/server';
import { ActivityService } from '../../src/activity/ActivityService';
import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';

const LOGGER = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function connect(port: number, user: string): Promise<WebSocket & { frames: any[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?user=${user}`) as WebSocket & { frames: any[] };
        ws.frames = [];
        ws.on('message', (raw) => { try { ws.frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function nextFrame(ws: WebSocket & { frames: any[] }, match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
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

const settle = () => new Promise((r) => setTimeout(r, 60));

async function boot(features: RealtimeFeature[], authorize?: (args: any) => boolean | Promise<boolean>) {
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features,
        path: '/realtime',
        auth: async (req: http.IncomingMessage) => {
            const user = new URL(req.url ?? '', 'http://x').searchParams.get('user') ?? 'anon';
            return { userId: user, org: user.startsWith('acme') ? 'acme' : 'other' };
        },
        ...(authorize ? { authorize } : {}),
    } as any);
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const close = async () => {
        await handle.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { handle, port, close };
}

// Tenant rule: a user may read channels under their own org prefix only.
const tenantAuthorize = ({ channel, ctx }: { channel: string; ctx: any }) =>
    typeof ctx?.org === 'string' && channel.startsWith(`${ctx.org}:`);

describe('activity() — secure defaults', () => {
    it('refuses client publish and does not auto-subscribe the broadcast', async () => {
        const { handle, port, close } = await boot([activity()]);
        const a = await connect(port, 'acme-a');
        const b = await connect(port, 'acme-b');
        a.send(JSON.stringify({ service: 'activity', action: 'publish', event: { eventType: 'x' } }));
        const err = await nextFrame(a, (f) => f.type === 'error' && f.service === 'activity');
        expect(err.code).toBe('ACTIVITY_PUBLISH_DISABLED');
        await (handle.services.activity as unknown as ActivityService).publish(ActivityService.BROADCAST_CHANNEL, { eventType: 'global' });
        await settle();
        expect(b.frames.some((f) => f.type === 'activity:event')).toBe(false);
        expect(a.frames.some((f) => f.type === 'activity:event')).toBe(false);
        a.close(); b.close();
        await close();
    });

    it('server publish writes per-channel history and frames carry channel', async () => {
        const { handle, port, close } = await boot([activity()], tenantAuthorize);
        const a = await connect(port, 'acme-a');
        const other = await connect(port, 'other-z');
        a.send(JSON.stringify({ service: 'activity', action: 'subscribe', channelId: 'acme:run:1' }));
        await nextFrame(a, (f) => f.type === 'activity' && f.action === 'subscribed');
        other.send(JSON.stringify({ service: 'activity', action: 'subscribe', channelId: 'acme:run:1' }));
        await nextFrame(other, (f) => f.code === 'AUTHZ_CHANNEL_DENIED');

        const svc = handle.services.activity as unknown as ActivityService;
        await svc.publish('acme:run:1', { eventType: 'run.completed', detail: { runId: '1' } });
        await svc.publish('acme:run:2', { eventType: 'run.failed' });
        const frame = await nextFrame(a, (f) => f.type === 'activity:event');
        expect(frame.channel).toBe('acme:run:1');
        expect(frame.payload).toMatchObject({ eventType: 'run.completed', userId: null, displayName: 'System' });
        await settle();
        expect(a.frames.filter((f) => f.type === 'activity:event')).toHaveLength(1);
        expect(other.frames.some((f) => f.type === 'activity:event')).toBe(false);

        a.send(JSON.stringify({ service: 'activity', action: 'getHistory', channelId: 'acme:run:1' }));
        const hist = await nextFrame(a, (f) => f.type === 'activity' && f.action === 'history');
        expect(hist.events.map((e: any) => e.eventType)).toEqual(['run.completed']);

        // An outsider's history read is refused by the same check, and gets nothing.
        other.send(JSON.stringify({ service: 'activity', action: 'getHistory', channelId: 'acme:run:1' }));
        const denied = await nextFrame(other, (f) => f.type === 'activity' && f.action === 'history');
        expect(denied.events).toEqual([]);
        // The default (broadcast) history is gated too.
        other.send(JSON.stringify({ service: 'activity', action: 'getHistory' }));
        const broadcast = await nextFrame(other, (f) => f.type === 'activity' && f.action === 'history' && f.channelId === 'activity:broadcast');
        expect(broadcast.events).toEqual([]);
        a.close(); other.close();
        await close();
    });

    it('fails closed when the router has no checkChannel', async () => {
        const sent: any[] = [];
        const svc = new ActivityService({
            messageRouter: { sendToClient: (_c, m) => sent.push(m) },
            logger: LOGGER,
        });
        await svc.publish('acme:x', { eventType: 'e' });
        await svc.handleAction('c1', 'getHistory', { channelId: 'acme:x' });
        expect(sent.at(-1)).toMatchObject({ action: 'history', events: [] });
    });

    it('opt-ins restore client publish and broadcast auto-subscribe', async () => {
        const sent: Array<[string, any]> = [];
        const subs: string[] = [];
        const svc = new ActivityService({
            messageRouter: {
                sendToClient: (c, m) => sent.push([c, m]),
                subscribeToChannel: (_c, ch) => { subs.push(ch); return true; },
                sendToChannel: (ch, m) => { sent.push([ch, m]); },
            },
            logger: LOGGER,
            config: { allowClientPublish: true, autoSubscribeBroadcast: true },
        });
        await svc.onClientConnect('c1');
        expect(subs).toEqual(['activity:broadcast']);
        await svc.handleAction('c1', 'publish', { event: { eventType: 'e' } });
        expect(sent.find(([ch]) => ch === 'activity:broadcast')?.[1]).toMatchObject({ type: 'activity:event', channel: 'activity:broadcast' });
    });
});

describe('pipeline() — firehoses and channelFor', () => {
    it('refuses pipeline:all and pipeline:approvals by default', async () => {
        const { port, close } = await boot([pipeline()]);
        const a = await connect(port, 'acme-a');
        for (const channel of ['pipeline:all', 'pipeline:approvals']) {
            a.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel }));
            const err = await nextFrame(a, (f) => f.type === 'error' && f.channel === channel);
            expect(err.code).toBe('PIPELINE_CHANNEL_REFUSED');
        }
        await settle();
        expect(a.frames.some((f) => f.type === 'pipeline' && f.action === 'subscribed')).toBe(false);
        a.close();
        await close();
    });

    it('admits an enabled firehose', async () => {
        const { handle, port, close } = await boot([pipeline({ firehoses: { all: true } })]);
        const a = await connect(port, 'acme-a');
        a.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' }));
        await nextFrame(a, (f) => f.type === 'pipeline' && f.action === 'subscribed' && f.channel === 'pipeline:all');
        await (handle.services.pipeline as unknown as PipelineWsRouter).emitEvent('pipeline:all', 'pipeline.run.started', { runId: 'r' });
        const frame = await nextFrame(a, (f) => f.type === 'pipeline:event');
        expect(frame.channel).toBe('pipeline:all');
        a.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:approvals' }));
        await nextFrame(a, (f) => f.code === 'PIPELINE_CHANNEL_REFUSED' && f.channel === 'pipeline:approvals');
        a.close();
        await close();
    });

    it('maps the wire channel through channelFor and authorizes the mapped name', async () => {
        const asked: string[] = [];
        const channelFor = jest.fn((wire: string, ctx: any) =>
            ctx.runId && ctx.runId !== 'bad' ? `${ctx.userContext?.org}:pipelines:run:${ctx.runId}` : null);
        const { handle, port, close } = await boot([pipeline({ channelFor })], (args: any) => {
            asked.push(args.channel);
            return tenantAuthorize(args);
        });
        const a = await connect(port, 'acme-a');
        const z = await connect(port, 'other-z');
        a.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:r1' }));
        const ack = await nextFrame(a, (f) => f.type === 'pipeline' && f.action === 'subscribed');
        expect(ack.channel).toBe('pipeline:run:r1');
        expect(channelFor).toHaveBeenCalledWith('pipeline:run:r1', expect.objectContaining({ runId: 'r1', userContext: expect.objectContaining({ org: 'acme' }) }));
        expect(asked).toContain('acme:pipelines:run:r1');
        expect(asked).not.toContain('pipeline:run:r1');

        // Another tenant's mapping lands in its own partition.
        z.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:r1' }));
        await nextFrame(z, (f) => f.type === 'pipeline' && f.action === 'subscribed');

        a.send(JSON.stringify({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:bad' }));
        await nextFrame(a, (f) => f.code === 'PIPELINE_CHANNEL_REFUSED' && f.channel === 'pipeline:run:bad');

        const svc = handle.services.pipeline as unknown as PipelineWsRouter;
        await svc.emitEvent('acme:pipelines:run:r1', 'pipeline.run.completed', { runId: 'r1' });
        const frame = await nextFrame(a, (f) => f.type === 'pipeline:event');
        expect(frame.channel).toBe('acme:pipelines:run:r1');
        await settle();
        expect(z.frames.some((f) => f.type === 'pipeline:event')).toBe(false);

        a.send(JSON.stringify({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:run:r1' }));
        await nextFrame(a, (f) => f.type === 'pipeline' && f.action === 'unsubscribed');
        await svc.emitEvent('acme:pipelines:run:r1', 'pipeline.run.completed', { runId: 'r1' });
        await settle();
        expect(a.frames.filter((f) => f.type === 'pipeline:event')).toHaveLength(1);
        a.close(); z.close();
        await close();
    });

    it('unsubscribes the recorded router channel and refuses a throwing mapper', async () => {
        const unsubs: string[] = [];
        const sent: any[] = [];
        let calls = 0;
        const svc = new PipelineWsRouter({
            messageRouter: {
                sendToClient: (_c, m) => sent.push(m),
                sendToChannel: () => undefined,
                subscribeToChannel: () => true,
                unsubscribeFromChannel: (_c, ch) => { unsubs.push(ch); },
            },
            logger: LOGGER,
            config: { channelFor: (_w, ctx) => { calls++; if (ctx.runId === 'boom') throw new Error('x'); return `t:${ctx.runId}`; } },
        });
        await svc.handleAction('c1', 'subscribe', { channel: 'pipeline:run:a' });
        await svc.handleAction('c1', 'unsubscribe', { channel: 'pipeline:run:a' });
        await svc.handleAction('c1', 'unsubscribe', { channel: 'pipeline:run:never' });
        expect(unsubs).toEqual(['t:a']);
        expect(calls).toBe(1);
        await svc.handleAction('c1', 'subscribe', { channel: 'pipeline:run:boom' });
        expect(sent.at(-1)).toMatchObject({ code: 'PIPELINE_CHANNEL_REFUSED' });
        await svc.handleAction('c1', 'subscribe', { channel: 'pipeline:run:b' });
        await svc.handleDisconnect('c1');
        expect(unsubs).toEqual(['t:a', 't:b']);
    });
});
