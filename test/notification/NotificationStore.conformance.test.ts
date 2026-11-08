// 0.147: both stores satisfy the NotificationStore contract the service uses.
import { describe, it, expect } from '@jest/globals';
import {
    InMemoryNotificationStore,
    RedisNotificationStore,
    type NotificationRecord,
    type NotificationRedisClient,
    type NotificationStore,
} from '../../src/notification';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

/** A node-redis v4 surface over memory: ZSET + HASH, enough for the store. */
function fakeRedis(): NotificationRedisClient {
    const zsets = new Map<string, Array<{ score: number; value: string }>>();
    const hashes = new Map<string, Record<string, string>>();
    const range = (arr: unknown[], start: number, stop: number) => {
        const n = arr.length;
        const s = start < 0 ? Math.max(n + start, 0) : start;
        const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
        return [s, e] as const;
    };
    return {
        async zAdd(key, member) {
            const z = (zsets.get(key) ?? []).filter((m) => m.value !== member.value);
            z.push(member);
            z.sort((a, b) => a.score - b.score);
            zsets.set(key, z);
        },
        async zRange(key, start, stop) { const z = zsets.get(key) ?? []; const [s, e] = range(z, start, stop); return z.slice(s, e + 1).map((m) => m.value); },
        async zCard(key) { return (zsets.get(key) ?? []).length; },
        async zRemRangeByRank(key, start, stop) { const z = zsets.get(key) ?? []; const [s, e] = range(z, start, stop); if (e >= s) z.splice(s, e - s + 1); },
        async hSet(key, field, value) { hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: value }); },
        async hGetAll(key) { return hashes.get(key) ?? {}; },
        async expire() { /* no clock */ },
        async del(key) { zsets.delete(key); hashes.delete(key); },
    };
}

const rec = (id: string, minute: number, extra: Partial<NotificationRecord> = {}): NotificationRecord => ({
    id, type: 'approval-requested', title: `Need ${id}`, timestamp: `2026-11-08T10:${String(minute).padStart(2, '0')}:00.000Z`, ...extra,
});

const stores: Array<[string, () => NotificationStore]> = [
    ['InMemoryNotificationStore', () => new InMemoryNotificationStore()],
    ['RedisNotificationStore', () => new RedisNotificationStore({ redisClient: fakeRedis(), logger: new NoopLogger() })],
];

describe.each(stores)('%s conforms to NotificationStore', (_name, make) => {
    it('lists oldest first, per user', async () => {
        const store = make();
        await store.append('u1', rec('b', 2));
        await store.append('u1', rec('a', 1));
        await store.append('u2', rec('z', 3));
        expect((await store.list('u1')).map((n) => n.id)).toEqual(['a', 'b']);
        expect((await store.list('u2')).map((n) => n.id)).toEqual(['z']);
        expect(await store.list('nobody')).toEqual([]);
    });

    it('reconciles read state in list and listUnread; unknown ids are harmless', async () => {
        const store = make();
        await store.append('u1', rec('a', 1, { payload: { key: 'a' }, action: { label: 'Open' } }));
        await store.append('u1', rec('b', 2));
        await store.markRead('u1', 'a');
        await store.markRead('u1', 'missing');
        const list = await store.list('u1');
        expect(list.map((n) => [n.id, !!n.read])).toEqual([['a', true], ['b', false]]);
        expect(list[0].payload).toEqual({ key: 'a' });
        expect(list[0].action).toEqual({ label: 'Open' });
        expect((await store.listUnread('u1')).map((n) => n.id)).toEqual(['b']);
    });

    it('markAllRead returns the ids it marked', async () => {
        const store = make();
        await store.append('u1', rec('a', 1));
        await store.append('u1', rec('b', 2));
        expect((await store.markAllRead('u1')).sort()).toEqual(['a', 'b']);
        expect(await store.listUnread('u1')).toEqual([]);
        expect(await store.markAllRead('nobody')).toEqual([]);
    });
});

describe('InMemoryNotificationStore specifics', () => {
    it('removes by id, replaces a re-announced id, keeps read state across replace, and caps per user', async () => {
        const store = new InMemoryNotificationStore({ maxPerUser: 2 });
        await store.append('u1', rec('a', 1));
        await store.markRead('u1', 'a');
        await store.append('u1', rec('a', 1, { title: 'Need a (again)' }));
        expect(await store.list('u1')).toEqual([{ ...rec('a', 1, { title: 'Need a (again)' }), read: true }]);

        await store.append('u1', rec('b', 2));
        await store.append('u1', rec('c', 3));
        expect((await store.list('u1')).map((n) => n.id)).toEqual(['b', 'c']);

        expect(await store.remove('u1', 'b')).toBe(true);
        expect(await store.remove('u1', 'b')).toBe(false);
        expect((await store.list('u1')).map((n) => n.id)).toEqual(['c']);

        // Records handed out are copies: mutating one does not touch the store.
        const [c] = await store.list('u1');
        c.title = 'mutated';
        expect((await store.list('u1'))[0].title).toBe('Need c');
        store.clear();
        expect(await store.list('u1')).toEqual([]);
        expect(() => new InMemoryNotificationStore({ maxPerUser: 0 })).toThrow();
    });
});
