// 0.146.0 — the socket layer fails closed by default (package 8):
//   - a connection whose token carries `exp` is closed when it passes;
//   - the inbound frame budget is on unless switched off;
//   - the default maxPayload is 1 MiB;
//   - a connection's inbound queue is capped;
//   - attachRealtime caps the channels one socket may hold.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createWsHandler, DEFAULT_WS_MAX_PAYLOAD } from '../../src/server-ws';
import type { WsHandlerHandle, WsHandlerOptions, WsService } from '../../src/server-ws/types';
import { attachRealtime, chat } from '../../src/server';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function eventually(predicate: () => boolean, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (predicate()) return; await delay(10); }
    throw new Error('condition did not become true');
}

async function rig(opts: Partial<WsHandlerOptions>, service: WsService = { handleAction: () => undefined }) {
    const server = http.createServer();
    const handle: WsHandlerHandle = createWsHandler({ server, services: { echo: service }, pingIntervalMs: 0, ...opts });
    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as AddressInfo).port;
    const sockets: WebSocket[] = [];
    const connect = (query = '') => new Promise<{ ws: WebSocket; frames: any[]; closed: Promise<{ code: number; at: number }> }>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
        sockets.push(ws);
        const frames: any[] = [];
        const closed = new Promise<{ code: number; at: number }>(r => ws.on('close', code => r({ code, at: Date.now() })));
        ws.on('message', raw => { const f = JSON.parse(raw.toString()); frames.push(f); if (f.type === 'session') res({ ws, frames, closed }); });
        ws.on('error', rej);
    });
    const stop = async () => {
        for (const ws of sockets) ws.close();
        await handle.dispose();
        await new Promise<void>(res => server.close(() => res()));
    };
    return { handle, connect, stop };
}

/** A host auth that hands back JWT-style claims: `exp` in seconds. */
const authWithExp = (expSeconds: number) => () => ({ userId: 'u1', exp: expSeconds });

describe('token expiry', () => {
    it('closes a connection whose 1 second token expires, within the grace period', async () => {
        const graceMs = 500;
        const exp = Math.floor(Date.now() / 1000) + 1;
        const r = await rig({ auth: authWithExp(exp), tokenExpiryGraceMs: graceMs });
        try {
            const c = await r.connect();
            const { code, at } = await c.closed;
            expect(code).toBe(4001);
            expect(at).toBeGreaterThanOrEqual(exp * 1000);
            expect(at).toBeLessThanOrEqual(exp * 1000 + graceMs + 250);
            expect(c.frames.some(f => f.type === 'error' && f.code === 'TOKEN_EXPIRED')).toBe(true);
        } finally { await r.stop(); }
    });

    it('closes within the default grace period too', async () => {
        const exp = Math.floor(Date.now() / 1000) + 1;
        const r = await rig({ auth: authWithExp(exp) });
        try {
            const c = await r.connect();
            const { code, at } = await c.closed;
            expect(code).toBe(4001);
            expect(at).toBeLessThanOrEqual(exp * 1000 + 1000 + 250);
        } finally { await r.stop(); }
    });

    it('refuses the upgrade when the token has already expired', async () => {
        const r = await rig({ auth: authWithExp(Math.floor(Date.now() / 1000) - 120) });
        try {
            await expect(r.connect()).rejects.toThrow(/401/);
        } finally { await r.stop(); }
    });

    it('leaves a connection without exp alone', async () => {
        const r = await rig({ auth: () => ({ userId: 'u1' }) });
        try {
            const c = await r.connect();
            await delay(300);
            expect(c.ws.readyState).toBe(WebSocket.OPEN);
        } finally { await r.stop(); }
    });
});

describe('inbound limits on by default', () => {
    it('rate limits without being asked to', async () => {
        const r = await rig({});
        try {
            const c = await r.connect();
            for (let n = 0; n < 400; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n }));
            await eventually(() => c.frames.some(f => f.code === 'RATE_LIMITED'));
            expect(r.handle.stats!().inbound.dropped).toBeGreaterThan(0);
        } finally { await r.stop(); }
    });

    it('inboundRateLimit: false still switches it off', async () => {
        const r = await rig({ inboundRateLimit: false });
        try {
            const c = await r.connect();
            // 200: past the default bucket (burst 100), inside the default queue cap (256).
            for (let n = 0; n < 200; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n }));
            await eventually(() => r.handle.stats!().inbound.accepted === 200);
            expect(c.frames.some(f => f.code === 'RATE_LIMITED')).toBe(false);
        } finally { await r.stop(); }
    });

    it('defaults maxPayload to 1 MiB', async () => {
        expect(DEFAULT_WS_MAX_PAYLOAD).toBe(1024 * 1024);
        const r = await rig({});
        try {
            expect(r.handle.wss.options.maxPayload).toBe(1024 * 1024);
            const c = await r.connect();
            c.ws.send('x'.repeat(1024 * 1024 + 16));
            expect((await c.closed).code).toBe(1009);
        } finally { await r.stop(); }
    });

    it('closes a connection whose inbound queue passes maxQueueDepth', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const r = await rig({ inboundRateLimit: false, maxQueueDepth: 5 }, { handleAction: () => gate });
        try {
            const c = await r.connect();
            for (let n = 0; n < 20; n++) c.ws.send(JSON.stringify({ service: 'echo', action: 'x', n }));
            const { code } = await c.closed;
            expect(code).toBe(1008);
            expect(c.frames.some(f => f.code === 'QUEUE_FULL')).toBe(true);
        } finally { release(); await r.stop(); }
    });
});

describe('channels per socket', () => {
    it('refuses a subscribe past maxChannelsPerSocket', async () => {
        const server = http.createServer();
        const handle = attachRealtime(server, { features: [chat()], path: '/realtime', pingIntervalMs: 0, maxChannelsPerSocket: 3 });
        await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
        const port = (server.address() as AddressInfo).port;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
        const frames: any[] = [];
        ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
        try {
            await eventually(() => frames.some(f => f.type === 'session'));
            for (let n = 0; n < 5; n++) ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: `room-${n}` }));
            await eventually(() => frames.filter(f => f.type === 'chat' && f.action === 'joined').length === 3
                && frames.filter(f => f.code === 'CHANNEL_LIMIT').length === 2);
        } finally {
            ws.close();
            await handle.dispose();
            await new Promise<void>(res => server.close(() => res()));
        }
    });
});
