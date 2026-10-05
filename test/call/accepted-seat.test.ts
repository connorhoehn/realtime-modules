import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';

describe.each(['memory', 'redis-double'] as const)('%s accepted seats', backend => {
  let store: CallStateStore;
  beforeEach(async () => {
    store = backend === 'memory' ? new InMemoryCallStateStore() : new RedisCallStateStore(new FakeRedis() as any);
    await store.registerParticipant('call', 'caller', 'alice', 'orgiq:room', ['bob', 'charlie']);
  });

  it('one of many concurrent same-user claims wins, and other people retain independent seats', async () => {
    const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => store.claimAcceptedSeat!('call', `bob-${i}`, 'bob', 'orgiq:room')));
    expect(claims.filter(claim => claim.accepted)).toHaveLength(1);
    const winner = claims.find(claim => claim.accepted)!.winnerClientId!;
    expect(claims.every(claim => claim.winnerClientId === winner)).toBe(true);
    expect((await store.getCall('call'))!.participantClientIds.sort()).toEqual(['caller', winner].sort());
    expect(await store.getCallIdsByClient('bob-15')).toEqual(winner === 'bob-15' ? ['call'] : []);
    expect(await store.claimAcceptedSeat!('call', 'charlie', 'charlie', 'orgiq:room')).toEqual({ accepted: true, winnerClientId: 'charlie' });
    expect((await store.getCall('call'))!.callerId).toBe('alice');
  });

  it('only a proof naming the current winner permits replacement, and resume cannot bypass it', async () => {
    await store.claimAcceptedSeat!('call', 'bob-1', 'bob', 'orgiq:room');
    await store.markAccepted!('call', 3600);
    expect(await store.resumeParticipant!('call', 'bob-2', 'bob', 'orgiq:room')).toBe(false);
    expect(await store.claimAcceptedSeat!('call', 'bob-2', 'bob', 'orgiq:room', 'unrelated')).toEqual({ accepted: false, winnerClientId: 'bob-1' });
    expect(await store.resumeParticipant!('call', 'bob-2', 'bob', 'orgiq:room', ['bob-1'])).toBe(true);
    expect(await store.claimAcceptedSeat!('call', 'bob-3', 'bob', 'orgiq:room', 'bob-1')).toEqual({ accepted: false, winnerClientId: 'bob-2' });
    expect((await store.getCall('call'))!.participantClientIds.sort()).toEqual(['caller', 'bob-2'].sort());
    expect(await store.getCallIdsByClient('bob-1')).toEqual([]);
  });

  it('a removed seat can be claimed again, but a missing or foreign-lobby call cannot be created', async () => {
    await store.claimAcceptedSeat!('call', 'bob-1', 'bob', 'orgiq:room');
    await store.removeParticipant('call', 'bob-1');
    expect((await store.claimAcceptedSeat!('call', 'bob-2', 'bob', 'orgiq:room')).accepted).toBe(true);
    expect(await store.claimAcceptedSeat!('call', 'bad', 'bob', 'assessment:room')).toEqual({ accepted: false });
    await store.forgetCall('call');
    expect(await store.claimAcceptedSeat!('call', 'bad', 'bob', 'orgiq:room')).toEqual({ accepted: false });
    expect(await store.getCall('call')).toBeNull();
  });
});
