// 0.119 (lane R6) — the per-connection inbound frame budget and the handler's
// stats(): queue depth, drop counters, event-loop delay.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createWsHandler } from '../../src/server-ws';
import type { WsHandlerHandle, WsHandlerOptions, WsService } from '../../src/server-ws/types';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function eventually(predicate: () => boolean, ms = 2000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (predicate()) return; await delay(10); }
    throw new Error('condition did not become true');
}

async function rig(opts: Partial<WsHandlerOptions>, service: WsService) {
    const server = http.createServer();
    const handle: WsHandlerHandle = createWsHandler({ server, services: { echo: service }, pingIntervalMs: 0, ...opts });
    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as AddressInfo).port;
    const sockets: WebSocket[] = [];
    const connect = () => new Promise<{ ws: WebSocket; frames: any[] }>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(ws);
        const frames: any[] = [];
        ws.on('message', raw => { const f = JSON.parse(raw.toString()); frames.push(f); if (f.type === 'session') res({ ws, frames }); });
        ws.on('error', rej);
    });
    const stop = async () => {
        for (const ws of sockets) ws.close();
        await handle.dispose();
        await new Promise<void>(res => server.close(() => res()));
    };
    return { handle, connect, stop };
}

describe('createWsHandler({ inboundRateLimit })', () => {
    it('drops frames past the bucket, sends ONE RATE_LIMITED frame per window and keeps the socket open', async () => {
        const handled: number[] = [];
        const limited: number[] = [];
        const r = await rig({ inboundRateLimit: { framesPerSecond: 10, burst: 5, windowMs: 400, onLimited: (_id, i) => limited.push(i.droppedTotal) } },
            { handleAction: (_c, _a, d) => { handled.push(d.n as number); } });
        try {
            const c = await r.connect();
            for (let n = 0; n < 30; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n }));
            await eventually(() => r.handle.stats!().inbound.dropped >= 20);
            await delay(50);
            const notices = c.frames.filter(f => f.code === 'RATE_LIMITED');
            expect(notices).toHaveLength(1);
            expect(notices[0]).toMatchObject({ type: 'error', code: 'RATE_LIMITED', windowMs: 400 });
            expect(handled.length).toBeGreaterThanOrEqual(5);
            expect(handled.length).toBeLessThan(10);
            expect(handled).toEqual([...handled].sort((x, y) => x - y)); // the admitted ones stay in order
            const s = r.handle.stats!();
            expect(s.inbound.accepted + s.inbound.dropped).toBe(30);
            expect(s.inbound.limitNotices).toBe(1);
            expect(s.inbound.limitedConnections).toBe(1);
            expect(limited.length).toBe(s.inbound.dropped);
            expect(c.ws.readyState).toBe(WebSocket.OPEN);

            // After the window, the bucket has refilled: frames flow again, and
            // a new burst past the budget earns exactly one more notice.
            await delay(600);
            const before = handled.length;
            c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n: 100 }));
            await eventually(() => handled.length === before + 1);
            for (let n = 0; n < 30; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n: 200 + n }));
            await eventually(() => c.frames.filter(f => f.code === 'RATE_LIMITED').length === 2);
            await delay(50);
            expect(c.frames.filter(f => f.code === 'RATE_LIMITED')).toHaveLength(2);
        } finally { await r.stop(); }
    });

    it('budgets each connection separately', async () => {
        const handled: string[] = [];
        const r = await rig({ inboundRateLimit: { framesPerSecond: 5, burst: 3 } },
            { handleAction: (_c, _a, d) => { handled.push(d.who as string); } });
        try {
            const [a, b] = [await r.connect(), await r.connect()];
            for (let n = 0; n < 20; n++) a.ws.send(JSON.stringify({ service: 'echo', action: 'x', who: 'a' }));
            for (let n = 0; n < 3; n++) b.ws.send(JSON.stringify({ service: 'echo', action: 'x', who: 'b' }));
            await eventually(() => handled.filter(w => w === 'b').length === 3);
            expect(b.frames.some(f => f.code === 'RATE_LIMITED')).toBe(false);
            expect(a.frames.some(f => f.code === 'RATE_LIMITED')).toBe(true);
        } finally { await r.stop(); }
    });

    it('true takes the defaults (50/s, burst 100); unset never drops', async () => {
        for (const option of [true, undefined]) {
            let handled = 0;
            const r = await rig({ inboundRateLimit: option }, { handleAction: () => { handled++; } });
            try {
                const c = await r.connect();
                for (let n = 0; n < 150; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x' }));
                await eventually(() => r.handle.stats!().inbound.accepted + r.handle.stats!().inbound.dropped === 150);
                await eventually(() => r.handle.stats!().queueDepth === 0);
                if (option) {
                    expect(handled).toBeGreaterThanOrEqual(100);
                    expect(handled).toBeLessThan(150);
                } else {
                    expect(handled).toBe(150);
                    expect(c.frames.some(f => f.code === 'RATE_LIMITED')).toBe(false);
                }
            } finally { await r.stop(); }
        }
    });

    it('rejects invalid budgets', () => {
        const server = http.createServer();
        const services = {};
        expect(() => createWsHandler({ server, services, inboundRateLimit: { framesPerSecond: 0 } })).toThrow(/framesPerSecond/);
        expect(() => createWsHandler({ server, services, inboundRateLimit: { framesPerSecond: 10, burst: 0 } })).toThrow(/burst/);
        expect(() => createWsHandler({ server, services, inboundRateLimit: { windowMs: -1 } })).toThrow(/windowMs/);
    });
});

describe('createWsHandler stats()', () => {
    it('reports the frames accepted but not finished as queueDepth, per connection and in total', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const r = await rig({}, { handleAction: async () => { await gate; } });
        try {
            const [a, b] = [await r.connect(), await r.connect()];
            for (let n = 0; n < 4; n++) a.ws.send(JSON.stringify({ service: 'echo', action: 'x' }));
            b.ws.send(JSON.stringify({ service: 'echo', action: 'x' }));
            await eventually(() => r.handle.stats!().queueDepth === 5);
            const s = r.handle.stats!();
            expect(s).toMatchObject({ connections: 2, queueDepth: 5, maxConnectionQueueDepth: 4, peakQueueDepth: 5 });
            expect(s.eventLoop === null || typeof s.eventLoop.p99Ms === 'number').toBe(true);
            release();
            await eventually(() => r.handle.stats!().queueDepth === 0);
            expect(r.handle.stats!({ reset: true }).peakQueueDepth).toBe(5);
            expect(r.handle.stats!().peakQueueDepth).toBe(0);
        } finally { await r.stop(); }
    });
});
