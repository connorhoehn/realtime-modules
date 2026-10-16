// meeting() through attachRealtime over real sockets: alone, beside calls(),
// and with an authorize hook that refuses the meeting channel.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeFeature, type RealtimeHandle } from '../../src/server';
import { meeting } from '../../src/meeting';

const M = 'room:lounge';

async function boot(features: RealtimeFeature[], extra: Record<string, unknown> = {}) {
    const server = http.createServer((_q, s) => { s.end('ok'); });
    const handle: RealtimeHandle = attachRealtime(server, {
        features,
        path: '/realtime',
        auth: (req: http.IncomingMessage) => {
            const u = new URL(req.url ?? '/', 'http://x').searchParams.get('u');
            return { userId: u ?? undefined, displayName: u ? u.toUpperCase() : undefined };
        },
        ...extra,
    } as any);
    const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
    return { server, handle, port };
}

function connect(port: number, user: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?u=${user}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function next(ws: WebSocket, match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        const on = (raw: WebSocket.RawData) => {
            let f: any;
            try { f = JSON.parse(String(raw)); } catch { return; }
            if (match(f)) { clearTimeout(t); ws.off('message', on); resolve(f); }
        };
        ws.on('message', on);
    });
}

async function teardown(server: http.Server, handle: RealtimeHandle, sockets: WebSocket[]) {
    for (const s of sockets) s.close();
    await handle.dispose();
    await new Promise<void>((r) => server.close(() => r()));
}

describe('meeting() attached', () => {
    it('boots beside calls() and fans hands and breakouts out to every subscriber', async () => {
        const { server, handle, port } = await boot([calls(), meeting()]);
        expect(Object.keys(handle.services)).toEqual(expect.arrayContaining(['call', 'meeting']));
        const org = await connect(port, 'olive');
        const ana = await connect(port, 'ana');
        const snapOrg = next(org, (f) => f.action === 'meeting.snapshot');
        org.send(JSON.stringify({ service: 'meeting', action: 'subscribe', meetingId: M }));
        expect((await snapOrg).data.you).toEqual({ userId: 'olive', organizer: true });
        const snapAna = next(ana, (f) => f.action === 'meeting.snapshot');
        ana.send(JSON.stringify({ service: 'meeting', action: 'subscribe', meetingId: M }));
        expect((await snapAna).data.you.organizer).toBe(false);

        const hands = next(org, (f) => f.action === 'hands.changed');
        ana.send(JSON.stringify({ service: 'meeting', action: 'hand.raise', meetingId: M }));
        expect((await hands).data.hands).toEqual([expect.objectContaining({ userId: 'ana', displayName: 'ANA' })]);

        const rooms = next(ana, (f) => f.action === 'breakout.changed' && f.data.breakout.phase === 'open');
        org.send(JSON.stringify({ service: 'meeting', action: 'breakout.configure', meetingId: M, mode: 'self-select', rooms: [{ id: 'r1', name: 'Room 1' }] }));
        org.send(JSON.stringify({ service: 'meeting', action: 'breakout.open', meetingId: M }));
        expect((await rooms).data.breakout.rooms[0]).toMatchObject({ id: 'r1', state: 'open' });

        const forbidden = next(ana, (f) => f.action === 'error');
        ana.send(JSON.stringify({ service: 'meeting', action: 'breakout.end', meetingId: M }));
        expect((await forbidden).error.code).toBe('FORBIDDEN');
        await teardown(server, handle, [org, ana]);
    });

    it('the authorize hook decides who may subscribe to meeting:<id>', async () => {
        const { server, handle, port } = await boot([meeting()], {
            authorize: (a: any) => !(a.channel === `meeting:${M}` && a.ctx?.userId === 'mallory'),
        });
        const mal = await connect(port, 'mallory');
        const refused = next(mal, (f) => f.action === 'error' || f.code === 'AUTHZ_CHANNEL_DENIED' || f.type === 'error');
        mal.send(JSON.stringify({ service: 'meeting', action: 'subscribe', meetingId: M }));
        const frame = await refused;
        expect(JSON.stringify(frame)).toMatch(/FORBIDDEN|DENIED/);
        await teardown(server, handle, [mal]);
    });
});
