// Two MeetingService replicas on one shared store (0.125.0): compare-and-set
// writes, no lost updates, no idle delete under another replica's
// subscribers, mirrors that follow remote writes, and exactly one timer close.

import { MeetingService } from '../../src/meeting/MeetingService';
import { InMemoryMeetingStateStore, type MeetingStateStore } from '../../src/meeting/MeetingStateStore';
import { MEETING_CAS_SCRIPT, RedisMeetingStateStore } from '../../src/meeting/RedisMeetingStateStore';
import { breakoutLobbyName } from '../../src/meeting/lobby';
import type { MeetingState } from '../../src/meeting/types';
import { connectAs, fakeRouter } from './helpers';

const M = 'orgiq:initiative:p-shared';

/** One Map is the cluster's Redis; EVAL runs the CAS script's semantics atomically. */
function fakeRedis() {
    const strings = new Map<string, string>();
    const listeners = new Map<string, Set<(m: string) => void>>();
    const evals: string[][] = [];
    const run = (args: string[]) => {
        evals.push(args);
        const [cmd, script, count, key, json, expected, , channel] = args;
        if (cmd !== 'EVAL' || script !== MEETING_CAS_SCRIPT || count !== '1') throw new Error('unexpected command');
        const cur = strings.get(key);
        let v = 0;
        try { v = cur ? Number(JSON.parse(cur).version) || 0 : 0; } catch { v = 0; }
        if (v !== Number(expected)) return 0;
        strings.set(key, json);
        if (channel) for (const l of listeners.get(channel) ?? []) queueMicrotask(() => l(json));
        return 1;
    };
    const client = {
        strings, evals,
        get: async (k: string) => strings.get(k) ?? null,
        del: async (...keys: string[]) => { keys.forEach((k) => strings.delete(k)); },
        sendCommand: async (args: string[]) => run(args),
    };
    const subscriber = () => ({
        subscribe: (ch: string, l: (m: string) => void) => {
            const set = listeners.get(ch) ?? new Set();
            set.add(l);
            listeners.set(ch, set);
        },
        unsubscribe: (ch: string) => { listeners.delete(ch); },
    });
    return { client, subscriber };
}

/** A store whose reads yield, so two replicas read the same version before either writes. */
function yielding(inner: MeetingStateStore): MeetingStateStore {
    return {
        shared: inner.shared,
        get: async (id) => { const s = await inner.get(id); await new Promise((r) => setImmediate(r)); return s; },
        put: (s) => inner.put(s),
        putIfVersion: (s, v) => inner.putIfVersion!(s, v),
        delete: (id) => inner.delete(id),
        watch: inner.watch?.bind(inner),
    };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function replicas(store: (n: number) => MeetingStateStore, config: Record<string, unknown> = {}) {
    const changes: Array<{ replica: string; action: string; userId: string }> = [];
    const make = (name: string, n: number) => {
        const router = fakeRouter();
        const svc = new MeetingService({
            router,
            config: { store: store(n), onChange: (e) => changes.push({ replica: name, action: e.action, userId: e.userId }), ...config },
        });
        return { router, svc };
    };
    return { a: make('a', 0), b: make('b', 1), changes };
}

describe('RedisMeetingStateStore', () => {
    it('compare-and-sets on version, publishes what it commits, and parses defensively', async () => {
        const { client, subscriber } = fakeRedis();
        const store = new RedisMeetingStateStore(client, { prefix: 't:', ttlSeconds: 120, subscriber: subscriber() });
        const seen: MeetingState[] = [];
        const stop = store.watch((s) => seen.push(s));
        const s1 = { meetingId: M, createdBy: 'u', version: 1, hands: [], breakout: {} as any, updatedAt: 'x' } as MeetingState;
        expect(await store.putIfVersion(s1, 0)).toBe(true);
        expect(await store.putIfVersion({ ...s1, version: 2 }, 0)).toBe(false);
        expect(await store.putIfVersion({ ...s1, version: 2 }, 1)).toBe(true);
        expect((await store.get(M))!.version).toBe(2);
        expect(client.evals[0]).toEqual(['EVAL', MEETING_CAS_SCRIPT, '1', `t:state:${M}`, JSON.stringify(s1), '0', '120', 't:changed']);
        await flush();
        expect(seen.map((s) => s.version)).toEqual([1, 2]);
        stop();
        client.strings.set(`t:state:${M}`, '{not json');
        expect(await store.get(M)).toBeNull();
        await store.put({ ...s1, version: 9 });
        expect((await store.get(M))!.version).toBe(9);
        await store.delete(M);
        expect(await store.get(M)).toBeNull();
    });

    it('speaks ioredis call(), publishes nothing without a subscriber, and refuses a client with no EVAL', async () => {
        const calls: unknown[][] = [];
        const store = new RedisMeetingStateStore({ get: async () => null, del: async () => 0, call: async (...a) => { calls.push(a); return 1; } });
        const s = { meetingId: M, createdBy: null, version: 1, hands: [], breakout: {} as any, updatedAt: 'x' } as MeetingState;
        expect(await store.putIfVersion(s, 0)).toBe(true);
        expect(calls[0]!.slice(0, 3)).toEqual(['EVAL', MEETING_CAS_SCRIPT, 1]);
        expect(calls[0]![calls[0]!.length - 1]).toBe('');
        expect(store.watch(() => undefined)).toEqual(expect.any(Function));
        const bare = new RedisMeetingStateStore({ get: async () => null, del: async () => 0 });
        await expect(bare.putIfVersion(s, 0)).rejects.toThrow(/compare-and-set/);
    });
});

describe('MeetingService on a shared store', () => {
    it('two replicas raising hands at once both land: the loser re-reads and re-applies', async () => {
        const shared = new InMemoryMeetingStateStore();
        const { a, b } = replicas(() => yielding(shared));
        connectAs(a.router, 'c-a', 'u-a', 'Ana');
        connectAs(b.router, 'c-b', 'u-b', 'Ben');
        await a.svc.handleAction('c-a', 'subscribe', { meetingId: M });
        await b.svc.handleAction('c-b', 'subscribe', { meetingId: M });
        const v0 = (await shared.get(M))!.version;
        await Promise.all([
            a.svc.handleAction('c-a', 'hand.raise', { meetingId: M }),
            b.svc.handleAction('c-b', 'hand.raise', { meetingId: M }),
        ]);
        const s = (await shared.get(M))!;
        expect(s.hands.map((h) => h.userId).sort()).toEqual(['u-a', 'u-b']);
        expect(s.version).toBe(v0 + 2);
        expect(a.router.last('c-a', 'error')).toBeUndefined();
        expect(b.router.last('c-b', 'error')).toBeUndefined();
        a.svc.dispose(); b.svc.dispose();
    });

    it('a write that keeps losing gives up with CONFLICT instead of looping', async () => {
        const inner = new InMemoryMeetingStateStore();
        const store: MeetingStateStore = {
            get: (id) => inner.get(id), put: (s) => inner.put(s), delete: (id) => inner.delete(id),
            putIfVersion: async (s, v) => (s.version === 1 ? inner.putIfVersion(s, v) : false),
        };
        const router = fakeRouter();
        const svc = new MeetingService({ router, config: { store } });
        connectAs(router, 'c-a', 'u-a');
        await svc.handleAction('c-a', 'subscribe', { meetingId: M });
        await svc.handleAction('c-a', 'hand.raise', { meetingId: M });
        expect(router.last('c-a', 'error').error.code).toBe('CONFLICT');
        expect((await inner.get(M))!.hands).toEqual([]);
        svc.dispose();
    });

    it('a replica whose last subscriber leaves does not delete state another replica still serves', async () => {
        const { client, subscriber } = fakeRedis();
        const { a, b } = replicas(() => new RedisMeetingStateStore(client, { subscriber: subscriber() }));
        connectAs(a.router, 'c-a', 'u-a');
        connectAs(b.router, 'c-b', 'u-b');
        await a.svc.handleAction('c-a', 'subscribe', { meetingId: M });
        await b.svc.handleAction('c-b', 'subscribe', { meetingId: M });
        await a.svc.handleAction('c-a', 'unsubscribe', { meetingId: M });
        await a.svc.onClientDisconnect('c-a');
        const kept = await b.svc.getState(M);
        expect(kept).not.toBeNull();
        await b.svc.handleAction('c-b', 'hand.raise', { meetingId: M });
        // The version kept climbing, so B's clients accept the frame.
        expect(b.router.last('c-b', 'hands.changed').data.version).toBe(kept!.version + 1);
        a.svc.dispose(); b.svc.dispose();
    });

    it("a replica's synchronous lobby check follows rooms another replica opened", async () => {
        const { client, subscriber } = fakeRedis();
        const { a, b } = replicas(() => new RedisMeetingStateStore(client, { subscriber: subscriber() }));
        connectAs(a.router, 'c-org', 'u-org');
        connectAs(b.router, 'c-x', 'u-x');
        await a.svc.handleAction('c-org', 'subscribe', { meetingId: M });
        await b.svc.handleAction('c-x', 'subscribe', { meetingId: M });
        const lobby = breakoutLobbyName(M, 'r1');
        expect(b.svc.admitsBreakoutLobbySync('u-x', lobby)).toBe(false);
        await a.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', members: ['u-x'] }] });
        await a.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await flush();
        expect(b.svc.admitsBreakoutLobbySync('u-x', lobby)).toBe(true);
        a.svc.dispose(); b.svc.dispose();
    });

    it("the organizer may visit any room on a replica they never used; a hook's verdict stays local", async () => {
        const { client, subscriber } = fakeRedis();
        const { a, b } = replicas(() => new RedisMeetingStateStore(client, { subscriber: subscriber() }));
        connectAs(a.router, 'c-org', 'u-org');
        connectAs(b.router, 'c-x', 'u-x');
        await a.svc.handleAction('c-org', 'subscribe', { meetingId: M });
        await b.svc.handleAction('c-x', 'subscribe', { meetingId: M });
        await a.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1', members: ['u-x'] }, { id: 'r2' }], mode: 'assigned' });
        await a.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await flush();
        // B has never seen u-org act, yet knows them as the creator.
        expect(b.svc.admitsBreakoutLobbySync('u-org', breakoutLobbyName(M, 'r2'))).toBe(true);
        expect(b.svc.admitsBreakoutLobbySync('u-x', breakoutLobbyName(M, 'r2'))).toBe(false);
        a.svc.dispose(); b.svc.dispose();

        // With a hook, only the replica that ran it knows; the async guard asks.
        const shared = fakeRedis();
        const hook = { isOrganizer: ({ userId }: { userId: string }) => userId === 'u-org' };
        const h = replicas(() => new RedisMeetingStateStore(shared.client, { subscriber: shared.subscriber() }), hook);
        connectAs(h.a.router, 'c-org', 'u-org');
        connectAs(h.b.router, 'c-x', 'u-x');
        await h.a.svc.handleAction('c-org', 'subscribe', { meetingId: M });
        await h.b.svc.handleAction('c-x', 'subscribe', { meetingId: M });
        await h.a.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }], mode: 'assigned' });
        await h.a.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
        await flush();
        expect(h.b.svc.admitsBreakoutLobbySync('u-org', breakoutLobbyName(M, 'r1'))).toBe(false);
        expect(await h.b.svc.admitsBreakoutLobby('u-org', breakoutLobbyName(M, 'r1'))).toBe(true);
        h.a.svc.dispose(); h.b.svc.dispose();
    });

    it('every replica arms the breakout timer; exactly one close commits, even after the setter is gone', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
        try {
            let now = Date.parse('2026-10-16T12:00:00Z');
            jest.setSystemTime(now);
            const { client, subscriber } = fakeRedis();
            const { a, b, changes } = replicas(() => new RedisMeetingStateStore(client, { subscriber: subscriber() }), { now: () => now });
            connectAs(a.router, 'c-org', 'u-org');
            connectAs(b.router, 'c-x', 'u-x');
            await a.svc.handleAction('c-org', 'subscribe', { meetingId: M });
            await b.svc.handleAction('c-x', 'subscribe', { meetingId: M });
            await a.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
            await a.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
            await a.svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 60_000 });
            await flush();
            // Both replicas armed it: either alone would close the rooms.
            now += 60_000;
            jest.advanceTimersByTime(60_000);
            await flush();
            await jest.runOnlyPendingTimersAsync();
            await flush();
            const closes = changes.filter((c) => c.action === 'breakout.end' && c.userId === 'system');
            expect(closes).toHaveLength(1);
            expect((await b.svc.getState(M))!.breakout.phase).toBe('draft');
            a.svc.dispose(); b.svc.dispose();
        } finally {
            jest.useRealTimers();
        }
    });

    it('the timer still fires on a replica that only learned of it through watch', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
        try {
            let now = Date.parse('2026-10-16T12:00:00Z');
            jest.setSystemTime(now);
            const { client, subscriber } = fakeRedis();
            const { a, b, changes } = replicas(() => new RedisMeetingStateStore(client, { subscriber: subscriber() }), { now: () => now });
            connectAs(a.router, 'c-org', 'u-org');
            connectAs(b.router, 'c-x', 'u-x');
            await a.svc.handleAction('c-org', 'subscribe', { meetingId: M });
            await b.svc.handleAction('c-x', 'subscribe', { meetingId: M });
            await a.svc.handleAction('c-org', 'breakout.configure', { meetingId: M, rooms: [{ id: 'r1' }] });
            await a.svc.handleAction('c-org', 'breakout.open', { meetingId: M });
            await a.svc.handleAction('c-org', 'breakout.timer', { meetingId: M, durationMs: 60_000 });
            await flush();
            a.svc.dispose(); // the replica that set the timer goes away
            now += 60_000;
            jest.advanceTimersByTime(60_000);
            await flush();
            await jest.runOnlyPendingTimersAsync();
            await flush();
            expect(changes.filter((c) => c.action === 'breakout.end' && c.userId === 'system').map((c) => c.replica)).toEqual(['b']);
            expect(b.router.last('c-x', 'breakout.changed').data.breakout.phase).toBe('draft');
            b.svc.dispose();
        } finally {
            jest.useRealTimers();
        }
    });
});
