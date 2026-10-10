import { InMemoryCallStateStore, RedisCallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';
import { makeCluster } from './helpers/cluster';
const lobby = 'assessment:doc:page:owned';
const channel = 'assessment-document:/assessment/workspace?doc=page%3Aowned';

describe.each([
  ['memory', () => new InMemoryCallStateStore()],
  ['Redis contract double', () => new RedisCallStateStore(new FakeRedis() as any)],
] as const)('immutable source channel (%s)', (_name, make) => {
  it('retains the creator channel through a later participant, reinvite and metadata refresh', async () => {
    const store = make();
    await store.registerParticipant('c', 'a', 'alice', lobby, ['bob'], channel);
    await store.registerParticipant('c', 'b', 'bob', lobby, [], 'assessment-document:/assessment/workspace?doc=other');
    await store.setInviteMetadata('c', { invitedAt: 100, callerName: 'Alice' });
    expect(await store.getCall('c')).toMatchObject({ callerId: 'alice', lobbyName: lobby, channel });
    await store.setCall!('c', { callerId: 'alice', lobbyName: lobby, participantClientIds: ['a','b'], targetUserIds: [], channel: 'replacement' }, 60);
    expect((await store.getCall('c'))?.channel).toBe(channel);
  });
  it('does not let a later join infer a source for a legacy contextless call', async () => {
    const store = make();
    await store.registerParticipant('c', 'a', 'alice', lobby, []);
    await store.registerParticipant('c', 'b', 'bob', lobby, [], channel);
    expect((await store.getCall('c'))?.channel).toBeUndefined();
  });
  it('creates a distinct source only after the original call has ended', async () => {
    const store = make();
    await store.registerParticipant('c', 'a', 'alice', lobby, [], channel);
    await store.forgetCall('c');
    await store.registerParticipant('c', 'b', 'bob', lobby, [], 'new-source');
    expect((await store.getCall('c'))?.channel).toBe('new-source');
  });
});

it.each(['invite', 'join'] as const)('captures %s source through the native cross-node service', async action => {
  const c = makeCluster({ rejoinGraceMs: 0 });
  try {
    c.connect('a', 'alice', 'A'); c.connect('b', 'bob', 'B');
    const store = new RedisCallStateStore(c.redis as any);
    await c.A.svc.handleCallEvent('a', action, { callId: 'source-call', lobbyName: lobby, callerId: 'alice', targetUserIds: action === 'invite' ? ['bob'] : [], channel });
    expect((await store.getCall('source-call'))?.channel).toBe(channel);
    await c.B.svc.handleCallEvent('b', 'join', { callId: 'source-call', lobbyName: lobby, callerId: 'bob', channel: 'replacement' });
    expect((await store.getCall('source-call'))?.channel).toBe(channel);
  } finally { await c.dispose(); }
});
