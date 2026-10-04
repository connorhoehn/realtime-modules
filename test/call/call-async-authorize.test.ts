import { CallService, InMemoryCallStateStore, type CallConfig } from '../../src/call';
import { calls, LocalRealtimeRouter } from '../../src/server';
import type { WsAuthContext, WsHandlerHandle } from '../../src/server-ws';

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const lobbyName = 'social:dm:alice:bob';
const invite = { callId: 'async-auth-call', callerId: 'alice', lobbyName, targetUserIds: ['bob'] };

function harness(authorize: CallConfig['authorize'], wrapped = false) {
    const state = new InMemoryCallStateStore();
    const contexts: Record<string, WsAuthContext> = { alice: { userId: 'alice', org: 'social' }, bob: { userId: 'bob', org: 'social' } };
    const frames: any[] = [];
    const router = new LocalRealtimeRouter();
    const handle: WsHandlerHandle = { wss: {}, dispose: async () => undefined, listClients: () => Object.keys(contexts),
        getClientContext: id => contexts[id] ?? null, sendToClient: (id, frame) => { frames.push({ id, ...frame }); return true; } };
    router._setHandle(handle);
    const onInvite = jest.fn(() => true);
    const guard = jest.fn(() => true);
    const config: CallConfig = { authorize, canCall: onInvite };
    const service = wrapped
        ? calls({ stateStore: state, config, lobbyGuard: guard }).create({ router, logger }) as CallService
        : new CallService({ messageRouter: router as any, logger, stateStore: state, config });
    return { service, state, frames, onInvite, guard, contexts };
}

describe('public awaited call authorization', () => {
    test.each([false, true])('denied/rejected asynchronous callbacks cannot mutate or route (attach wrapper=%s)', async wrapped => {
        for (const mode of ['false', 'reject', 'throw'] as const) {
            const h = harness(() => {
                if (mode === 'throw') throw new Error('identity unavailable');
                return mode === 'false' ? Promise.resolve(false) : Promise.reject(new Error('identity unavailable'));
            }, wrapped);
            const register = jest.spyOn(h.state, 'registerParticipant');
            const read = jest.spyOn(h.state, 'getCall');
            for (const action of ['invite', 'status', 'participant-state']) {
                await h.service.handleAction('alice', action, invite);
            }
            expect(register).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            expect(h.onInvite).not.toHaveBeenCalled();
            expect(h.frames).toHaveLength(3);
            expect(h.frames.every(f => f.id === 'alice' && f.type === 'error')).toBe(true);
            if (wrapped) expect(h.guard).not.toHaveBeenCalled();
            expect(await h.state.stats()).toEqual({ activeCalls: 0, trackedClients: 0 });
            await h.service.dispose();
        }
    });

    test.each([false, true])('true callback preserves normal invite behavior (async=%s)', async asynchronous => {
        const h = harness(() => asynchronous ? Promise.resolve(true) : true, true);
        await h.service.handleAction('alice', 'invite', invite);
        expect(await h.state.getCall(invite.callId)).toMatchObject({ callerId: 'alice', lobbyName, participantClientIds: ['alice'] });
        expect(h.frames.some(f => f.id === 'bob' && f.action === 'invite')).toBe(true);
        expect(h.guard).toHaveBeenCalledTimes(1);
        expect(h.onInvite).toHaveBeenCalledTimes(1);
        await h.service.dispose();
    });

    test('a replacement actor under the same client ID cannot use pending source authority', async () => {
        let resolve!: (value: boolean) => void;
        const pending = new Promise<boolean>(r => { resolve = r; });
        const h = harness(() => pending, true);
        const operation = h.service.handleAction('alice', 'invite', invite);
        await Promise.resolve();
        h.contexts.alice = { userId: 'different-actor', org: 'social' };
        resolve(true); await operation;
        expect(await h.state.getCall(invite.callId)).toBeNull();
        expect(h.frames.some(f => f.id === 'bob')).toBe(false);
        await h.service.dispose();
    });

    test('pending authorization must resolve before any call mutation', async () => {
        let resolve!: (value: boolean) => void;
        const pending = new Promise<boolean>(r => { resolve = r; });
        const h = harness(() => pending, true);
        const operation = h.service.handleAction('alice', 'invite', invite);
        await Promise.resolve();
        expect(await h.state.getCall(invite.callId)).toBeNull();
        expect(h.frames).toEqual([]);
        resolve(false); await operation;
        expect(await h.state.getCall(invite.callId)).toBeNull();
        await h.service.dispose();
    });
});
