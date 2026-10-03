// Opt-in real Redis Lua contracts. The URL must identify a disposable local
// Redis; only randomly named keys created by this suite are removed.
import { createClient } from 'redis';
import { RedisCallStateStore } from '../../src/call/CallStateStore';

const url = process.env.CALL_TEST_REDIS_URL;
const suite = url ? describe : describe.skip;

suite('RedisCallStateStore atomic recovery (real Redis)', () => {
  let redis: ReturnType<typeof createClient>;
  let store: RedisCallStateStore;
  let id: string, alice: string, bob: string, lobby: string, oldA: string, oldB: string, newA: string;
  let keys: string[];

  beforeAll(async () => {
    const host = new URL(url!).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error('Real Redis recovery tests require loopback');
    redis = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
    redis.on('error', () => {});
    await redis.connect();
    await redis.ping();
    store = new RedisCallStateStore(redis as any);
  });
  afterAll(async () => { if (redis?.isOpen) await redis.quit(); });
  beforeEach(async () => {
    const tag = `restart-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    id = `call-${tag}`; alice = `alice-${tag}`; bob = `bob-${tag}`;
    oldA = `old-a-${tag}`; oldB = `old-b-${tag}`; newA = `new-a-${tag}`;
    lobby = `acme:dm:${alice}:${bob}`;
    keys = [`call:active:${id}`, `call:active:${id}:participants`, `call:accepted:${id}`, `call:user:${alice}`, `call:user:${bob}`, `call:lobby:${lobby}`, `client:calls:${oldA}`, `client:calls:${oldB}`, `client:calls:${newA}`, `client:calls:stranger-${tag}`];
    await store.registerParticipant(id, oldA, alice, lobby, [bob]);
    await store.registerParticipant(id, oldB, alice, lobby, [bob]);
    await store.registerUserCall(alice, id, 3600);
    await store.registerUserCall(bob, id, 3600);
    await store.registerLobbyCall(lobby, id, 3600);
    await store.markAccepted(id, 3600);
    await store.setInviteMetadata(id, { invitedAt: 1000, callerName: 'Original caller' });
  });
  afterEach(async () => { if (redis?.isOpen) await redis.del(keys); });

  test('resume retires dead client IDs without replacing canonical caller/start metadata', async () => {
    expect(await store.resumeParticipant(id, newA, alice, lobby, [oldA, oldB])).toBe(true);
    expect(await store.getCall(id)).toMatchObject({ callerId: alice, lobbyName: lobby, invitedAt: 1000, callerName: 'Original caller', participantClientIds: [newA] });
    expect(await store.getCallIdsByClient(oldA)).toEqual([]);
    expect(await store.getCallIdsByClient(oldB)).toEqual([]);
    expect(await store.getCallIdsByClient(newA)).toEqual([id]);
  });

  test('wrong lobby and a user without an authenticated remembered seat cannot resume', async () => {
    expect(await store.resumeParticipant(id, newA, alice, 'foreign:room:other')).toBe(false);
    expect(await store.resumeParticipant(id, newA, 'not-seated', lobby)).toBe(false);
    expect(await store.getCallIdsByClient(newA)).toEqual([]);
  });

  test('deleting the call before resume cannot recreate its hash or client index', async () => {
    await store.forgetCall(id);
    expect(await store.resumeParticipant(id, newA, alice, lobby)).toBe(false);
    expect(await store.getCall(id)).toBeNull();
    expect(await redis.exists(`client:calls:${newA}`)).toBe(0);
  });

  test('a stale dead-roster snapshot cannot prune a concurrently resumed call', async () => {
    const snapshot = (await store.getCall(id))!;
    expect(await store.resumeParticipant(id, newA, alice, lobby, [oldA, oldB])).toBe(true);
    expect(await store.forgetCallIfUnchanged(id, snapshot)).toBe(false);
    expect((await store.getCall(id))!.participantClientIds).toEqual([newA]);
  });

  test('resume and conditional prune have one atomic winner', async () => {
    const snapshot = (await store.getCall(id))!;
    const [resumed, pruned] = await Promise.all([
      store.resumeParticipant(id, newA, alice, lobby, [oldA, oldB]),
      store.forgetCallIfUnchanged(id, snapshot),
    ]);
    expect(Number(resumed) + Number(pruned)).toBe(1);
    const current = await store.getCall(id);
    if (resumed) expect(current!.participantClientIds).toEqual([newA]);
    else {
      expect(current).toBeNull();
      expect(await store.isAccepted(id)).toBe(false);
      expect(await redis.exists(`client:calls:${newA}`)).toBe(0);
    }
  });
});
