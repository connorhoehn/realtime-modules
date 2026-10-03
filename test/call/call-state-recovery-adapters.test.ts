import { RedisCallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';

describe('RedisCallStateStore atomic script adapters', () => {
  test.each(['sendCommand', 'call', 'eval', 'command'] as const)(
    '%s dispatches EVAL without selecting lower-priority client APIs', async (selected) => {
      const redis = new FakeRedis() as any;
      const execute = redis.command.bind(redis);
      const priority = ['sendCommand', 'call', 'eval', 'command'];
      const runners: Record<string, jest.Mock> = {};
      for (const [index, name] of priority.entries()) {
        if (index < priority.indexOf(selected)) { redis[name] = undefined; continue; }
        runners[name] = jest.fn(async (...values: any[]) => {
          if (name !== selected) throw new Error(`Unexpected lower-priority ${name}`);
          if (name === 'sendCommand') {
            const [command, script, count, ...args] = values[0];
            return execute(command, script, Number(count), ...args);
          }
          if (name === 'eval') return execute('EVAL', values[0], values[1], ...values.slice(2));
          return execute(values[0], values[1], values[2], ...values.slice(3));
        });
        redis[name] = runners[name];
      }
      // In node-redis command() is COMMAND introspection, not an EVAL
      // transport. Its presence must not hide the usable sendCommand().
      const store = new RedisCallStateStore(redis);
      await store.registerParticipant('call', 'old', 'alice', 'acme:dm:alice:bob', ['bob']);
      await store.registerUserCall('alice', 'call', 3600);
      await store.markAccepted('call', 3600);
      const before = (await store.getCall('call'))!;
      expect(await store.resumeParticipant('call', 'new', 'alice', before.lobbyName, ['old'])).toBe(true);
      expect((await store.getCall('call'))!.participantClientIds).toEqual(['new']);
      expect(await store.forgetCallIfUnchanged('call', before)).toBe(false);
      expect(await store.forgetCallIfUnchanged('call', (await store.getCall('call'))!)).toBe(true);
      expect(await store.getCall('call')).toBeNull();
      expect(runners[selected]).toHaveBeenCalledTimes(3);
      for (const name of priority.slice(priority.indexOf(selected) + 1)) expect(runners[name]).not.toHaveBeenCalled();
    },
  );

  test('missing Lua transport fails explicitly rather than falling back to non-atomic mutation', async () => {
    const redis = new FakeRedis() as any;
    redis.command = undefined;
    const store = new RedisCallStateStore(redis);
    await expect(store.resumeParticipant('call', 'new', 'alice', 'acme:dm:alice:bob')).rejects.toThrow('atomic recovery requires');
  });
});
