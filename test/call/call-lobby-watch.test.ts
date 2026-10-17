// 0.136.0 (lane L9): lobby occupancy for people who are NOT in the call.
//
// `watch { lobbyName }` runs the host's channel authority on
// `callLobbyChannel(lobby)`, subscribes the sender and answers it alone with a
// `lobby-occupancy` snapshot. After that every seat, leave, disconnect and end
// publishes a fresh `lobby-occupancy` on the channel, debounced per lobby.

import { CallService } from '../../src/call/CallService';
import { callLobbyChannel } from '../../src/call/lobbyChannel';
import type { CallMessageRouter } from '../../src/call/types';
import { makeCluster } from './helpers/cluster';

const noop = () => undefined;
const logger = { debug: noop, info: noop, warn: noop, error: noop };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOBBY = 'acme:page:roadmap';
const CHANNEL = callLobbyChannel(LOBBY);
const DEBOUNCE = 40;

interface Opts { subscribe?: (clientId: string, channel: string) => boolean; checkOnly?: (clientId: string, channel: string) => boolean }

function makeRouter(users: Record<string, string>, opts: Opts = {}) {
  const sent: Array<{ clientId: string; message: any }> = [];
  const published: Array<{ channel: string; message: any }> = [];
  const subscribed: Array<[string, string]> = [];
  const unsubscribed: Array<[string, string]> = [];
  const router: CallMessageRouter = {
    sendToClient(clientId, message) { sent.push({ clientId, message }); return true; },
    broadcastToAll: noop,
    getClientsByUserId(userIds) {
      return Object.entries(users).filter(([, u]) => userIds.includes(u)).map(([clientId, userId]) => ({ clientId, userId }));
    },
    getUserIdForClient: (cid) => users[cid] ?? null,
    sendToChannel(channel, message) { published.push({ channel, message }); },
    unsubscribeFromChannel(clientId, channel) { unsubscribed.push([clientId, channel]); },
  };
  if (opts.checkOnly) {
    router.checkChannel = (_kind, clientId, channel) => opts.checkOnly!(clientId, channel);
  } else {
    router.subscribeToChannel = (clientId, channel) => {
      const ok = opts.subscribe ? opts.subscribe(clientId, channel) : true;
      if (ok) subscribed.push([clientId, channel]);
      return ok;
    };
  }
  const occupancy = () => published.filter((p) => p.message.action === 'lobby-occupancy');
  const toClient = (cid: string, action: string) => sent.filter((s) => s.clientId === cid && s.message.action === action).map((s) => s.message);
  return { router, sent, published, subscribed, unsubscribed, occupancy, toClient };
}

const users = { 'c-viewer': 'u-viewer', 'c-ana': 'u-ana', 'c-bea': 'u-bea', 'c-bea-2': 'u-bea', 'c-cy': 'u-cy' };

describe('CallService watch / lobby-occupancy', () => {
  const realDebounce = CallService.LOBBY_OCCUPANCY_DEBOUNCE_MS;
  let svc: CallService | null = null;
  beforeAll(() => { CallService.LOBBY_OCCUPANCY_DEBOUNCE_MS = DEBOUNCE; });
  afterAll(() => { CallService.LOBBY_OCCUPANCY_DEBOUNCE_MS = realDebounce; });
  afterEach(async () => { await svc?.dispose(); svc = null; });

  const make = (r: ReturnType<typeof makeRouter>) => (svc = new CallService({ messageRouter: r.router, logger, rejoinGraceMs: 0 }));
  const settle = () => sleep(DEBOUNCE * 3);

  it('watch subscribes the authorised channel and answers the sender alone with a snapshot', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    expect(r.subscribed).toEqual([['c-viewer', CHANNEL]]);
    expect(r.toClient('c-viewer', 'lobby-occupancy')).toEqual([expect.objectContaining({
      type: 'call',
      data: { lobbyName: LOBBY, active: false, callId: null, participantUserIds: [], participantCount: 0, startedAt: null },
    })]);
    expect(r.sent.filter((x) => x.clientId !== 'c-viewer')).toHaveLength(0);
    // A huddle already live is in the snapshot.
    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await s.handleAction('c-cy', 'watch', { lobbyName: LOBBY });
    expect(r.toClient('c-cy', 'lobby-occupancy')[0].data).toMatchObject({
      lobbyName: LOBBY, active: true, callId: 'h1', participantUserIds: ['u-ana'], participantCount: 1, pageHuddle: true,
    });
    // Watching is not a seat.
    expect(r.toClient('c-cy', 'active-call')).toHaveLength(0);
  });

  it('pushes on join, leave and end — a new action, never active-call', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });

    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await settle();
    expect(r.occupancy().at(-1)).toMatchObject({ channel: CHANNEL, message: { type: 'call', action: 'lobby-occupancy', data: { active: true, callId: 'h1', participantUserIds: ['u-ana'], participantCount: 1 } } });
    expect(typeof r.occupancy().at(-1)!.message.data.startedAt).toBe('string');

    await s.handleAction('c-bea', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea' });
    await settle();
    expect(r.occupancy().at(-1)!.message.data).toMatchObject({ active: true, participantCount: 2 });
    expect([...r.occupancy().at(-1)!.message.data.participantUserIds].sort()).toEqual(['u-ana', 'u-bea']);

    await s.handleAction('c-bea', 'ended', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea', targetUserIds: ['u-bea'] });
    await settle();
    expect(r.occupancy().at(-1)!.message.data).toMatchObject({ active: true, participantUserIds: ['u-ana'], participantCount: 1 });

    await s.handleAction('c-ana', 'ended', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana', targetUserIds: ['u-ana'] });
    await settle();
    expect(r.occupancy().at(-1)!.message.data).toEqual({ lobbyName: LOBBY, active: false, callId: null, participantUserIds: [], participantCount: 0, startedAt: null });
    expect(r.published.every((p) => p.message.action === 'lobby-occupancy')).toBe(true);
  });

  it('counts people, not connections', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-ana', 'invite', { callId: 'c1', lobbyName: LOBBY, callerId: 'u-ana', targetUserIds: ['u-bea'] });
    await s.handleAction('c-bea', 'accepted', { callId: 'c1', lobbyName: LOBBY, callerId: 'u-bea', userId: 'u-bea', targetUserIds: ['u-ana'] });
    await s.handleAction('c-bea-2', 'accepted', { callId: 'c1', lobbyName: LOBBY, callerId: 'u-bea', userId: 'u-bea', targetUserIds: ['u-ana'] });
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    const data = r.toClient('c-viewer', 'lobby-occupancy')[0].data;
    expect(data.participantCount).toBe(new Set(data.participantUserIds).size);
    expect([...data.participantUserIds].sort()).toEqual(['u-ana', 'u-bea']);
  });

  it('coalesces a burst of changes into one frame per lobby', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await s.handleAction('c-bea', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-bea' });
    await s.handleAction('c-cy', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-cy' });
    await s.handleAction('c-cy', 'ended', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-cy', targetUserIds: ['u-cy'] });
    expect(r.occupancy()).toHaveLength(0);
    await settle();
    expect(r.occupancy()).toHaveLength(1);
    expect(r.occupancy()[0].message.data.participantCount).toBe(2);
    // Another lobby has a timer of its own.
    await s.handleAction('c-viewer', 'join', { callId: 'h2', lobbyName: 'acme:page:other', callerId: 'u-viewer' });
    await settle();
    expect(r.occupancy().map((p) => p.channel)).toEqual([CHANNEL, callLobbyChannel('acme:page:other')]);
  });

  it('a refused subscribe watches nothing: error frame, no snapshot', async () => {
    const r = makeRouter(users, { subscribe: (cid) => cid !== 'c-cy' });
    const s = make(r);
    await s.handleAction('c-cy', 'watch', { lobbyName: LOBBY });
    expect(r.toClient('c-cy', 'lobby-occupancy')).toHaveLength(0);
    expect(r.sent.find((x) => x.clientId === 'c-cy')!.message).toMatchObject({ type: 'error', service: 'call', code: 'watch-denied', action: 'watch', lobbyName: LOBBY });
    expect(r.subscribed).toEqual([]);
    await s.handleDisconnect('c-cy');
    expect(r.unsubscribed).toEqual([]);
  });

  it('a router with only checkChannel is asked, and false refuses', async () => {
    const asked: string[] = [];
    const r = makeRouter(users, { checkOnly: (cid, ch) => { asked.push(`${cid}@${ch}`); return cid === 'c-viewer'; } });
    const s = make(r);
    await s.handleAction('c-cy', 'watch', { lobbyName: LOBBY });
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    expect(asked).toEqual([`c-cy@${CHANNEL}`, `c-viewer@${CHANNEL}`]);
    expect(r.toClient('c-cy', 'lobby-occupancy')).toHaveLength(0);
    expect(r.toClient('c-viewer', 'lobby-occupancy')).toHaveLength(1);
  });

  it('the host authorize hook gates watch like every other verb', async () => {
    const r = makeRouter(users);
    svc = new CallService({ messageRouter: r.router, logger, config: { authorize: (_cid, action) => action !== 'watch' } });
    await svc.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    expect(r.subscribed).toEqual([]);
    expect(r.toClient('c-viewer', 'lobby-occupancy')).toHaveLength(0);
  });

  it('unwatch and disconnect unsubscribe; a participant disconnect publishes the end', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    await s.handleAction('c-viewer', 'watch', { lobbyName: 'acme:page:other' });
    await s.handleAction('c-viewer', 'unwatch', { lobbyName: 'acme:page:other' });
    expect(r.unsubscribed).toEqual([['c-viewer', callLobbyChannel('acme:page:other')]]);
    await s.handleDisconnect('c-viewer');
    expect(r.unsubscribed).toEqual([['c-viewer', callLobbyChannel('acme:page:other')], ['c-viewer', CHANNEL]]);

    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await settle();
    await s.handleDisconnect('c-ana');
    await settle();
    expect(r.occupancy().at(-1)!.message.data).toMatchObject({ active: false, callId: null });
  });

  it('publishes when the rejoin grace runs out', async () => {
    const r = makeRouter(users);
    svc = new CallService({ messageRouter: r.router, logger, rejoinGraceMs: 400 });
    await svc.handleAction('c-ana', 'invite', { callId: 'g1', lobbyName: LOBBY, callerId: 'u-ana', targetUserIds: ['u-bea'] });
    await svc.handleAction('c-bea', 'accepted', { callId: 'g1', lobbyName: LOBBY, callerId: 'u-bea', userId: 'u-bea', targetUserIds: ['u-ana'] });
    await settle();
    await svc.handleDisconnect('c-bea');
    await settle();
    // Bea's seat is held, so the call is still live with Ana in it.
    expect(r.occupancy().at(-1)!.message.data).toMatchObject({ active: true, callId: 'g1', participantUserIds: ['u-ana'] });
    await sleep(400 + DEBOUNCE * 3);
    expect(r.occupancy().at(-1)!.message.data).toMatchObject({ active: false });
  });

  it('dispose drops a pending publish', async () => {
    const r = makeRouter(users);
    const s = make(r);
    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await s.dispose();
    await settle();
    expect(r.occupancy()).toHaveLength(0);
  });

  it('a router without sendToChannel still answers the watcher', async () => {
    const r = makeRouter(users);
    delete (r.router as Partial<CallMessageRouter>).sendToChannel;
    const s = make(r);
    await s.handleAction('c-ana', 'join', { callId: 'h1', lobbyName: LOBBY, callerId: 'u-ana' });
    await s.handleAction('c-viewer', 'watch', { lobbyName: LOBBY });
    expect(r.toClient('c-viewer', 'lobby-occupancy')[0].data).toMatchObject({ active: true, callId: 'h1' });
  });

  it('a departure heard from another node publishes on the hearing node too', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    try {
      c.connect('a-ana', 'u-ana', 'A'); c.connect('b-bea', 'u-bea', 'B'); c.connect('b-cy', 'u-cy', 'B');
      const onB: any[] = [];
      c.B.router.sendToChannel = (channel, message) => { onB.push({ channel, message }); };
      await c.A.svc.handleCallEvent('a-ana', 'join', { callId: 'x1', lobbyName: LOBBY, callerId: 'u-ana' });
      await c.B.svc.handleCallEvent('b-bea', 'join', { callId: 'x1', lobbyName: LOBBY, callerId: 'u-bea' });
      await c.B.svc.handleCallEvent('b-cy', 'join', { callId: 'x1', lobbyName: LOBBY, callerId: 'u-cy' });
      await settle();
      onB.length = 0;
      c.drop('a-ana');
      await c.A.svc.handleDisconnect('a-ana');
      await settle();
      expect(onB.length).toBeGreaterThan(0);
      expect(onB.at(-1)).toMatchObject({ channel: CHANNEL, message: { action: 'lobby-occupancy', data: { active: true, callId: 'x1' } } });
      expect(onB.at(-1).message.data.participantUserIds).not.toContain('u-ana');
    } finally {
      await c.dispose();
    }
  });
});
