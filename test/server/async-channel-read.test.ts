import { LocalRealtimeRouter } from '../../src/server';
import { ChatService, InMemoryChatStore, MemoryChatReadReceiptStore, MemoryChatMembershipStore, type ChatMessage, type ChatMembershipStore } from '../../src/chat';
import { PresenceService } from '../../src/presence';
import type { WsAuthContext, WsHandlerHandle } from '../../src/server-ws';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
const channel = 'chat:dm:alice:bob';
const message: ChatMessage = { id: 'm1', clientId: 'bob', userId: 'bob', channel, message: 'private text', timestamp: new Date().toISOString() };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function harness(membershipStore?: ChatMembershipStore) {
    let readable = true;
    let writable = true;
    const frames: any[] = [];
    const contexts: Record<string, WsAuthContext> = { alice: { userId: 'alice' }, bob: { userId: 'bob' } };
    const router = new LocalRealtimeRouter({ authorize: async ({ kind }) => kind === 'subscribe' ? readable : writable });
    const handle: WsHandlerHandle = { wss: {}, dispose: async () => undefined, listClients: () => Object.keys(contexts),
        getClientContext: id => contexts[id] ?? null, sendToClient: (id, frame) => { frames.push({ id, ...frame }); return true; } };
    router._setHandle(handle);
    const store = new InMemoryChatStore();
    const receipts = new MemoryChatReadReceiptStore();
    const onDm = jest.fn();
    const chat = new ChatService({ messageRouter: router, chatStore: store, membershipStore, readReceiptStore: receipts, logger, onDmMessage: onDm });
    return { router, store, chat, receipts, frames, onDm, contexts, revokeRead: () => { readable = false; }, revokeWrite: () => { writable = false; } };
}

describe('direct replies reauthorize after asynchronous reads', () => {
    test.each(['history', 'join'])('revocation during %s storage does not reveal history or keep a joined seat', async action => {
        const h = harness();
        const pending = deferred<ChatMessage[]>();
        const started = deferred<void>();
        jest.spyOn(h.store, 'listMessages').mockImplementation(async () => { started.resolve(); return pending.promise; });
        const read = h.chat.handleAction('alice', action, { channel });
        await started.promise;
        h.revokeRead(); pending.resolve([message]);
        await read;
        expect(h.frames.some(f => f.action === 'history')).toBe(false);
        expect(h.frames.some(f => f.code === 'AUTHZ_CHANNEL_DENIED')).toBe(true);
        h.frames.length = 0;
        await h.router.sendToChannel(channel, { secret: true });
        expect(h.frames).toEqual([]);
        await h.chat.shutdown();
    });

    test('a replacement actor with the same user cannot receive an older pending history response', async () => {
        const h = harness();
        const pending = deferred<ChatMessage[]>(); const started = deferred<void>();
        jest.spyOn(h.store, 'listMessages').mockImplementation(async () => { started.resolve(); return pending.promise; });
        const read = h.chat.handleAction('alice', 'history', { channel });
        await started.promise;
        h.contexts.alice = { userId: 'alice', act: { sub: 'other-admin', epoch: 2 } };
        pending.resolve([message]); await read;
        expect(h.frames.some(f => f.action === 'history')).toBe(false);
        await h.chat.shutdown();
    });

    test.each(['history', 'join', 'replacement'] as const)('pending %s cannot disclose broader history after a tighter membership boundary', async action => {
        const membership = new MemoryChatMembershipStore();
        const room = 'room:private';
        const row = { channel: room, userId: 'alice', role: 'member' as const, addedBy: 'bob', addedAt: '2026-01-01T00:00:00.000Z', historyFrom: null, removedAt: null };
        await membership.putMember(row);
        const h = harness(membership);
        await h.store.putMessage({ ...message, channel: room, id: 'old', timestamp: '2026-01-01T01:00:00.000Z' });
        await h.store.putMessage({ ...message, channel: room, id: 'new', timestamp: '2026-01-03T01:00:00.000Z' });
        const ready = deferred<void>(); const release = deferred<void>();
        const fetch = h.chat.getChannelHistoryFor.bind(h.chat);
        jest.spyOn(h.chat, 'getChannelHistoryFor').mockImplementation(async (...args) => {
            const fetched = await fetch(...args);
            expect(fetched.map(m => m.id)).toEqual(['old', 'new']);
            ready.resolve(); await release.promise; return fetched;
        });
        const read = h.chat.handleAction('alice', action === 'join' ? 'join' : 'history', { channel: room });
        await ready.promise;
        // A remove/re-add under the same authenticated actor changes the
        // history entitlement even though the connection context is stable.
        await membership.putMember({ ...row, removedAt: '2026-01-02T00:00:00.000Z' });
        await membership.putMember({ ...row, addedAt: '2026-01-02T00:00:00.001Z', historyFrom: '2026-01-02T00:00:00.001Z' });
        if (action === 'replacement') h.contexts.alice = { userId: 'alice', act: { sub: 'replacement-admin', epoch: 2 } };
        release.resolve(); await read;
        const replies = h.frames.filter(f => f.action === 'history');
        if (action === 'replacement') expect(replies).toEqual([]);
        else expect(replies.map(f => f.messages.map((m: ChatMessage) => m.id))).toEqual([['new']]);
        await h.chat.shutdown();
    });

    test('revocation during members read returns no roster', async () => {
        const h = harness();
        const pending = deferred<{ open: boolean; members: any[] }>();
        const started = deferred<void>();
        jest.spyOn(h.chat, 'describeMembers').mockImplementation(async () => { started.resolve(); return pending.promise; });
        const read = h.chat.handleAction('alice', 'members', { channel });
        await started.promise;
        h.revokeRead(); pending.resolve({ open: false, members: [{ userId: 'bob', displayName: 'Private Bob' }] });
        await read;
        expect(h.frames.some(f => f.action === 'members')).toBe(false);
        await h.chat.shutdown();
    });

    test('revocation during receipts read returns no cursors', async () => {
        const h = harness();
        const pending = deferred<any[]>(); const started = deferred<void>();
        jest.spyOn(h.receipts, 'listReceipts').mockImplementation(async () => { started.resolve(); return pending.promise; });
        const read = h.chat.handleAction('alice', 'receipts', { channel });
        await started.promise; h.revokeRead();
        pending.resolve([{ channel, userId: 'bob', readAt: message.timestamp, updatedAt: message.timestamp }]);
        await read;
        expect(h.frames.some(f => f.action === 'receipts')).toBe(false);
        await h.chat.shutdown();
    });

    test('presence get and subscription snapshots require final read authority', async () => {
        const h = harness();
        const presence = new PresenceService(h.router, logger, { heartbeatIntervalMs: 60_000, cleanupIntervalMs: 60_000 });
        await presence.handleAction('bob', 'set', { status: 'online', channels: [channel] });
        h.frames.length = 0;
        let asks = 0;
        jest.spyOn(h.router, 'checkChannel').mockImplementation(async () => ++asks === 1);
        await presence.handleAction('alice', 'get', { channel });
        expect(h.frames.some(f => f.action === 'presence')).toBe(false);
        asks = 0; h.frames.length = 0;
        await presence.handleAction('alice', 'subscribe', { channel });
        expect(h.frames.some(f => f.action === 'subscribed')).toBe(false);
        await presence.shutdown(); await h.chat.shutdown();
    });
});

describe('durable send receipts', () => {
    test('rejected persistence emits one author failure and no peer message, cache, or observer', async () => {
        const h = harness();
        await h.chat.handleAction('alice', 'join', { channel });
        await h.chat.handleAction('bob', 'join', { channel });
        h.frames.length = 0;
        jest.spyOn(h.store, 'putMessage').mockRejectedValueOnce(new Error('Dynamo unavailable'));
        await h.chat.handleAction('alice', 'send', { channel, message: 'keep my draft' });
        expect(h.frames).toHaveLength(1);
        expect(h.frames[0]).toMatchObject({ id: 'alice', type: 'error', error: { code: 'store-failed' } });
        expect(await h.chat.getChannelHistory(channel, 50)).toEqual([]);
        expect(h.onDm).not.toHaveBeenCalled();
        await h.chat.shutdown();
    });

    test('authority lost while persistence commits produces no publication or success receipt', async () => {
        const h = harness();
        await h.chat.handleAction('alice', 'join', { channel });
        await h.chat.handleAction('bob', 'join', { channel });
        h.frames.length = 0;
        const commit = deferred<void>(); const started = deferred<void>();
        const persist = h.store.putMessage.bind(h.store);
        jest.spyOn(h.store, 'putMessage').mockImplementation(async record => { started.resolve(); await commit.promise; await persist(record); });
        const send = h.chat.handleAction('alice', 'send', { channel, message: 'pending commit' });
        await started.promise; h.revokeWrite(); commit.resolve(); await send;
        expect(h.frames.some(f => f.type === 'chat' && ['message', 'sent'].includes(f.action))).toBe(false);
        expect(h.frames.some(f => f.id === 'alice' && f.code === 'AUTHZ_CHANNEL_DENIED')).toBe(true);
        expect(h.onDm).not.toHaveBeenCalled();
        // Commit and authority live in different stores: this is deliberately
        // not a rollback/exactly-once claim for an already durable record.
        expect(await h.store.listMessages(channel, 50)).toHaveLength(1);
        await h.chat.shutdown();
    });

    test.each(['commit', 'reject'] as const)('a replacement actor cannot receive or publish an earlier pending send after store %s', async result => {
        const h = harness();
        await h.chat.handleAction('alice', 'join', { channel });
        await h.chat.handleAction('bob', 'join', { channel });
        h.frames.length = 0;
        const commit = deferred<void>(); const started = deferred<void>();
        const persist = h.store.putMessage.bind(h.store);
        jest.spyOn(h.store, 'putMessage').mockImplementation(async record => {
            started.resolve(); await commit.promise;
            if (result === 'reject') throw new Error('storage unavailable');
            await persist(record);
        });
        const send = h.chat.handleAction('alice', 'send', { channel, message: 'old actor draft' });
        await started.promise;
        h.contexts.alice = { userId: 'alice', act: { sub: 'replacement-admin', epoch: 2 } };
        commit.resolve(); await send;
        expect(h.frames).toEqual([]);
        expect(h.onDm).not.toHaveBeenCalled();
        expect(await h.store.listMessages(channel, 50)).toHaveLength(result === 'commit' ? 1 : 0);
        await h.chat.shutdown();
    });

    test('a rejected system-message write is neither cached nor published', async () => {
        const h = harness();
        await h.router.subscribeToChannel('alice', channel);
        jest.spyOn(h.store, 'putMessage').mockRejectedValueOnce(new Error('Dynamo unavailable'));
        expect(await h.chat.postSystemMessage(channel, 'failed event')).toBeNull();
        expect(h.frames).toEqual([]);
        expect(await h.chat.getChannelHistory(channel, 50)).toEqual([]);
        await h.chat.shutdown();
    });
});
