// Opt-in native Lua acceptance against uniquely owned local Redis resources.
// Only random test call/client keys are created and removed; never FLUSHDB.
import { createClient, type RedisClientType } from 'redis';
import { RedisCallStateStore } from '../../src/call/CallStateStore';
const url = process.env.CALL_TEST_REDIS_URL;
const suite = url ? describe : describe.skip;
suite('immutable original call channel (actual Redis)', () => {
  let redis: RedisClientType, store: RedisCallStateStore, id: string, keys: string[];
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url!).hostname)) throw new Error('Loopback disposable Redis required');
    redis = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
    redis.on('error', () => {}); await redis.connect(); await redis.ping(); store = new RedisCallStateStore(redis as never);
  });
  beforeEach(() => { id = `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    keys = [`call:active:${id}`, `call:active:${id}:participants`, `client:calls:${id}-a`, `client:calls:${id}-b`]; });
  afterEach(async () => { if (redis?.isOpen) await redis.del(keys); });
  afterAll(async () => { if (redis?.isOpen) await redis.quit(); });
  test('first creator source survives a different join and subsequent full-state write', async () => {
    await store.registerParticipant(id, `${id}-a`, 'alice', 'assessment:doc:hash', [], 'assessment:source:page:100002');
    await store.registerParticipant(id, `${id}-b`, 'bob', 'assessment:doc:hash', [], 'assessment:source:page:other');
    expect((await store.getCall(id))!.channel).toBe('assessment:source:page:100002');
    const current = (await store.getCall(id))!;
    await store.setCall(id, { ...current, channel: 'assessment:source:page:overwrite' }, 60);
    expect((await store.getCall(id))!.channel).toBe('assessment:source:page:100002');
  });
  test('concurrent creators capture one coherent caller/lobby/source tuple', async () => {
    await Promise.all([
      store.registerParticipant(id, `${id}-a`, 'alice', 'assessment:doc:one', ['bob'], 'assessment:source:page:one'),
      store.registerParticipant(id, `${id}-b`, 'bob', 'assessment:doc:two', ['alice'], 'assessment:source:page:two'),
    ]);
    const row = (await store.getCall(id))!;
    expect([{ callerId: 'alice', lobbyName: 'assessment:doc:one', channel: 'assessment:source:page:one', targetUserIds: ['bob'] },
      { callerId: 'bob', lobbyName: 'assessment:doc:two', channel: 'assessment:source:page:two', targetUserIds: ['alice'] }])
      .toContainEqual({ callerId: row.callerId, lobbyName: row.lobbyName, channel: row.channel, targetUserIds: row.targetUserIds });
    expect(await redis.ttl(`call:active:${id}`)).toBeGreaterThan(0);
  });
  test('legacy missing channel cannot acquire a later join or setCall source', async () => {
    await store.registerParticipant(id, `${id}-a`, 'alice', 'assessment:doc:hash', []);
    await store.registerParticipant(id, `${id}-b`, 'bob', 'assessment:doc:hash', [], 'assessment:source:page:late');
    const row = (await store.getCall(id))!; expect(row.channel).toBeUndefined();
    await store.setCall(id, { ...row, channel: 'assessment:source:page:late' }, 60);
    expect((await store.getCall(id))!.channel).toBeUndefined();
  });
  test('first full-state creation captures its channel; malformed creator source remains unknown', async () => {
    await store.setCall(id, { callerId: 'alice', lobbyName: 'assessment:doc:one', targetUserIds: [], participantClientIds: [], channel: 'assessment:source:page:one' }, 60);
    expect((await store.getCall(id))!.channel).toBe('assessment:source:page:one');
    await store.forgetCall(id);
    await store.registerParticipant(id, `${id}-a`, 'alice', 'assessment:doc:one', [], 'invalid\nchannel');
    expect((await store.getCall(id))!.channel).toBeUndefined();
  });
});
