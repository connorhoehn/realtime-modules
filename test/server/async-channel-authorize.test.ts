import { LocalRealtimeRouter, type ChannelAuthorize } from '../../src/server';
import type { WsAuthContext, WsHandlerHandle } from '../../src/server-ws';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function harness(authorize?: ChannelAuthorize) {
    const contexts = new Map<string, WsAuthContext>([['alice', { userId: 'alice' }], ['bob', { userId: 'bob' }]]);
    const frames: Array<{ clientId: string; frame: unknown }> = [];
    const messages = jest.fn();
    const connections = jest.fn();
    const router = new LocalRealtimeRouter({ authorize, plugins: [{ name: 'observe', onMessage: messages, onConnect: connections }] });
    const handle: WsHandlerHandle = {
        wss: {}, dispose: async () => undefined,
        listClients: () => [...contexts.keys()], getClientContext: id => contexts.get(id) ?? null,
        sendToClient: (clientId, frame) => { if (!contexts.has(clientId)) return false; frames.push({ clientId, frame }); return true; },
    };
    router._setHandle(handle);
    return { router, contexts, frames, messages, connections };
}

describe('public async channel authorization and delivery', () => {
    test('synchronous and absent predicates preserve synchronous admission', () => {
        for (const authorize of [undefined, () => true]) {
            const h = harness(authorize);
            expect(h.router.checkChannel('subscribe', 'alice', 'social:dm:alice:bob')).toBe(true);
            expect(h.router.subscribeToChannel('alice', 'social:dm:alice:bob')).toBe(true);
            expect(h.connections).toHaveBeenCalledTimes(1);
        }
    });

    test.each(['false', 'reject', 'throw'] as const)('async %s refuses subscription and direct read without success/plugin', async mode => {
        const h = harness(() => {
            if (mode === 'throw') throw new Error('authority unavailable');
            return mode === 'false' ? Promise.resolve(false) : Promise.reject(new Error('authority unavailable'));
        });
        expect(await h.router.subscribeToChannel('alice', 'social:dm:alice:bob')).toBe(false);
        expect(await h.router.checkChannel('subscribe', 'alice', 'social:dm:alice:bob')).toBe(false);
        expect(h.connections).not.toHaveBeenCalled();
        h.frames.length = 0;
        await h.router.sendToChannel('social:dm:alice:bob', { secret: true });
        expect(h.frames).toEqual([]);
    });

    test.each(['unsubscribe', 'disconnect'] as const)('late %s cancels pending subscription instead of recreating it', async mode => {
        const pending = deferred<boolean>();
        const h = harness(() => pending.promise);
        const admission = h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        if (mode === 'unsubscribe') h.router.unsubscribeFromChannel('alice', 'social:dm:alice:bob');
        else { h.contexts.delete('alice'); h.router.removeClient('alice'); }
        pending.resolve(true);
        expect(await admission).toBe(false);
        expect(h.connections).not.toHaveBeenCalled();
        await h.router.sendToChannel('social:dm:alice:bob', { secret: true });
        expect(h.frames).toEqual([]);
    });

    test('read revocation suppresses existing subscriptions including server-origin updates', async () => {
        const revoked = new Set<string>();
        const h = harness(async ({ clientId }) => !revoked.has(clientId));
        await h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        await h.router.subscribeToChannel('bob', 'social:dm:alice:bob');
        revoked.add('bob');
        await h.router.sendToChannel('social:dm:alice:bob', { secret: true });
        expect(h.frames.map(x => x.clientId)).toEqual(['alice']);
        expect(h.messages).toHaveBeenCalledTimes(1);
        expect(h.messages.mock.calls[0][0].clientId).toBe('server');
    });

    test('publish revocation suppresses fanout and observers even when recipients still read', async () => {
        let writable = true;
        const h = harness(async ({ kind }) => kind === 'subscribe' || writable);
        await h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        writable = false;
        await h.router.sendToChannel('social:dm:alice:bob', { secret: true }, null, { publisherClientId: 'alice' });
        expect(h.frames).toEqual([]);
        expect(h.messages).not.toHaveBeenCalled();
    });

    test.each(['unsubscribe', 'disconnect'] as const)('late recipient %s suppresses delivery after awaited authorization', async mode => {
        const pending = deferred<boolean>();
        let delayed = false;
        const h = harness(() => delayed ? pending.promise : true);
        h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        delayed = true;
        const delivery = h.router.sendToChannel('social:dm:alice:bob', { secret: true });
        if (mode === 'unsubscribe') h.router.unsubscribeFromChannel('alice', 'social:dm:alice:bob');
        else { h.contexts.delete('alice'); h.router.removeClient('alice'); }
        pending.resolve(true);
        await delivery;
        expect(h.frames).toEqual([]);
    });

    test('rejected recipient does not fail or delay delivery to an allowed peer', async () => {
        let delivering = false;
        const h = harness(({ clientId }) => delivering && clientId === 'bob' ? Promise.reject(new Error('directory offline')) : Promise.resolve(true));
        await h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        await h.router.subscribeToChannel('bob', 'social:dm:alice:bob');
        delivering = true;
        await expect(h.router.sendToChannel('social:dm:alice:bob', { secret: true })).resolves.toBeUndefined();
        expect(h.frames.map(x => x.clientId)).toEqual(['alice']);
    });

    test.each(['check', 'subscribe', 'fanout'] as const)('same client ID with a replacement actor cannot reuse pending %s authority', async operation => {
        const pending = deferred<boolean>();
        let delayed = false;
        const h = harness(() => delayed ? pending.promise : true);
        if (operation === 'fanout') h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        delayed = true;
        const result = operation === 'check' ? h.router.checkChannel('subscribe', 'alice', 'social:dm:alice:bob', { silent: true })
            : operation === 'subscribe' ? h.router.subscribeToChannel('alice', 'social:dm:alice:bob')
                : h.router.sendToChannel('social:dm:alice:bob', { secret: true });
        h.contexts.set('alice', { userId: 'replacement-actor', act: { sub: 'new-admin', epoch: 2 } });
        pending.resolve(true);
        const value = await result;
        if (operation !== 'fanout') expect(value).toBe(false);
        expect(h.frames.some(x => (x.frame as any).secret)).toBe(false);
        if (operation === 'subscribe') expect(h.connections).not.toHaveBeenCalled();
    });

    test('unsubscribe then resubscribe fences the older in-flight fanout', async () => {
        const pending = deferred<boolean>(); let delayed = false;
        const h = harness(() => delayed ? pending.promise : true);
        h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        delayed = true;
        const delivery = h.router.sendToChannel('social:dm:alice:bob', { oldSecret: true });
        h.router.unsubscribeFromChannel('alice', 'social:dm:alice:bob');
        delayed = false;
        h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        pending.resolve(true); await delivery;
        expect(h.frames).toEqual([]);
        await h.router.sendToChannel('social:dm:alice:bob', { newSecret: true });
        expect(h.frames).toEqual([{ clientId: 'alice', frame: { newSecret: true } }]);
    });

    test('allow-all fanout keeps echoes, exclusions, and observer sender identity', async () => {
        const h = harness(async () => true);
        await h.router.subscribeToChannel('alice', 'social:dm:alice:bob');
        await h.router.subscribeToChannel('bob', 'social:dm:alice:bob');
        await h.router.sendToChannel('social:dm:alice:bob', { text: 'hello' }, null, { publisherClientId: 'alice' });
        expect(h.frames.map(x => x.clientId)).toEqual(['alice', 'bob']);
        expect(h.messages.mock.calls[0][0]).toMatchObject({ clientId: 'alice', userId: 'alice' });
        h.frames.length = 0;
        await h.router.sendToChannel('social:dm:alice:bob', { text: 'typing' }, 'alice');
        expect(h.frames.map(x => x.clientId)).toEqual(['bob']);
    });
});
