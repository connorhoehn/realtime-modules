import * as Y from 'yjs';
import { gzipSync } from 'node:zlib';
import CRDTService from '../../src/server/CRDTService';
import { MemoryMetadataStore, MemorySnapshotStore } from '../../src/server/stores/MemoryStore';
const channel = 'doc:hydration';
function fixture() {
    const store = new MemorySnapshotStore();
    const router = {
        sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn(),
        subscribeToChannel: jest.fn(), unsubscribeFromChannel: jest.fn(), sendToClient: jest.fn(),
        getClientData: () => ({ userId: 'actor', userContext: { userId: 'actor' } }),
    };
    const cache = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
    const service = new CRDTService({ messageRouter: router, snapshotStore: store, hotCache: cache,
        metadataStore: new MemoryMetadataStore(), logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    return { service, store, router, cache };
}
function bytes(text: string) {
    const doc = new Y.Doc(); doc.getText('content').insert(0, text);
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy(); return update;
}

describe('durable document hydration', () => {
    it('does not hydrate or acknowledge a router-rejected subscription', async () => {
        const { service, store, router } = fixture();
        router.subscribeToChannel.mockResolvedValue(false);
        const read = jest.spyOn(store, 'getLatestSnapshot');
        try {
            await service.handleSubscribe('one', { channel });
            expect(read).not.toHaveBeenCalled();
            expect(service.channelStates.has(channel)).toBe(false);
            expect(router.sendToClient.mock.calls.some(([, frame]) => frame.action === 'subscribed')).toBe(false);
            expect(router.sendToClient).toHaveBeenCalledWith('one', expect.objectContaining({ type: 'error' }));
        } finally { await service.shutdown(); }
    });
    it('does not expose an empty document on a failed read, and retries after recovery', async () => {
        const { service, store, router } = fixture();
        await store.putSnapshot(channel, gzipSync(bytes('durable')), { timestamp: 1 });
        jest.spyOn(store, 'getLatestSnapshot').mockRejectedValueOnce(Error('offline'));
        try {
            await service.handleSubscribe('one', { channel });
            expect(router.sendToClient.mock.calls.some(([, frame]) => frame.action === 'subscribed')).toBe(false);
            expect(service.channelStates.has(channel)).toBe(false);
            expect(router.unsubscribeFromChannel).toHaveBeenCalledWith('one', channel);
            await service.handleSubscribe('one', { channel });
            expect(service.channelStates.get(channel)?.ydoc.getText('content').toString()).toBe('durable');
        } finally { await service.shutdown(); }
    });
    it('direct updates hydrate durable content before accepting new edits', async () => {
        const { service, store } = fixture();
        await store.putSnapshot(channel, gzipSync(bytes('durable')), { timestamp: 1 });
        try {
            await service.handleUpdate('one', { channel, update: bytes('new').toString('base64') });
            const text = service.channelStates.get(channel)!.ydoc.getText('content').toString();
            expect(text).toContain('durable'); expect(text).toContain('new');
        } finally { await service.shutdown(); }
    });
    it('concurrent subscriptions and updates wait on one hydration before publishing state', async () => {
        const { service, store, router } = fixture();
        let resolve!: (value: any) => void;
        const read = jest.spyOn(store, 'getLatestSnapshot').mockImplementation(() => new Promise(r => { resolve = r; }));
        try {
            const first = service.handleSubscribe('one', { channel });
            // Reach the asynchronous store read without timing assumptions.
            while (!resolve) await Promise.resolve();
            const second = service.handleSubscribe('two', { channel });
            const update = service.handleUpdate('one', { channel, update: bytes('new').toString('base64') });
            await Promise.resolve(); await Promise.resolve();
            expect(router.sendToClient).not.toHaveBeenCalled();
            expect(service.channelStates.get(channel)?.operationsSinceSnapshot).toBe(0);
            resolve({ bytes: gzipSync(bytes('durable')), timestamp: 1 });
            await Promise.all([first, second, update]);
            expect(read).toHaveBeenCalledTimes(1);
            expect(service.channelStates.get(channel)?.subscriberCount).toBe(2);
            expect(service.channelStates.get(channel)?.ydoc.getText('content').toString()).toContain('durable');
        } finally { await service.shutdown(); }
    });
    it('falls back from malformed cache data to durable storage', async () => {
        const { service, store, cache } = fixture();
        cache.get.mockResolvedValue(Buffer.from([255]));
        await store.putSnapshot(channel, gzipSync(bytes('durable')), { timestamp: 1 });
        try {
            await service.handleSubscribe('one', { channel });
            expect(service.channelStates.get(channel)?.ydoc.getText('content').toString()).toBe('durable');
        } finally { await service.shutdown(); }
    });
    it('rejects corrupt durable bytes without making a state available for overwrite', async () => {
        const { service, store, router } = fixture();
        await store.putSnapshot(channel, Buffer.from('not gzip'), { timestamp: 1 });
        const write = jest.spyOn(store, 'putSnapshot');
        try {
            await service.handleUpdate('one', { channel, update: bytes('new').toString('base64') });
            expect(service.channelStates.has(channel)).toBe(false);
            expect(router.sendToClient).toHaveBeenCalledWith('one', expect.objectContaining({ type: 'error' }));
            expect(write).not.toHaveBeenCalled();
        } finally { await service.shutdown(); }
    });
});
