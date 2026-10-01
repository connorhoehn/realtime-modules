// A dropped participant's fresh socket takes its seat back on
// `participant-state` (aws-agentcore capacity review 2026-10-01, change #4).
// Socket-level coverage is test/server/calls-rejoin.test.ts; this suite pins
// the default 30 s grace with fake timers, and the store path where the seat
// was taken on another node (the rejoining node has no local record).

import { CallService } from '../../src/call/CallService';
import { InMemoryCallStateStore, RedisCallStateStore, type CallStateStore } from '../../src/call/CallStateStore';
import { FakeRedis } from './helpers/fakeRedis';

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as any;

interface Sent { clientId: string; message: any }

function makeRouter(userByClient: Record<string, string>) {
    const sent: Sent[] = [];
    const router = {
        sent,
        sendToClient(clientId: string, message: any) { sent.push({ clientId, message }); return true; },
        broadcastToAll() { return undefined; },
        getClientsByUserId(userIds: string[], exclude?: string) {
            return Object.entries(userByClient)
                .filter(([cid, uid]) => cid !== exclude && userIds.includes(uid))
                .map(([clientId, userId]) => ({ clientId, userId }));
        },
        getUserIdForClient(clientId: string) { return userByClient[clientId] ?? null; },
    };
    return router;
}

const users: Record<string, string> = {
    'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-bob2': 'u-bob',
    'c-carol': 'u-carol', 'c-dave': 'u-dave', 'c-eve': 'u-eve',
};
const LOBBY = 'acme:dm:u-alice:u-bob';

async function establish(svc: CallService, callId: string, lobbyName: string, caller: [string, string], callees: Array<[string, string]>) {
    await svc.handleCallEvent(caller[0], 'invite', {
        callId, lobbyName, callerId: caller[1], targetUserIds: callees.map(([, u]) => u),
    });
    for (const [cid, uid] of callees) {
        await svc.handleCallEvent(cid, 'accepted', { callId, lobbyName, callerId: uid, userId: uid, targetUserIds: [caller[1]] });
    }
}

const announce = (svc: CallService, clientId: string, callId: string, lobbyName: string, peers: string[]) =>
    svc.handleCallEvent(clientId, 'participant-state', {
        callId, lobbyName, callerId: users[clientId], userId: users[clientId], status: 'in-call', targetUserIds: peers,
    } as any);

const endedTo = (sent: Sent[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message?.action === 'ended');

describe('CallService — rejoin on participant-state (default 30 s grace, fake timers)', () => {
    afterEach(() => { jest.useRealTimers(); });

    test.each<[string, () => CallStateStore | undefined]>([
        ['no store', () => undefined],
        ['InMemoryCallStateStore', () => new InMemoryCallStateStore()],
        ['RedisCallStateStore (Redis double)', () => new RedisCallStateStore(new FakeRedis() as any)],
    ])('1:1 (%s): drop, reconnect 2 s later, re-announce → no ended at 30 s; status lists both', async (_n, make) => {
        jest.useFakeTimers();
        const router = makeRouter(users);
        const svc = new CallService({ messageRouter: router as any, logger: quiet, stateStore: make() });
        await establish(svc, 'call-1', LOBBY, ['c-alice', 'u-alice'], [['c-bob', 'u-bob']]);
        await svc.handleDisconnect('c-bob');
        await jest.advanceTimersByTimeAsync(2_000);

        await svc.handleCallEvent('c-bob2', 'status', { lobbyName: LOBBY });
        await announce(svc, 'c-bob2', 'call-1', LOBBY, ['u-alice']);
        router.sent.length = 0;
        await jest.advanceTimersByTimeAsync(31_000);
        expect(endedTo(router.sent, 'c-alice')).toHaveLength(0);

        await svc.handleCallEvent('c-eve', 'status', { lobbyName: LOBBY });
        const reply = router.sent.find((s) => s.clientId === 'c-eve' && s.message.action === 'active-call')!.message.data;
        expect(reply).toMatchObject({ active: true, callId: 'call-1', participantCount: 2 });
        expect([...reply.participantUserIds].sort()).toEqual(['u-alice', 'u-bob']);
        await svc.dispose();
    });

    test('group of four: the reconnected member is back on the roster', async () => {
        jest.useFakeTimers();
        const router = makeRouter(users);
        const svc = new CallService({ messageRouter: router as any, logger: quiet, stateStore: new InMemoryCallStateStore() });
        const lobby = 'acme:room:standup';
        await establish(svc, 'call-g', lobby, ['c-alice', 'u-alice'], [['c-bob', 'u-bob'], ['c-carol', 'u-carol'], ['c-dave', 'u-dave']]);
        await svc.handleDisconnect('c-bob');
        await jest.advanceTimersByTimeAsync(2_000);
        await announce(svc, 'c-bob2', 'call-g', lobby, ['u-alice', 'u-carol', 'u-dave']);
        await jest.advanceTimersByTimeAsync(31_000);
        router.sent.length = 0;
        await svc.handleCallEvent('c-eve', 'status', { lobbyName: lobby });
        const reply = router.sent.find((s) => s.message.action === 'active-call')!.message.data;
        expect(reply.participantCount).toBe(4);
        expect([...reply.participantUserIds].sort()).toEqual(['u-alice', 'u-bob', 'u-carol', 'u-dave']);
        await svc.dispose();
    });

    test('refused: a user who never held a seat announcing into the call does not save it', async () => {
        jest.useFakeTimers();
        const router = makeRouter(users);
        const svc = new CallService({ messageRouter: router as any, logger: quiet, stateStore: new InMemoryCallStateStore() });
        await establish(svc, 'call-1', LOBBY, ['c-alice', 'u-alice'], [['c-bob', 'u-bob']]);
        await svc.handleDisconnect('c-bob');
        await announce(svc, 'c-eve', 'call-1', LOBBY, ['u-alice']);
        router.sent.length = 0;
        await jest.advanceTimersByTimeAsync(31_000);
        expect(endedTo(router.sent, 'c-alice').map((s) => s.message.data.reason)).toEqual(['rejoin-grace-expired']);
        expect(endedTo(router.sent, 'c-eve')).toHaveLength(0);
        await svc.dispose();
    });
});

describe('CallService — rejoin on another node (the seat is only in the shared store)', () => {
    afterEach(() => { jest.useRealTimers(); });

    test.each<[string, () => CallStateStore]>([
        ['InMemoryCallStateStore', () => new InMemoryCallStateStore()],
        ['RedisCallStateStore (Redis double)', () => new RedisCallStateStore(new FakeRedis() as any)],
    ])('%s: node B re-seats bob from the store; node A\'s grace finds two and keeps the call', async (_n, make) => {
        jest.useFakeTimers();
        const store = make();
        const router = makeRouter(users);
        const nodeA = new CallService({ messageRouter: router as any, logger: quiet, stateStore: store });
        const nodeB = new CallService({ messageRouter: router as any, logger: quiet, stateStore: store });
        await establish(nodeA, 'call-x', LOBBY, ['c-alice', 'u-alice'], [['c-bob', 'u-bob']]);
        await jest.advanceTimersByTimeAsync(10); // fire-and-forget store mirrors
        await nodeA.handleDisconnect('c-bob');
        await jest.advanceTimersByTimeAsync(2_000);

        await announce(nodeB, 'c-bob2', 'call-x', LOBBY, ['u-alice']);
        expect((await store.getCall('call-x'))!.participantClientIds.sort()).toEqual(['c-alice', 'c-bob2']);

        router.sent.length = 0;
        await jest.advanceTimersByTimeAsync(31_000);
        expect(endedTo(router.sent, 'c-alice')).toHaveLength(0);
        expect(await store.getCall('call-x')).not.toBeNull();

        // A stranger on node B gets nothing from the store path either.
        await announce(nodeB, 'c-eve', 'call-x', LOBBY, ['u-alice']);
        expect((await store.getCall('call-x'))!.participantClientIds).not.toContain('c-eve');
        await nodeA.dispose();
        await nodeB.dispose();
    });
});
