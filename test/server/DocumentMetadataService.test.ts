// realtime-modules/test/server/DocumentMetadataService.test.ts
//
// Adapter test for the lifted DocumentMetadataService — uses
// MemoryMetadataStore in place of the gateway-origin DDB + Redis pair.
// Mirrors the gateway test/crdt-document-metadata-service*.test.js
// behaviour at the level the lifted module exposes (wire-shape CRUD +
// MessageRouter publishing of doc.created).

import DocumentMetadataService = require('../../src/server/DocumentMetadataService');
import { MemoryMetadataStore } from '../../src/server/stores/MemoryStore';

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService(opts: { withRouter?: boolean } = {}) {
    const metadataStore = new MemoryMetadataStore();
    const published: Array<{ channel: string; frame: any }> = [];
    const router: any = opts.withRouter === false ? null : {
        sendToChannel: jest.fn(async (channel: string, frame: any) => {
            published.push({ channel, frame });
        }),
        broadcastToAll: jest.fn(async () => {}),
        onRemoteChannelMessage: jest.fn(),
        getClientData: jest.fn(() => null),
    };
    const svc = new DocumentMetadataService({
        metadataStore,
        logger: new NoopLogger(),
        messageRouter: router,
    });
    return { svc, metadataStore, router, published };
}

describe('DocumentMetadataService — handleCreateDocument', () => {
    test('creates a document with default fields + persists to MetadataStore', async () => {
        const { svc, metadataStore } = makeService();
        const doc = await svc.handleCreateDocument({
            meta: { title: '  My Doc  ', type: 'meeting' },
            createdBy: 'user-a',
            createdByName: 'Alice',
        });

        expect(doc.id).toMatch(/.+/);
        expect(doc.title).toBe('My Doc'); // trimmed
        expect(doc.type).toBe('meeting');
        expect(doc.status).toBe('draft');
        expect(doc.createdBy).toBe('user-a');
        expect(doc.createdByName).toBe('Alice');
        expect(doc.icon).toMatch(/.+/); // populated from TYPE_ICONS

        const stored = await metadataStore.getDocument(doc.id);
        expect(stored).not.toBeNull();
        expect(stored!.title).toBe('My Doc');
        expect(stored!.docType).toBe('meeting');
        expect(stored!.ownerId).toBe('user-a');
    });

    test('falls back to custom type + empty description when meta omits them', async () => {
        const { svc } = makeService();
        const doc = await svc.handleCreateDocument({
            meta: { title: 'Bare Doc' },
            createdBy: 'u',
        });
        expect(doc.type).toBe('custom');
        expect(doc.description).toBe('');
        expect(doc.createdByName).toBeNull();
    });

    test('publishes doc.created activity via messageRouter (wave20-e)', async () => {
        const { svc, published } = makeService();
        await svc.handleCreateDocument({
            meta: { title: 'X', type: 'design' },
            createdBy: 'u-1',
            createdByName: 'Owen',
        });
        expect(published.length).toBe(1);
        expect(published[0].channel).toBe('activity:broadcast');
        expect(published[0].frame.type).toBe('activity:event');
        expect(published[0].frame.payload.eventType).toBe('doc.created');
        expect(published[0].frame.payload.userId).toBe('u-1');
    });

    test('does not throw when messageRouter is absent', async () => {
        const { svc, metadataStore } = makeService({ withRouter: false });
        const doc = await svc.handleCreateDocument({
            meta: { title: 'No Router' },
            createdBy: 'u',
        });
        expect(await metadataStore.getDocument(doc.id)).not.toBeNull();
    });

    test('logs and swallows messageRouter publish errors', async () => {
        const errors: string[] = [];
        const metadataStore = new MemoryMetadataStore();
        const router: any = {
            sendToChannel: jest.fn(async () => {
                throw new Error('router boom');
            }),
            broadcastToAll: jest.fn(async () => {}),
            onRemoteChannelMessage: jest.fn(),
            getClientData: jest.fn(() => null),
        };
        const svc = new DocumentMetadataService({
            metadataStore,
            logger: { debug() {}, info() {}, warn() {}, error: (msg: string) => errors.push(msg) },
            messageRouter: router,
        });
        const doc = await svc.handleCreateDocument({
            meta: { title: 'Boom' },
            createdBy: 'u',
        });
        expect(doc.id).toMatch(/.+/);
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe('DocumentMetadataService — handleListDocuments', () => {
    test('returns wire-shape documents sorted newest-first', async () => {
        const { svc } = makeService();
        const a = await svc.handleCreateDocument({ meta: { title: 'A' }, createdBy: 'u' });
        await new Promise((resolve) => setTimeout(resolve, 2));
        const b = await svc.handleCreateDocument({ meta: { title: 'B' }, createdBy: 'u' });

        const list = await svc.handleListDocuments();
        expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
        expect(list[0].title).toBe('B');
    });

    test('empty store returns []', async () => {
        const { svc } = makeService();
        expect(await svc.handleListDocuments()).toEqual([]);
    });
});

describe('DocumentMetadataService — handleDeleteDocument', () => {
    test('removes from the underlying store', async () => {
        const { svc, metadataStore } = makeService();
        const doc = await svc.handleCreateDocument({ meta: { title: 'Delete me' }, createdBy: 'u' });
        await svc.handleDeleteDocument(doc.id);
        expect(await metadataStore.getDocument(doc.id)).toBeNull();
    });

    test('idempotent on unknown id', async () => {
        const { svc } = makeService();
        await expect(svc.handleDeleteDocument('never-existed')).resolves.toBeUndefined();
    });
});

describe('DocumentMetadataService — handleUpdateDocumentMeta', () => {
    test('merges allowed fields + bumps updatedAt', async () => {
        const { svc, metadataStore } = makeService();
        const doc = await svc.handleCreateDocument({ meta: { title: 'Orig' }, createdBy: 'u' });
        const before = await metadataStore.getDocument(doc.id);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const updated = await svc.handleUpdateDocumentMeta(doc.id, {
            title: 'Renamed',
            status: 'published',
            description: 'desc',
        });
        expect(updated).not.toBeNull();
        expect(updated!.title).toBe('Renamed');
        expect(updated!.status).toBe('published');
        expect(updated!.description).toBe('desc');

        const after = await metadataStore.getDocument(doc.id);
        expect(after!.title).toBe('Renamed');
        expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
    });

    test('returns null for unknown documentId', async () => {
        const { svc } = makeService();
        expect(await svc.handleUpdateDocumentMeta('missing', { title: 'x' })).toBeNull();
    });

    test('ignores non-allowed fields', async () => {
        const { svc } = makeService();
        const doc = await svc.handleCreateDocument({ meta: { title: 'Guard' }, createdBy: 'u' });
        const updated = await svc.handleUpdateDocumentMeta(doc.id, { hackField: 'nope' });
        expect((updated as any).hackField).toBeUndefined();
    });
});

describe('DocumentMetadataService — ensureTable', () => {
    test('is a no-op (adapter-owned)', async () => {
        const { svc } = makeService();
        await expect(svc.ensureTable()).resolves.toBeUndefined();
    });
});
