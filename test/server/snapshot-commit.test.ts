import * as Y from 'yjs';
import SnapshotManager from '../../src/server/SnapshotManager';
import { MemorySnapshotStore } from '../../src/server/stores/MemoryStore';
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const channel = 'doc:commit';
function setup() {
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, 'before');
    const state = { ydoc, operationsSinceSnapshot: 1, subscriberCount: 0, hydrated: true };
    const store = new MemorySnapshotStore();
    const cache = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
    const manager = new SnapshotManager({ snapshotStore: store, hotCache: cache, logger, getChannelState: () => state });
    return { state, store, cache, manager };
}

describe('snapshot commit boundary', () => {
    it('rejects durable failure without marking dirty state clean or caching an uncommitted snapshot', async () => {
        const { state, store, cache, manager } = setup();
        jest.spyOn(store, 'putSnapshot').mockRejectedValueOnce(Error('store offline'));
        await expect(manager.writeSnapshot(channel)).rejects.toThrow('store offline');
        expect(state.operationsSinceSnapshot).toBe(1);
        expect(cache.setEx).not.toHaveBeenCalled();
        await manager.writeSnapshot(channel);
        expect(state.operationsSinceSnapshot).toBe(0);
        expect(cache.setEx).toHaveBeenCalledTimes(1);
        state.ydoc.destroy();
    });
    it('returns the exact persisted version timestamp and serializes same-tick manual saves', async () => {
        const { state, store, manager } = setup();
        const [first, second] = await Promise.all([
            manager.handleSaveVersion(channel, 'First', 'actor'),
            manager.handleSaveVersion(channel, 'Second', 'actor'),
        ]);
        expect(first!.timestamp).toBeLessThan(second!.timestamp);
        expect(await store.getVersion(channel, first!.timestamp)).not.toBeNull();
        expect(await store.getVersion(channel, second!.timestamp)).not.toBeNull();
        expect((await store.listVersions(channel, 10)).map(v => v.versionName)).toEqual(['Second', 'First']);
        state.ydoc.destroy();
    });
    it('preserves updates that arrive during a pending durable write', async () => {
        const { state, store, manager } = setup();
        let release!: () => void;
        let started!: () => void;
        const begun = new Promise<void>(r => { started = r; });
        const original = store.putSnapshot.bind(store);
        jest.spyOn(store, 'putSnapshot').mockImplementationOnce(async (...args) => {
            started();
            await new Promise<void>(r => { release = r; });
            await original(...args);
        });
        const pending = manager.writeSnapshot(channel);
        await begun;
        state.ydoc.getText('content').insert(6, ' after');
        state.operationsSinceSnapshot++;
        release();
        await pending;
        expect(state.operationsSinceSnapshot).toBe(1);
        await manager.writeSnapshot(channel);
        expect(state.operationsSinceSnapshot).toBe(0);
        state.ydoc.destroy();
    });
    it('failed manual save rejects rather than returning a version identifier', async () => {
        const { state, store, manager } = setup();
        jest.spyOn(store, 'putSnapshot').mockRejectedValue(Error('store offline'));
        await expect(manager.handleSaveVersion(channel, 'Missing', 'actor')).rejects.toThrow('store offline');
        state.ydoc.destroy();
    });
    it('failed recovery checkpoint prevents document clearing', async () => {
        const { state, store, manager } = setup();
        jest.spyOn(store, 'putSnapshot').mockRejectedValue(Error('store offline'));
        const send = jest.fn(); const error = jest.fn();
        await manager.handleClearDocument('connection', { channel }, new Map([[channel, state]]), send, error);
        expect(state.ydoc.getText('content').toString()).toBe('before');
        expect(send).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalled();
        state.ydoc.destroy();
    });
});
