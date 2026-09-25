import * as Y from 'yjs';
import CRDTService from '../../src/server/CRDTService';
import { MemoryMetadataStore, MemorySnapshotStore } from '../../src/server/stores/MemoryStore';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(opts: { authz?: (clientId: string, channel: string, svc: any, action: string) => boolean; userContext?: any } = {}) {
    const router: any = {
        sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn(),
        subscribeToChannel: jest.fn(), unsubscribeFromChannel: jest.fn(), sendToClient: jest.fn(),
        getClientData: () => ({ userContext: 'userContext' in opts ? opts.userContext : { userId: 'copier', displayName: 'Copier' } }),
    };
    const metadataStore = new MemoryMetadataStore();
    const snapshotStore = new MemorySnapshotStore();
    const service: any = new CRDTService({ messageRouter: router, logger, authz: opts.authz ?? (() => true), metadataStore, snapshotStore });
    return { service, router, metadataStore, snapshotStore };
}

async function seedSource(service: any) {
    const src = await service.metadataService.handleCreateDocument({
        meta: { title: 'Release plan', type: 'page', icon: 'P', description: 'the plan' }, createdBy: 'owner',
    });
    const state = await service.ensureHydratedState(`doc:${src.id}`);
    state.ydoc.getText('content').insert(0, 'body text');
    state.ydoc.getMap('meta').set('id', src.id);
    state.ydoc.getMap('meta').set('title', 'Release plan');
    state.ydoc.getMap('meta').set('importSourceRevision', 'rev-1');
    await service.snapshotManager.writeSnapshot(`doc:${src.id}`);
    return src;
}

function sent(router: any, action: string) {
    return router.sendToClient.mock.calls.map((c: any[]) => c[1]).filter((m: any) => m.action === action);
}

describe('copyDocument', () => {
    it('creates a new document with the source metadata and a clone of its content', async () => {
        const { service, router } = setup();
        try {
            const src = await seedSource(service);
            await service.handleAction('conn', 'copyDocument', { documentId: src.id, requestId: 'r1' });
            const [reply] = sent(router, 'documentCopied');
            expect(reply).toMatchObject({ type: 'crdt', requestId: 'r1', sourceId: src.id });
            const doc = reply.document;
            expect(doc.id).not.toBe(src.id);
            expect(doc).toMatchObject({ title: 'Release plan (copy)', type: 'page', icon: 'P', description: 'the plan', createdBy: 'copier', createdByName: 'Copier' });
            expect(router.broadcastToAll).toHaveBeenCalledWith({ type: 'crdt', action: 'documentCreated', document: doc });
            // The copy is durable: drop in-memory state and rehydrate from the snapshot.
            service.channelStates.delete(`doc:${doc.id}`);
            const copy = await service.ensureHydratedState(`doc:${doc.id}`);
            expect(copy.ydoc.getText('content').toString()).toBe('body text');
            expect(copy.ydoc.getMap('meta').get('id')).toBe(doc.id);
            expect(copy.ydoc.getMap('meta').get('title')).toBe('Release plan (copy)');
            expect(copy.ydoc.getMap('meta').has('importSourceRevision')).toBe(false);
            // Source untouched.
            const source = service.channelStates.get(`doc:${src.id}`);
            expect(source.ydoc.getMap('meta').get('id')).toBe(src.id);
            expect(source.ydoc.getMap('meta').get('title')).toBe('Release plan');
            expect(source.ydoc.getText('content').toString()).toBe('body text');
        } finally { await service.shutdown(); }
    });

    it('uses the requested title', async () => {
        const { service, router } = setup();
        try {
            const src = await seedSource(service);
            await service.handleAction('conn', 'copyDocument', { documentId: src.id, requestId: 'r2', title: '  Plan v2 ' });
            expect(sent(router, 'documentCopied')[0].document.title).toBe('Plan v2');
        } finally { await service.shutdown(); }
    });

    it('requires read on the source and create permission', async () => {
        const denyRead = setup({ authz: (_c: string, ch: string, _s: any, a: string) => !(a === 'read' && ch.startsWith('doc:')) });
        const denyCreate = setup({ authz: (_c: string, _ch: string, _s: any, a: string) => a !== 'create' });
        try {
            for (const { service, router, metadataStore } of [denyRead, denyCreate]) {
                const src = await seedSource(service);
                await service.handleAction('conn', 'copyDocument', { documentId: src.id, requestId: 'r3' });
                expect(sent(router, 'documentCopyFailed')[0]).toMatchObject({ requestId: 'r3', sourceId: src.id, code: 'forbidden' });
                expect(await metadataStore.listDocuments()).toHaveLength(1);
            }
        } finally { await denyRead.service.shutdown(); await denyCreate.service.shutdown(); }
    });

    it('refuses without a verified actor and for a missing source', async () => {
        const anon = setup({ userContext: undefined });
        const ok = setup();
        try {
            await anon.service.handleAction('conn', 'copyDocument', { documentId: 'x', requestId: 'a' });
            expect(sent(anon.router, 'documentCopyFailed')[0]).toMatchObject({ requestId: 'a', code: 'unauthenticated' });
            await ok.service.handleAction('conn', 'copyDocument', { documentId: 'missing', requestId: 'b' });
            expect(sent(ok.router, 'documentCopyFailed')[0]).toMatchObject({ requestId: 'b', sourceId: 'missing', code: 'not_found' });
        } finally { await anon.service.shutdown(); await ok.service.shutdown(); }
    });

    it('deletes the new metadata row when the content write fails', async () => {
        const { service, router, metadataStore } = setup();
        try {
            const src = await seedSource(service);
            const write = jest.spyOn(service.snapshotManager, 'writeSnapshot').mockRejectedValueOnce(new Error('ddb down'));
            await service.handleAction('conn', 'copyDocument', { documentId: src.id, requestId: 'r4' });
            expect(write).toHaveBeenCalled();
            expect(sent(router, 'documentCopyFailed')[0]).toMatchObject({ requestId: 'r4', code: 'copy_failed' });
            expect((await metadataStore.listDocuments()).map((d: any) => d.documentId)).toEqual([src.id]);
            expect(router.broadcastToAll).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'documentCreated' }));
        } finally { await service.shutdown(); }
    });
});
