import * as Y from 'yjs';
import CRDTService from '../../src/server/CRDTService';
import { MemoryMetadataStore, MemorySnapshotStore } from '../../src/server/stores/MemoryStore';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const channel = 'doc:policy-regression';
function setup(authz: () => boolean) {
    const router = {
        sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn(),
        subscribeToChannel: jest.fn(), unsubscribeFromChannel: jest.fn(),
        sendToClient: jest.fn(), getClientData: () => ({ userId: 'actor', userContext: { userId: 'actor' } }),
    };
    const service = new CRDTService({ messageRouter: router, logger, authz,
        metadataStore: new MemoryMetadataStore(), snapshotStore: new MemorySnapshotStore() });
    return { service, router };
}
function update() {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'must be authorized');
    const bytes = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    doc.destroy();
    return bytes;
}

describe('CRDT channel policy at mutation time', () => {
    it('attributes saved versions to the verified actor rather than the connection', async () => {
        const { service } = setup(() => true);
        const save = jest.spyOn(service.snapshotManager, 'handleSaveVersion').mockResolvedValue({ name: 'publish', author: 'actor', timestamp: 1 });
        try {
            await service.handleAction('connection', 'saveVersion', { channel, name: 'publish' });
            expect(save).toHaveBeenCalledWith(channel, 'publish', 'actor');
        } finally { await service.shutdown(); }
    });
    it('denied subscription cannot be bypassed with a direct update frame', async () => {
        const policy = jest.fn(() => false);
        const { service } = setup(policy);
        try {
            await service.handleAction('connection', 'subscribe', { channel });
            await service.handleAction('connection', 'update', { channel, update: update() });
            expect(policy).toHaveBeenCalledTimes(2);
            expect(service.channelStates.has(channel)).toBe(false);
        } finally { await service.shutdown(); }
    });
    it('rechecks policy after a successful subscription, including the public update method', async () => {
        let allowed = true;
        const { service } = setup(() => allowed);
        try {
            await service.handleSubscribe('connection', { channel });
            allowed = false;
            await service.handleUpdate('connection', { channel, update: update() });
            expect(service.channelStates.get(channel)?.ydoc.getText('content').toString()).toBe('');
            allowed = true;
            await service.handleUpdate('connection', { channel, update: update() });
            expect(service.channelStates.get(channel)?.ydoc.getText('content').toString()).toBe('must be authorized');
        } finally { await service.shutdown(); }
    });
    it('denied awareness does not backfill document presence', async () => {
        const policy = jest.fn(() => false);
        const { service } = setup(policy);
        try {
            await service.handleAwareness('connection', { channel, update: 'AA==' });
            expect(policy).toHaveBeenCalledTimes(1);
            expect(service.presenceService.hasClient('connection', channel)).toBe(false);
        } finally { await service.shutdown(); }
    });
});
