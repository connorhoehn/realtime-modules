// realtime-modules/test/server/document-channel-binding.test.ts
//
// A document written during a conversation belongs to that conversation.
//
// The binding is persisted through the MetadataStore rather than kept in the
// wire sidecar, because the sidecar is a per-process Map: a binding held there
// is gone on restart and invisible to every other node, which is the wrong
// shape for something whose whole job is to still be true tomorrow.
//
// The failure these tests exist to catch is quieter than a missing feature:
// `putDocument` upserts the WHOLE row, so any handler that re-persists a
// document without carrying the channel forward silently unbinds it. Renaming
// a document is not a reason to lose where it came from.

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

const CHANNEL = 'chat:dm:dev-bob:dev-hank';

describe('creating a document inside a conversation', () => {
    it('remembers which conversation it came from', async () => {
        const { service, store } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'Upload path RFC', type: 'custom', channel: CHANNEL },
            createdBy: 'dev-bob',
        });

        expect(doc.channel).toBe(CHANNEL);
        // Persisted, not sidecar-only.
        expect((await store.getDocument(doc.id)).channel).toBe(CHANNEL);
    });

    // A document made from the workspace belongs to nobody's conversation,
    // and guessing one would put it in a thread it was never part of.
    it('binds nothing when the creator was not in a conversation', async () => {
        const { service, store } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'Loose notes', type: 'custom' },
            createdBy: 'dev-bob',
        });
        expect(doc.channel).toBeUndefined();
        expect((await store.getDocument(doc.id)).channel).toBeUndefined();
    });

    it('ignores an empty channel rather than binding to ""', async () => {
        const { service } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'x', type: 'custom', channel: '' },
            createdBy: 'dev-bob',
        });
        expect(doc.channel).toBeUndefined();
    });
});

describe('listing a conversation documents', () => {
    it('returns only the ones bound to it', async () => {
        const { service } = makeService();
        await service.handleCreateDocument({ meta: { title: 'A', channel: CHANNEL }, createdBy: 'u' });
        await service.handleCreateDocument({ meta: { title: 'B', channel: 'chat:dm:other' }, createdBy: 'u' });
        await service.handleCreateDocument({ meta: { title: 'C' }, createdBy: 'u' });

        const mine = await service.handleListDocuments({ channel: CHANNEL });
        expect(mine.map((d: any) => d.title)).toEqual(['A']);
    });

    it('still lists the whole workspace when no channel is asked for', async () => {
        const { service } = makeService();
        await service.handleCreateDocument({ meta: { title: 'A', channel: CHANNEL }, createdBy: 'u' });
        await service.handleCreateDocument({ meta: { title: 'C' }, createdBy: 'u' });
        expect(await service.handleListDocuments()).toHaveLength(2);
    });

    it('answers with nothing for a conversation that has no documents', async () => {
        const { service } = makeService();
        await service.handleCreateDocument({ meta: { title: 'A' }, createdBy: 'u' });
        expect(await service.handleListDocuments({ channel: CHANNEL })).toEqual([]);
    });
});

describe('editing a bound document', () => {
    // putDocument upserts the whole row. This is the silent break.
    it('keeps the binding through a rename', async () => {
        const { service, store } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'Draft', channel: CHANNEL },
            createdBy: 'dev-bob',
        });

        const updated = await service.handleUpdateDocumentMeta(doc.id, { title: 'Final' });

        expect(updated.title).toBe('Final');
        expect(updated.channel).toBe(CHANNEL);
        expect((await store.getDocument(doc.id)).channel).toBe(CHANNEL);
    });

    it('keeps it through a status change too', async () => {
        const { service } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'Draft', channel: CHANNEL },
            createdBy: 'dev-bob',
        });
        await service.handleUpdateDocumentMeta(doc.id, { status: 'published' });
        const [listed] = await service.handleListDocuments({ channel: CHANNEL });
        expect(listed.status).toBe('published');
    });

    // The channel is not in the update allowlist: moving a document between
    // conversations is not an edit, and a client should not be able to do it
    // by sending a field.
    it('will not let a metadata update move it to another conversation', async () => {
        const { service, store } = makeService();
        const doc = await service.handleCreateDocument({
            meta: { title: 'Draft', channel: CHANNEL },
            createdBy: 'dev-bob',
        });
        await service.handleUpdateDocumentMeta(doc.id, { channel: 'chat:dm:somewhere:else' });
        expect((await store.getDocument(doc.id)).channel).toBe(CHANNEL);
    });
});
