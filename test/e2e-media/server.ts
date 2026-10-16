// The Node half of the G21 live-media rehearsal: the real gateway
// (`attachRealtime` + `meeting()`) on an http server that also serves the test
// page and mints LVS stage tokens. Minting is where "may this user join lobby
// X" is decided: a breakout lobby is only minted when
// MeetingService.admitsBreakoutLobby says yes, so a forged join never gets a
// token the SFU would accept. The SFU mints the token itself
// (POST /api/sessions find-or-create by lobbyName, then /:arn/join).

import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import { attachRealtime, type RealtimeHandle } from '../../src/server';
import { meeting, parseBreakoutLobby, type MeetingService } from '../../src/meeting';

export interface MediaServerOptions {
    /** SFU base URL, e.g. http://127.0.0.1:3913. */
    sfuUrl: string;
    /** Fixture bearer token → userId. */
    users: Record<string, string>;
    /** esbuild module (resolved by the caller; not a dependency of this repo). */
    esbuild: { build(opts: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }> };
}

export interface MediaServer {
    url: string;
    handle: RealtimeHandle;
    meetings: MeetingService;
    /** Every mint decision, in order. */
    mints: Array<{ userId: string | null; lobby: string; status: number }>;
    close(): Promise<void>;
}

async function sfu(base: string, route: string, body: unknown): Promise<any> {
    const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`SFU ${route} -> ${res.status} ${await res.text()}`);
    return res.json();
}

/** The SFU channel for a lobby, created on first use (same call the mint makes). */
export async function lobbyArn(sfuUrl: string, lobby: string): Promise<string> {
    const s = await sfu(sfuUrl, '/api/sessions', { creatorId: 'g21-rehearsal', lobbyName: lobby, findOrCreate: true });
    return s.channelArn as string;
}

export async function startMediaServer(opts: MediaServerOptions): Promise<MediaServer> {
    const bundle = await opts.esbuild.build({
        entryPoints: [path.join(__dirname, 'page.tsx')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'chrome120',
        jsx: 'automatic',
        sourcemap: 'inline',
        define: { 'process.env.NODE_ENV': '"development"' },
        logLevel: 'silent',
    });
    const js = bundle.outputFiles[0].text;
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>G21</title></head>'
        + '<body><div id="root"></div><script src="/page.js"></script></body></html>';

    const mints: MediaServer['mints'] = [];
    let meetings: MeetingService | null = null;
    const userOf = (req: http.IncomingMessage): string | null => {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        return bearer ? opts.users[bearer] ?? null : null;
    };

    const server = http.createServer((req, res) => {
        const send = (status: number, type: string, body: string) => {
            res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
            res.end(body);
        };
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html', html);
        if (req.method === 'GET' && url.pathname === '/page.js') return send(200, 'text/javascript', js);
        if (req.method === 'POST' && url.pathname === '/api/stage-token') {
            let raw = '';
            req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
            req.on('end', () => {
                void (async () => {
                    const userId = userOf(req);
                    let lobby = '';
                    try { lobby = String(JSON.parse(raw || '{}').lobby ?? ''); } catch { /* empty */ }
                    const decide = (status: number, body: unknown) => {
                        mints.push({ userId, lobby, status });
                        send(status, 'application/json', JSON.stringify(body));
                    };
                    if (!userId) return decide(401, { error: 'unauthenticated' });
                    if (!lobby) return decide(400, { error: 'lobby is required' });
                    // A breakout lobby: only its members (and organizers) get a token.
                    // The main lobby: every fixture user is invited to the meeting.
                    if (parseBreakoutLobby(lobby)) {
                        const ok = await meetings!.admitsBreakoutLobby(userId, lobby);
                        if (ok !== true) return decide(403, { error: 'not in this room' });
                    }
                    try {
                        const session = await sfu(opts.sfuUrl, '/api/sessions', { creatorId: userId, lobbyName: lobby, findOrCreate: true });
                        const joined = await sfu(opts.sfuUrl, `/api/sessions/${encodeURIComponent(session.channelArn)}/join`,
                            { userId, displayName: userId, role: 'publisher' });
                        decide(200, { token: joined.token, participantId: joined.participantId, channelArn: session.channelArn });
                    } catch (e) {
                        decide(502, { error: String(e) });
                    }
                })();
            });
            return undefined;
        }
        return send(404, 'text/plain', 'not found');
    });

    const handle = attachRealtime(server, {
        features: [meeting()],
        path: '/realtime',
        auth: (req: http.IncomingMessage) => {
            const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
            const userId = opts.users[token];
            if (!userId) throw new Error('unknown fixture token');
            return { userId, displayName: userId };
        },
    } as any);
    meetings = (handle.services as Record<string, unknown>).meeting as MeetingService;

    const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
    return {
        url: `http://127.0.0.1:${port}`,
        handle,
        meetings,
        mints,
        close: async () => {
            await handle.dispose();
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}
