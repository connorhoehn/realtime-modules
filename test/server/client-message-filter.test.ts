import { LocalRealtimeRouter, type ClientMessageFilter } from '../../src/server';
import type { WsAuthContext, WsHandlerHandle } from '../../src/server-ws';
import { NotificationService } from '../../src/notification/NotificationService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) };
}
function harness(filterClientMessage?: ClientMessageFilter) {
    const contexts = new Map<string, WsAuthContext>([['a', { userId: 'alice' }], ['b', { userId: 'bob' }]]);
    const frames: Array<{ clientId: string; frame: unknown }> = [];
    const router = new LocalRealtimeRouter({ filterClientMessage });
    const handle: WsHandlerHandle = { wss: {}, dispose: async () => undefined,
        listClients: () => [...contexts.keys()], getClientContext: id => contexts.get(id) ?? null,
        sendToClient: (clientId, frame) => { if (!contexts.has(clientId)) return false; frames.push({ clientId, frame }); return true; } };
    router._setHandle(handle);
    return { router, contexts, frames, handle };
}
test('keeps the synchronous unfiltered path and local delivery', () => {
    const h = harness();
    expect(h.router.sendToClient('a', { data: 1 })).toBe(true);
    expect(h.router.sendToLocalClient('b', { data: 2 })).toBe(true);
    expect(h.frames).toHaveLength(2);
});
test.each(['null', 'throw', 'reject'])('fails closed on %s without rejecting the send', async mode => {
    const h = harness(() => { if (mode === 'throw') throw new Error('offline');
        return mode === 'reject' ? Promise.reject(new Error('offline')) : null; });
    expect(await h.router.sendToClient('a', { secret: true })).toBe(false);
    expect(h.frames).toEqual([]);
});
test.each(['disconnect', 'actor', 'handle'])('discards an awaited result after %s replacement', async mode => {
    const pending = deferred<unknown>(); const h = harness(() => pending.promise);
    const send = h.router.sendToClient('a', { secret: true });
    if (mode === 'disconnect') h.contexts.delete('a');
    if (mode === 'actor') h.contexts.set('a', { userId: 'alice', act: { sub: 'different-operator' } });
    if (mode === 'handle') h.router._setHandle(harness().handle);
    pending.resolve({ secret: true }); expect(await send).toBe(false); expect(h.frames).toEqual([]);
});
test('filters each broadcast independently and awaits all recipients', async () => {
    const waiting = deferred<unknown>();
    const h = harness(({ clientId, message }) => clientId === 'a' ? waiting.promise : message);
    let finished = false; const send = h.router.broadcastToAll({ secret: true }).then(() => { finished = true; });
    await Promise.resolve(); expect(h.frames.map(row => row.clientId)).toEqual(['b']); expect(finished).toBe(false);
    waiting.resolve(null); await send; expect(h.frames.map(row => row.clientId)).toEqual(['b']);
});
test('passes channel fanout through the same filter and never mutates a peer frame', async () => {
    const input = { rows: ['private', 'public'] };
    const h = harness(({ clientId, message }) => clientId === 'a' ? { rows: ['public'] } : message);
    h.router.subscribeToChannel('a', 'room'); h.router.subscribeToChannel('b', 'room');
    await h.router.sendToChannel('room', input);
    expect(h.frames).toEqual([{ clientId: 'a', frame: { rows: ['public'] } }, { clientId: 'b', frame: input }]);
    expect(input.rows).toEqual(['private', 'public']);
});
test.each(['unsubscribe', 'resubscribe'])('preserves the channel generation fence through a delayed filter and %s', async mode => {
    const pending = deferred<unknown>(), started = deferred<void>(); let delayed = true;
    const h = harness(({ message }) => { if (!delayed) return message; started.resolve(); return pending.promise; });
    h.router.subscribeToChannel('a', 'room');
    const delivery = h.router.sendToChannel('room', { old: true }); await started.promise;
    h.router.unsubscribeFromChannel('a', 'room');
    if (mode === 'resubscribe') h.router.subscribeToChannel('a', 'room');
    pending.resolve({ old: true }); await delivery; expect(h.frames).toEqual([]);
    delayed = false;
    if (mode === 'resubscribe') { await h.router.sendToChannel('room', { fresh: true }); expect(h.frames).toEqual([{ clientId: 'a', frame: { fresh: true } }]); }
});
test('notification actions wait for authorization before any store work and rejected authority refuses', async () => {
    const h = harness(); const waiting = deferred<boolean>();
    const store = { list: jest.fn(async () => []), markRead: jest.fn(async () => undefined), markAllRead: jest.fn(async () => []) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const service = new NotificationService({ messageRouter: h.router as any, logger, store: store as any, authorize: () => waiting.promise });
    const action = service.handleAction('a', 'markRead', { id: 'private-id', userId: 'bob' });
    expect(store.markRead).not.toHaveBeenCalled(); waiting.resolve(false); await action;
    expect(store.markRead).not.toHaveBeenCalled(); expect(h.frames[0].frame).toMatchObject({ code: 'AUTHZ_NOTIFICATION_DENIED' });
    const allowed = new NotificationService({ messageRouter: h.router as any, logger, store: store as any, authorize: async () => true });
    await allowed.handleAction('a', 'markRead', { id: 'private-id', userId: 'bob' });
    expect(store.markRead).toHaveBeenCalledWith('alice', 'private-id');
    const offline = new NotificationService({ messageRouter: h.router as any, logger, store: store as any, authorize: async () => { throw new Error('offline'); } });
    await offline.handleAction('a', 'getHistory', {}); await offline.handleAction('a', 'markAllRead', {});
    expect(store.list).not.toHaveBeenCalled(); expect(store.markAllRead).not.toHaveBeenCalled();
});
test('notification delivered counts omit filtered clients while preserving the stored record', async () => {
    const h = harness(() => null);
    const store = { append: jest.fn(async () => undefined) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const service = new NotificationService({ messageRouter: h.router as any, logger, store: store as any });
    const result = await service.notifyUser('alice', { type: 'system', title: 'Private record' });
    expect(result.delivered).toBe(0); expect(h.frames).toEqual([]);
    expect(store.append).toHaveBeenCalledWith('alice', expect.objectContaining({ id: result.record.id, title: 'Private record' }));
});
