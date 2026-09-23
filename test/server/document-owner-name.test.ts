// realtime-modules/test/server/document-owner-name.test.ts
//
// NFR #80 (realtime-examples): the owner's display name is persisted on the
// document row, so the byline survives a gateway restart and reads the same
// on every replica. A "restart" / "other replica" here is a second service
// instance over the same store — its per-process sidecar is empty.

import { describe, it, expect } from '@jest/globals';
const DocumentMetadataService = require('../../dist/server/DocumentMetadataService');
const { MemoryMetadataStore } = require('../../dist/server/stores/MemoryStore');

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const serviceOver = (store: any) => new DocumentMetadataService({ metadataStore: store, logger, messageRouter: null });

describe('owner display name', () => {
    it('is persisted at creation and read back by another process', async () => {
        const store = new MemoryMetadataStore();
        const doc = await serviceOver(store).handleCreateDocument({
            meta: { title: 'Q3 review', type: 'presentation' }, createdBy: 'dev-bob', createdByName: 'Bob Builder',
        });
        expect((await store.getDocument(doc.id)).ownerName).toBe('Bob Builder');

        const [listed] = await serviceOver(store).handleListDocuments();
        expect(listed).toMatchObject({ createdBy: 'dev-bob', createdByName: 'Bob Builder' });
    });

    it('survives a rename, and a client payload cannot rewrite it', async () => {
        const store = new MemoryMetadataStore();
        const doc = await serviceOver(store).handleCreateDocument({ meta: { title: 'a' }, createdBy: 'dev-bob', createdByName: 'Bob' });
        await serviceOver(store).handleUpdateDocumentMeta(doc.id, { title: 'b', createdByName: 'Mallory' });
        expect((await store.getDocument(doc.id)).ownerName).toBe('Bob');
        const [listed] = await serviceOver(store).handleListDocuments();
        expect(listed.createdByName).toBe('Bob');
    });

    it('backfills an old row only when its owner reads it, touching nothing else', async () => {
        const store = new MemoryMetadataStore();
        const now = Date.now();
        await store.putDocument({ documentId: 'old-1', title: 'Old', ownerId: 'dev-bob', createdAt: now, updatedAt: now });
        await store.putDocument({ documentId: 'old-2', title: 'Other', ownerId: 'dev-carol', createdAt: now, updatedAt: now });
        const service = serviceOver(store);

        // Someone else listing does not name Bob's row.
        let docs = await service.handleListDocuments();
        expect(await service.backfillOwnerNames(docs, { userId: 'dev-carol', displayName: '' })).toBe(0);
        expect(await service.backfillOwnerNames(docs, { userId: 'dev-dave', displayName: 'Dave' })).toBe(0);
        expect((await store.getDocument('old-1')).ownerName).toBeUndefined();

        docs = await service.handleListDocuments();
        expect(await service.backfillOwnerNames(docs, { userId: 'dev-bob', displayName: 'Bob' })).toBe(1);
        expect(docs.find((d: any) => d.id === 'old-1').createdByName).toBe('Bob');
        expect(await store.getDocument('old-1')).toMatchObject({ ownerName: 'Bob', title: 'Old', updatedAt: now });
        expect((await store.getDocument('old-2')).ownerName).toBeUndefined();

        // Idempotent: a second read writes nothing.
        expect(await service.backfillOwnerNames(await service.handleListDocuments(), { userId: 'dev-bob', displayName: 'Bob' })).toBe(0);
    });
});
