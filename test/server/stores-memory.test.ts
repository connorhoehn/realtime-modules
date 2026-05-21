// realtime-modules/test/server/stores-memory.test.ts
//
// Lifted from gateway test/crdt-stores-memory.test.js (verbatim semantics).
// Import path updated to consume the lifted MemoryStore implementations.

import {
    MemoryHotCache,
    MemoryMetadataStore,
    MemorySnapshotStore,
} from '../../src/server/stores/MemoryStore';

describe('MemorySnapshotStore', () => {
    let store: MemorySnapshotStore;
    beforeEach(() => {
        store = new MemorySnapshotStore();
    });

    test('putSnapshot + getLatestSnapshot roundtrip preserves bytes + meta', async () => {
        const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]);
        await store.putSnapshot('chan-a', bytes, { timestamp: 1000, versionName: 'v1' });

        const latest = await store.getLatestSnapshot('chan-a');
        expect(latest).not.toBeNull();
        expect(latest!.timestamp).toBe(1000);
        expect(latest!.versionName).toBe('v1');
        expect(latest!.bytes.equals(bytes)).toBe(true);
    });

    test('getLatestSnapshot returns null for unknown channel', async () => {
        expect(await store.getLatestSnapshot('nope')).toBeNull();
    });

    test('getLatestSnapshot returns newest by timestamp regardless of insert order', async () => {
        await store.putSnapshot('chan-a', Buffer.from('old'), { timestamp: 100 });
        await store.putSnapshot('chan-a', Buffer.from('new'), { timestamp: 300 });
        await store.putSnapshot('chan-a', Buffer.from('mid'), { timestamp: 200 });

        const latest = await store.getLatestSnapshot('chan-a');
        expect(latest!.timestamp).toBe(300);
        expect(latest!.bytes.toString()).toBe('new');
    });

    test('listVersions returns newest-first, capped at limit, with sizes', async () => {
        await store.putSnapshot('chan-a', Buffer.from('aaa'), { timestamp: 100 });
        await store.putSnapshot('chan-a', Buffer.from('bbbb'), { timestamp: 200, versionName: 'second' });
        await store.putSnapshot('chan-a', Buffer.from('ccccc'), { timestamp: 300 });

        const all = await store.listVersions('chan-a', 10);
        expect(all.map((v) => v.timestamp)).toEqual([300, 200, 100]);
        expect(all[0]).toEqual({ channelId: 'chan-a', timestamp: 300, versionName: undefined, size: 5 });
        expect(all[1].versionName).toBe('second');
        expect(all[1].size).toBe(4);

        const top1 = await store.listVersions('chan-a', 1);
        expect(top1.length).toBe(1);
        expect(top1[0].timestamp).toBe(300);

        const none = await store.listVersions('chan-a', 0);
        expect(none).toEqual([]);
    });

    test('listVersions on unknown channel returns []', async () => {
        expect(await store.listVersions('nope', 10)).toEqual([]);
    });

    test('getVersion returns exact match by timestamp, null otherwise', async () => {
        const v1 = Buffer.from('v1-bytes');
        const v2 = Buffer.from('v2-bytes');
        await store.putSnapshot('chan-a', v1, { timestamp: 100 });
        await store.putSnapshot('chan-a', v2, { timestamp: 200 });

        const hit = await store.getVersion('chan-a', 200);
        expect(hit).not.toBeNull();
        expect(hit!.equals(v2)).toBe(true);

        expect(await store.getVersion('chan-a', 999)).toBeNull();
        expect(await store.getVersion('nope', 200)).toBeNull();
    });

    test('getLatestSnapshot returns a defensive copy (mutation isolation)', async () => {
        const original = Buffer.from([1, 2, 3]);
        await store.putSnapshot('chan-a', original, { timestamp: 1 });

        const first = await store.getLatestSnapshot('chan-a');
        first!.bytes[0] = 99;

        const second = await store.getLatestSnapshot('chan-a');
        expect(second!.bytes[0]).toBe(1);
    });
});

describe('MemoryMetadataStore', () => {
    let store: MemoryMetadataStore;
    beforeEach(() => {
        store = new MemoryMetadataStore();
    });

    const baseDoc = (overrides: Record<string, any> = {}) => ({
        documentId: 'doc-1',
        title: 'Doc 1',
        status: 'draft' as const,
        docType: 'custom',
        ownerId: 'user-a',
        createdAt: 1000,
        updatedAt: 1000,
        ...overrides,
    });

    test('putDocument + getDocument roundtrip', async () => {
        await store.putDocument(baseDoc());
        const hit = await store.getDocument('doc-1');
        expect(hit).toEqual(baseDoc());
    });

    test('getDocument returns null for unknown id', async () => {
        expect(await store.getDocument('missing')).toBeNull();
    });

    test('putDocument is upsert (last writer wins)', async () => {
        await store.putDocument(baseDoc({ title: 'first' }));
        await store.putDocument(baseDoc({ title: 'second', updatedAt: 2000 }));
        const hit = await store.getDocument('doc-1');
        expect(hit!.title).toBe('second');
        expect(hit!.updatedAt).toBe(2000);
    });

    test('listDocuments returns newest-first by updatedAt', async () => {
        await store.putDocument(baseDoc({ documentId: 'a', updatedAt: 100 }));
        await store.putDocument(baseDoc({ documentId: 'b', updatedAt: 300 }));
        await store.putDocument(baseDoc({ documentId: 'c', updatedAt: 200 }));

        const list = await store.listDocuments();
        expect(list.map((d) => d.documentId)).toEqual(['b', 'c', 'a']);
    });

    test('listDocuments filters by ownerId + docType + limit', async () => {
        await store.putDocument(baseDoc({ documentId: 'a', ownerId: 'u1', docType: 'note', updatedAt: 1 }));
        await store.putDocument(baseDoc({ documentId: 'b', ownerId: 'u1', docType: 'task', updatedAt: 2 }));
        await store.putDocument(baseDoc({ documentId: 'c', ownerId: 'u2', docType: 'note', updatedAt: 3 }));
        await store.putDocument(baseDoc({ documentId: 'd', ownerId: 'u1', docType: 'note', updatedAt: 4 }));

        const byOwner = await store.listDocuments({ ownerId: 'u1' });
        expect(byOwner.map((d) => d.documentId)).toEqual(['d', 'b', 'a']);

        const byType = await store.listDocuments({ docType: 'note' });
        expect(byType.map((d) => d.documentId)).toEqual(['d', 'c', 'a']);

        const both = await store.listDocuments({ ownerId: 'u1', docType: 'note' });
        expect(both.map((d) => d.documentId)).toEqual(['d', 'a']);

        const limited = await store.listDocuments({ ownerId: 'u1', limit: 2 });
        expect(limited.length).toBe(2);
        expect(limited.map((d) => d.documentId)).toEqual(['d', 'b']);
    });

    test('listDocuments returns defensive copies — mutation cannot poison storage', async () => {
        await store.putDocument(baseDoc());
        const list = await store.listDocuments();
        list[0].title = 'mutated';
        const refetched = await store.getDocument('doc-1');
        expect(refetched!.title).toBe('Doc 1');
    });

    test('deleteDocument removes; idempotent on missing id', async () => {
        await store.putDocument(baseDoc());
        await store.deleteDocument('doc-1');
        expect(await store.getDocument('doc-1')).toBeNull();
        await store.deleteDocument('doc-1');
        await store.deleteDocument('never-existed');
    });
});

describe('MemoryHotCache', () => {
    let cache: MemoryHotCache;
    beforeEach(() => {
        jest.useFakeTimers({ now: 1_700_000_000_000 });
        cache = new MemoryHotCache();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('setEx + get roundtrip before TTL expires', async () => {
        await cache.setEx('k1', 60, Buffer.from('hello'));
        const hit = await cache.get('k1');
        expect(hit).not.toBeNull();
        expect(hit!.toString()).toBe('hello');
    });

    test('get returns null for unknown key', async () => {
        expect(await cache.get('missing')).toBeNull();
    });

    test('get returns null after TTL expires', async () => {
        await cache.setEx('k1', 5, Buffer.from('expires-soon'));
        jest.setSystemTime(1_700_000_000_000 + 5_001);
        expect(await cache.get('k1')).toBeNull();
    });

    test('get within TTL window still returns value', async () => {
        await cache.setEx('k1', 10, Buffer.from('still-good'));
        jest.setSystemTime(1_700_000_000_000 + 9_000);
        const hit = await cache.get('k1');
        expect(hit).not.toBeNull();
        expect(hit!.toString()).toBe('still-good');
    });

    test('ttlSec <= 0 stores without TTL (never auto-expires)', async () => {
        await cache.setEx('forever', 0, Buffer.from('keep-me'));
        jest.setSystemTime(1_700_000_000_000 + 365 * 24 * 60 * 60 * 1000);
        const hit = await cache.get('forever');
        expect(hit).not.toBeNull();
        expect(hit!.toString()).toBe('keep-me');
    });

    test('del removes the key', async () => {
        await cache.setEx('k1', 60, Buffer.from('bye'));
        await cache.del('k1');
        expect(await cache.get('k1')).toBeNull();
    });

    test('del is idempotent on missing key', async () => {
        await expect(cache.del('never-set')).resolves.toBeUndefined();
    });

    test('setEx makes a defensive copy of the value buffer', async () => {
        const value = Buffer.from('mutable');
        await cache.setEx('k1', 60, value);
        value[0] = 0x00;
        const hit = await cache.get('k1');
        expect(hit!.toString()).toBe('mutable');
    });

    test('setEx overwrites existing entry + resets TTL', async () => {
        await cache.setEx('k1', 5, Buffer.from('old'));
        jest.setSystemTime(1_700_000_000_000 + 3_000);
        await cache.setEx('k1', 60, Buffer.from('new'));
        jest.setSystemTime(1_700_000_000_000 + 10_000);
        const hit = await cache.get('k1');
        expect(hit!.toString()).toBe('new');
    });
});
