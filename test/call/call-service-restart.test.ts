import { CallService } from '../../src/call/CallService';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as any;
const LOBBY = 'acme:dm:alice:bob';
const CALL = 'call-before-restart';

function router(users: Record<string, string>) {
  const sent: Array<{ clientId: string; message: any }> = [];
  return {
    sent,
    sendToClient(clientId: string, message: any) { sent.push({ clientId, message }); return true; },
    broadcastToAll() {},
    getClientsByUserId(ids: string[], excluded?: string) { return Object.entries(users).filter(([cid, uid]) => cid !== excluded && ids.includes(uid)).map(([clientId, userId]) => ({ clientId, userId })); },
    getUserIdForClient(clientId: string) { return users[clientId] ?? null; },
    isClientLive(clientId: string) { return clientId in users; },
  };
}

async function persistCall(store: CallStateStore, targets = ['bob']) {
  const svc = new CallService({ stateStore: store, messageRouter: router({ 'old-alice': 'alice', 'old-bob': 'bob' }) as any, logger: quiet });
  await svc.handleAction('old-alice', 'invite', { callId: CALL, lobbyName: LOBBY, callerId: 'alice', callerName: 'Alice Original', targetUserIds: targets });
  await svc.handleAction('old-bob', 'accepted', { callId: CALL, lobbyName: LOBBY, callerId: 'bob', userId: 'bob', targetUserIds: ['alice'] });
  await jest.advanceTimersByTimeAsync(10);
  const original = (await store.getCall(CALL))!;
  await svc.dispose();
  await jest.advanceTimersByTimeAsync(100_000);
  return original;
}

const announce = (svc: CallService, cid: string, uid: string, other: string, lobby = LOBBY) => svc.handleAction(cid, 'participant-state', { callId: CALL, lobbyName: lobby, callerId: uid, userId: uid, status: 'in-call', targetUserIds: [other] });
const status = (svc: CallService, cid: string) => svc.handleAction(cid, 'status', { lobbyName: LOBBY });

describe.each<[string, () => CallStateStore]>([
  ['memory durable double', () => new InMemoryCallStateStore()],
  ['Redis adapter', () => new RedisCallStateStore(new FakeRedis() as any)],
])('CallService restart recovery — %s', (_label, makeStore) => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('status before participant-state preserves an accepted persisted call and original metadata', async () => {
    const store = makeStore();
    const original = await persistCall(store);
    const r = router({ 'new-alice': 'alice', 'new-bob': 'bob' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      await status(svc, 'new-alice');
      expect(r.sent.at(-1)!.message.data.active).toBe(false); // no seat granted by discovery
      expect(await store.getCall(CALL)).not.toBeNull();
      await announce(svc, 'new-alice', 'alice', 'bob');
      await status(svc, 'new-bob');
      await announce(svc, 'new-bob', 'bob', 'alice');
      await status(svc, 'new-alice');
      const reply = r.sent.at(-1)!.message.data;
      expect(reply).toMatchObject({ active: true, callId: CALL, callerId: 'alice', callerName: 'Alice Original', participantCount: 2, startedAt: new Date(original.invitedAt!).toISOString() });
      expect([...reply.participantUserIds].sort()).toEqual(['alice', 'bob']);
      expect((await store.getCall(CALL))!.callerId).toBe('alice');
      expect((await store.getCall(CALL))!.participantClientIds.sort()).toEqual(['new-alice', 'new-bob']);
    } finally { await svc.dispose(); }
  });

  test('a cold ghost stops being protected after the configured startup grace', async () => {
    const store = makeStore();
    await persistCall(store, ['bob', 'eve']);
    const r = router({ observer: 'alice' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      await status(svc, 'observer');
      expect(await store.getCall(CALL)).not.toBeNull();
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(9000);
        await status(svc, 'observer');
        expect(await store.getCall(CALL)).not.toBeNull();
      }
      await jest.advanceTimersByTimeAsync(3001);
      await status(svc, 'observer');
      expect(r.sent.at(-1)!.message.data.active).toBe(false);
      expect(await store.getCall(CALL)).toBeNull();
      expect(await store.getCallIdsByUser!('alice')).toEqual([]);
    } finally { await svc.dispose(); }
  });

  test('an invited but never seated user cannot rejoin or gain a participant through discovery', async () => {
    const store = makeStore();
    await persistCall(store, ['bob', 'eve']);
    const r = router({ outsider: 'eve' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      await status(svc, 'outsider');
      await announce(svc, 'outsider', 'alice', 'bob'); // payload identity is forged
      expect((await store.getCall(CALL))!.participantClientIds).not.toContain('outsider');
      expect(await store.getCallIdsByUser!('eve')).toEqual([]);
    } finally { await svc.dispose(); }
  });

  test('the existing authorization gate still refuses revoked/foreign lobby recovery', async () => {
    const store = makeStore();
    await persistCall(store);
    const r = router({ 'new-alice': 'alice' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet, config: { authorize: () => false } });
    try {
      await status(svc, 'new-alice');
      await announce(svc, 'new-alice', 'alice', 'bob');
      expect((await store.getCall(CALL))!.participantClientIds).not.toContain('new-alice');
      expect(r.sent.every((s) => s.message.type === 'error')).toBe(true);
    } finally { await svc.dispose(); }
  });

  test('stored lobby mismatch and a forgotten user seat do not register a fresh socket', async () => {
    const store = makeStore();
    await persistCall(store);
    const r = router({ 'new-alice': 'alice' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      await announce(svc, 'new-alice', 'alice', 'bob', 'foreign:room:other');
      expect((await store.getCall(CALL))!.participantClientIds).not.toContain('new-alice');
      await store.forgetUserCall!('alice', CALL);
      await announce(svc, 'new-alice', 'alice', 'bob');
      expect((await store.getCall(CALL))!.participantClientIds).not.toContain('new-alice');
    } finally { await svc.dispose(); }
  });

  test('a terminal call deleted while recovering cannot be recreated by an old snapshot', async () => {
    const store = makeStore();
    await persistCall(store);
    const originalLookup = store.getCallIdsByUser!.bind(store);
    let resume!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    store.getCallIdsByUser = async (uid) => {
      const ids = await originalLookup(uid);
      entered();
      await new Promise<void>((resolve) => { resume = resolve; });
      return ids;
    };
    const r = router({ 'new-alice': 'alice' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      const pending = announce(svc, 'new-alice', 'alice', 'bob');
      await blocked;
      await store.forgetCall(CALL);
      resume();
      await pending;
      expect(await store.getCall(CALL)).toBeNull();
    } finally { await svc.dispose(); }
  });

  test('a late dead-roster status read cannot delete a newer resumed roster', async () => {
    const store = makeStore();
    await persistCall(store);
    const r = router({ 'new-alice': 'alice', 'new-bob': 'bob' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet, rejoinGraceMs: 0 });
    const originalGet = store.getCall.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    let once = true;
    store.getCall = async (id) => {
      const snapshot = await originalGet(id);
      if (once) { once = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
      return snapshot;
    };
    try {
      const pending = status(svc, 'new-alice');
      await blocked;
      await announce(svc, 'new-alice', 'alice', 'bob');
      release();
      await pending;
      expect((await originalGet(CALL))!.participantClientIds).toEqual(['new-alice']);
    } finally { await svc.dispose(); }
  });

  test('one returning user then explicit hang-up leaves no dead old IDs sustaining a ghost', async () => {
    const store = makeStore();
    await persistCall(store);
    const r = router({ 'new-alice': 'alice' });
    const svc = new CallService({ stateStore: store, messageRouter: r as any, logger: quiet });
    try {
      await announce(svc, 'new-alice', 'alice', 'bob');
      expect((await store.getCall(CALL))!.participantClientIds).toEqual(['new-alice']);
      await svc.handleAction('new-alice', 'ended', { callId: CALL, lobbyName: LOBBY, callerId: 'alice', targetUserIds: ['alice'] });
      await jest.advanceTimersByTimeAsync(10);
      expect(await store.getCall(CALL)).toBeNull();
      await announce(svc, 'new-alice', 'alice', 'bob');
      expect(await store.getCall(CALL)).toBeNull();
    } finally { await svc.dispose(); }
  });
});
