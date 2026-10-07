// A page huddle (a lobby call nobody is rung for) is a registered call whose
// seats are the people who joined the lobby: `join` seats the sender
// atomically, `ended` (targeted at yourself) releases it, and `lobbyGuard`
// decides admission as for every other verb. A call-scoped consumer (huddle
// chat) can therefore admit exactly the seated participants.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, calls, type RealtimeHandle } from '../../src/server';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';
import { makeCluster, flush } from './helpers/cluster';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOBBY = 'assessment:team:T-1';

describe('lobby join across two nodes (Redis double)', () => {
  it('seats every joiner once, atomically, whichever node they are on', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    c.connect('a-ana', 'u-ana', 'A'); c.connect('b-bea', 'u-bea', 'B');
    c.connect('b-bea-2', 'u-bea', 'B'); c.connect('a-cy', 'u-cy', 'A');
    const store = new RedisCallStateStore(c.redis as any);
    await c.A.svc.handleCallEvent('a-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    expect(await store.getCall('h1')).toMatchObject({ callerId: 'u-ana', lobbyName: LOBBY, participantClientIds: ['a-ana'] });
    // The other node discovers it and accepts into the same call.
    await c.B.svc.handleCallEvent('b-bea', 'accepted', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea', userId: 'u-bea', targetUserIds: ['u-ana'] });
    // A second tab of the same person, joining at the same moment on both paths, gets no second seat.
    await Promise.all([
      c.B.svc.handleCallEvent('b-bea-2', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea' }),
      c.A.svc.handleCallEvent('a-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' }),
    ]);
    await flush();
    expect((await store.getCall('h1'))!.participantClientIds.sort()).toEqual(['a-ana', 'b-bea']);
    expect(c.frames('b-bea-2', 'ended')[0]).toMatchObject({ data: { reason: 'answered-elsewhere' } });
    // Someone who has not joined is not seated, and discovers the call.
    await c.A.svc.handleCallEvent('a-cy', 'status', { lobbyName: LOBBY });
    await flush();
    expect(c.frames('a-cy', 'active-call')[0].data).toMatchObject({ active: true, callId: 'h1', participantCount: 2 });
    expect((await store.getCall('h1'))!.participantClientIds).not.toContain('a-cy');
    // Leaving releases the seat, on either node's view.
    await c.B.svc.handleCallEvent('b-bea', 'ended', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea', targetUserIds: ['u-bea'] });
    await flush();
    expect((await store.getCall('h1'))!.participantClientIds).toEqual(['a-ana']);
    await c.dispose();
  });
});

const storeCases: Array<{ name: string; make: () => CallStateStore | undefined }> = [
  { name: 'no store', make: () => undefined },
  { name: 'InMemoryCallStateStore', make: () => new InMemoryCallStateStore() },
  { name: 'RedisCallStateStore (Redis double)', make: () => new RedisCallStateStore(new FakeRedis() as any) },
];

describe.each(storeCases)('lobby join over sockets ($name)', (sc) => {
  let server: http.Server; let handle: RealtimeHandle; let port: number;
  const store = sc.make();
  const open: WebSocket[] = [];
  beforeAll(async () => {
    server = http.createServer();
    handle = attachRealtime(server, {
      features: [calls({
        stateStore: store, rejoinGraceMs: 200,
        // Only the team's people may enter its lobby; `org` is the tenant.
        lobbyGuard: (auth: any, lobby: string) => lobby.startsWith(`${String(auth.org)}:`),
      })],
      path: '/realtime',
      auth: async (req: http.IncomingMessage) => {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        return { userId: q.get('sub') ?? '', org: q.get('org') ?? 'assessment' };
      },
    } as any);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const ws of open) try { ws.terminate(); } catch { /* */ }
    await handle.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  });
  type Conn = { ws: WebSocket; frames: any[]; sub: string };
  const connect = (sub: string, org = 'assessment') => new Promise<Conn>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?sub=${sub}&org=${org}`);
    const conn: Conn = { ws, frames: [], sub };
    ws.on('message', (raw) => { try { conn.frames.push(JSON.parse(String(raw))); } catch { /* */ } });
    ws.on('open', () => { open.push(ws); resolve(conn); });
    ws.on('error', reject);
  });
  const send = (c: Conn, frame: Record<string, unknown>) => c.ws.send(JSON.stringify({ service: 'call', ...frame }));
  const seats = async (callId: string) => {
    if (!store) return null;
    return (await store.getCall(callId))?.participantClientIds.length ?? 0;
  };
  const status = async (lobby: string, org = 'assessment') => {
    const c = await connect(`u-watch-${Math.random().toString(36).slice(2, 6)}`, org);
    send(c, { action: 'status', lobbyName: lobby });
    for (let i = 0; i < 100; i++) {
      const f = c.frames.find((x) => x.action === 'active-call' && x.data?.lobbyName === lobby);
      if (f) { c.ws.close(); return f.data; }
      await sleep(10);
    }
    c.ws.close();
    return null;
  };

  it('a joiner is seated, a non-joined member and an outsider are not, leaving releases', async () => {
    const lobby = `${LOBBY}-${Math.random().toString(36).slice(2, 6)}`;
    const callId = `h-${Math.random().toString(36).slice(2, 8)}`;
    const ana = await connect('u-ana'); const bea = await connect('u-bea'); const out = await connect('u-oz', 'orgiq');
    send(ana, { action: 'join', callId, lobbyName: lobby, callerId: 'u-ana' });
    await sleep(80);
    expect(await status(lobby)).toMatchObject({ active: true, callId, participantUserIds: ['u-ana'] });
    // Same-team member who never joined: no seat. An outsider's join is refused by the guard.
    send(out, { action: 'join', callId, lobbyName: lobby, callerId: 'u-oz' });
    await sleep(80);
    expect(out.frames.some((f) => f.type === 'error' || f.action === 'error')).toBe(true);
    expect(await status(lobby)).toMatchObject({ participantUserIds: ['u-ana'] });
    if (store) expect(await seats(callId)).toBe(1);
    // The member joins: now two seats.
    send(bea, { action: 'join', callId, lobbyName: lobby, callerId: 'u-bea' });
    await sleep(80);
    expect((await status(lobby)).participantUserIds.sort()).toEqual(['u-ana', 'u-bea']);
    // Leave: the ordinary terminal verb aimed at yourself.
    send(bea, { action: 'ended', callId, lobbyName: lobby, callerId: 'u-bea', targetUserIds: ['u-bea'] });
    await sleep(80);
    expect((await status(lobby)).participantUserIds).toEqual(['u-ana']);
    send(ana, { action: 'ended', callId, lobbyName: lobby, callerId: 'u-ana', targetUserIds: ['u-ana'] });
    await sleep(80);
    expect((await status(lobby)).active).toBe(false);
  });
});

describe('page huddle seats: three people, one leaves (Redis double, two nodes)', () => {
  it('a late joiner adopts the live call; one leaver releases only its seat; the last out ends it; a re-join takes a fresh seat', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    c.connect('a-ana', 'u-ana', 'A'); c.connect('b-bea', 'u-bea', 'B'); c.connect('a-cy', 'u-cy', 'A');
    const store = new RedisCallStateStore(c.redis as any);
    await c.A.svc.handleCallEvent('a-ana', 'join', { callId: 'h-ana', lobbyName: LOBBY, callerId: 'u-ana', callerName: 'Ana' });
    // Bea's status query predated Ana's join, so she mints her own id: she is seated in Ana's call, told so, and Ana hears her.
    await c.B.svc.handleCallEvent('b-bea', 'join', { callId: 'h-bea', lobbyName: LOBBY, callerId: 'u-bea', callerName: 'Bea' });
    await flush();
    expect(await store.getCall('h-bea')).toBeNull();
    expect((await store.getCall('h-ana'))!.participantClientIds.sort()).toEqual(['a-ana', 'b-bea']);
    expect(c.frames('b-bea', 'active-call')[0].data).toMatchObject({ active: true, callId: 'h-ana', pageHuddle: true });
    expect(c.frames('a-ana', 'user-status')[0].data).toMatchObject({ callId: 'h-ana', userId: 'u-bea', status: 'in-call' });
    await c.A.svc.handleCallEvent('a-cy', 'join', { callId: 'h-cy', lobbyName: LOBBY, callerId: 'u-cy', callerName: 'Cy' });
    await flush();
    expect((await store.getCall('h-ana'))!.participantClientIds.sort()).toEqual(['a-ana', 'a-cy', 'b-bea']);
    // Bea leaves (the ordinary `ended`, aimed at herself): two seats remain and nobody is told the call ended.
    await c.B.svc.handleCallEvent('b-bea', 'ended', { callId: 'h-ana', lobbyName: LOBBY, callerId: 'u-bea', targetUserIds: ['u-bea'] });
    await flush();
    expect((await store.getCall('h-ana'))!.participantClientIds.sort()).toEqual(['a-ana', 'a-cy']);
    expect(c.frames('a-ana', 'ended')).toHaveLength(0);
    expect(c.frames('a-cy', 'ended')).toHaveLength(0);
    // A re-join after leaving takes a fresh seat in the same live call.
    await c.B.svc.handleCallEvent('b-bea', 'join', { callId: 'h-bea-2', lobbyName: LOBBY, callerId: 'u-bea' });
    await flush();
    expect((await store.getCall('h-ana'))!.participantClientIds.sort()).toEqual(['a-ana', 'a-cy', 'b-bea']);
    // Everyone out: the last release ends the call.
    for (const [cid, node, uid] of [['b-bea', c.B, 'u-bea'], ['a-cy', c.A, 'u-cy'], ['a-ana', c.A, 'u-ana']] as const) {
      await node.svc.handleCallEvent(cid, 'ended', { callId: 'h-ana', lobbyName: LOBBY, callerId: uid, targetUserIds: [uid] });
      await flush();
    }
    expect(await store.getCall('h-ana')).toBeNull();
    // After it ended, a join starts a new huddle rather than adopting the dead one.
    await c.A.svc.handleCallEvent('a-ana', 'join', { callId: 'h-new', lobbyName: LOBBY, callerId: 'u-ana' });
    await flush();
    expect(await store.getCall('h-new')).toMatchObject({ participantClientIds: ['a-ana'] });
    await c.dispose();
  });
});
