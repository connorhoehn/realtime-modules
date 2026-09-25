// realtime-modules/test/server/document-editors.test.ts
//
// A document's sharing list (`editors`, user ids) rides the wire so a reader
// can show who it is shared with — "Document collaborators" in a document
// call's start panel. It is read-only here: set by whatever shares the
// document, carried through every whole-row write (putDocument upserts the
// WHOLE row, so a rename that forgot it would un-share the document), and
// never taken from a client's updateDocumentMeta payload.

import { describe, it, expect } from '@jest/globals';
const DocumentMetadataService = require('../../dist/server/DocumentMetadataService');
const { MemoryMetadataStore } = require('../../dist/server/stores/MemoryStore');

function makeService() {
    const store = new MemoryMetadataStore();
    const service = new DocumentMetadataService({
        metadataStore: store,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        messageRouter: null,
    });
    return { service, store };
}

async function sharedDoc() {
    const { service, store } = makeService();
    const doc = await service.handleCreateDocument({ meta: { title: 'Auth architecture', type: 'custom' }, createdBy: 'dev-connor' });
    const stored = await store.getDocument(doc.id);
    await store.putDocument({ ...stored, editors: ['dev-alice', 'dev-frank'] });
    return { service, store, id: doc.id };
}

describe('document editors on the wire', () => {
    it('lists them on documentList entries and single reads', async () => {
        const { service, id } = await sharedDoc();
        const list = await service.handleListDocuments();
        expect(list.find((d: any) => d.id === id).editors).toEqual(['dev-alice', 'dev-frank']);
        expect((await service.handleGetDocument(id)).editors).toEqual(['dev-alice', 'dev-frank']);
    });

    it('omits the field for a document shared with nobody', async () => {
        const { service } = makeService();
        const doc = await service.handleCreateDocument({ meta: { title: 'Loose notes', type: 'custom' }, createdBy: 'dev-bob' });
        expect((await service.handleListDocuments()).find((d: any) => d.id === doc.id)).not.toHaveProperty('editors');
    });

    it('survives a rename, and a payload cannot change it', async () => {
        const { service, store, id } = await sharedDoc();
        const wire = await service.handleUpdateDocumentMeta(id, { title: 'Auth architecture v2', editors: ['dev-mallory'] });
        expect(wire.title).toBe('Auth architecture v2');
        expect(wire.editors).toEqual(['dev-alice', 'dev-frank']);
        expect((await store.getDocument(id)).editors).toEqual(['dev-alice', 'dev-frank']);
    });
});
