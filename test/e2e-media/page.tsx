// The browser half of the G21 live-media rehearsal (see breakout-media.live.test.ts).
// One participant: useMeeting over the real gateway socket, useFollowMeetingLobby
// moving the call, useLVSHangout publishing over WHIP to a real SFU. Stage tokens
// come from the rehearsal server, which refuses breakout lobbies the user does not
// belong in. Everything the spec asserts on is mirrored onto `window.__g21`.
//
// Bundled by esbuild at test time; not part of the library build.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFollowMeetingLobby, useMeeting } from '../../src/client/meeting';
import { useLVSHangout } from '../../src/client/video/useLVSHangout';
import type { GatewayMessage } from '../../src/client/types';

interface Config { user: string; token: string; meetingId: string; sfu: string; }
interface Call { lobby: string; token: string; participantId: string; channelArn: string; sfu: string; }
interface MintResult { status: number; body: any }

const q = new URLSearchParams(location.search);
const cfg: Config = {
    user: q.get('user') ?? '',
    token: q.get('token') ?? '',
    meetingId: q.get('meeting') ?? '',
    sfu: q.get('sfu') ?? '',
};

const view: Record<string, unknown> = { user: cfg.user, log: [] as string[] };
(window as any).__g21 = view;
const note = (line: string) => { (view.log as string[]).push(`${new Date().toISOString()} ${line}`); };

async function mint(lobby: string): Promise<MintResult> {
    const res = await fetch('/api/stage-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ lobby }),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* empty */ }
    note(`mint ${lobby} -> ${res.status}`);
    return { status: res.status, body };
}
view.mint = mint;

function openSocket(): Promise<{ send: (m: Record<string, unknown>) => void; onMessage: (h: (m: GatewayMessage) => void) => () => void }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/realtime?token=${encodeURIComponent(cfg.token)}`);
        const handlers = new Set<(m: GatewayMessage) => void>();
        ws.addEventListener('message', (ev) => {
            let m: GatewayMessage;
            try { m = JSON.parse(String(ev.data)); } catch { return; }
            for (const h of handlers) h(m);
        });
        ws.addEventListener('open', () => resolve({
            send: (m) => ws.send(JSON.stringify(m)),
            onMessage: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        }));
        ws.addEventListener('error', () => reject(new Error('gateway socket failed')));
    });
}

function RemoteVideo({ pid, stream }: { pid: string; stream: MediaStream }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
    return <video ref={ref} data-pid={pid} autoPlay muted playsInline width={160} height={120} />;
}

function CallView({ call, leaveRef }: { call: Call; leaveRef: { current: () => void } }) {
    const h = useLVSHangout({
        stageToken: call.token,
        participantId: call.participantId,
        userId: cfg.user,
        baseUrl: call.sfu,
        media: { video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } }, audio: true },
    });
    leaveRef.current = h.leave;
    const remotes = h.participants.filter((p) => !p.isLocal);
    view.call = { lobby: call.lobby, channelArn: call.channelArn, participantId: call.participantId, sfu: call.sfu };
    view.isJoined = h.isJoined;
    view.connectionState = h.connectionState;
    view.hangoutError = h.error;
    view.remotes = remotes.map((p) => ({ participantId: p.participantId, appUserId: p.appUserId ?? null, streams: p.streams.length }));
    return (
        <div data-lobby={call.lobby}>
            {remotes.flatMap((p) => p.streams.map((s) => <RemoteVideo key={`${p.participantId}:${s.id}`} pid={p.participantId} stream={s} />))}
        </div>
    );
}

function App({ socket }: { socket: Awaited<ReturnType<typeof openSocket>> }) {
    const meeting = useMeeting(cfg.meetingId, { socket, displayName: cfg.user });
    const [call, setCall] = useState<Call | null>(null);
    const leaveRef = useRef<() => void>(() => {});
    const startedRef = useRef(false);

    const join = useCallback(async (lobby: string) => {
        const r = await mint(lobby);
        if (r.status !== 200) throw new Error(`stage token for ${lobby} refused: ${r.status}`);
        // The host says which SFU node serves this lobby; the page follows it.
        setCall({ lobby, token: r.body.token, participantId: r.body.participantId, channelArn: r.body.channelArn, sfu: r.body.sfu ?? cfg.sfu });
    }, []);
    const leave = useCallback(() => {
        leaveRef.current();
        leaveRef.current = () => {};
        setCall(null);
    }, []);

    // Joining the meeting's media in the first place is the app's choice.
    useEffect(() => {
        if (!meeting.ready || startedRef.current) return;
        startedRef.current = true;
        join(cfg.meetingId).catch((e) => { view.joinError = String(e); });
    }, [meeting.ready, join]);

    const follow = useFollowMeetingLobby(meeting.activeLobby, { currentLobby: call?.lobby ?? null, leave, join });

    view.ready = meeting.ready;
    view.isOrganizer = meeting.isOrganizer;
    view.activeLobby = meeting.activeLobby;
    view.phase = meeting.breakout.phase;
    view.moving = follow.moving;
    view.followError = follow.error ? String(follow.error) : null;
    if (!call) { view.call = null; view.isJoined = false; view.remotes = []; }

    return call ? <CallView key={call.participantId} call={call} leaveRef={leaveRef} /> : null;
}

openSocket().then(
    (socket) => createRoot(document.getElementById('root')!).render(<App socket={socket} />),
    (e) => { view.bootError = String(e); },
);
