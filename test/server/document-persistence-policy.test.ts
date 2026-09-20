import * as Y from 'yjs';
import CRDTService, { type CRDTServiceOpts } from '../../src/server/CRDTService';
import { MemorySnapshotStore, MemoryMetadataStore } from '../../src/server/stores/MemoryStore';
const channel = 'doc:11111111-1111-4111-8111-111111111111';
const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
function setup(authz: CRDTServiceOpts['authz']) {
  const store = new MemorySnapshotStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn(), getClientData: () => ({ userId: 'alice', userContext: { userId: 'alice' } }) };
  return { store, router, service: new CRDTService({ authz, messageRouter: router, snapshotStore: store, metadataStore: new MemoryMetadataStore(), logger }) };
}
function seed() { const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2); doc.getXmlFragment('body').insert(0, [new Y.XmlElement('paragraph')]); const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'); doc.destroy(); return { channel, snapshot, sourceRevision: 'v1' }; }
it('awaits asynchronous operation policy and prevents reader writes/version/metadata mutations', async () => {
  const { service, router } = setup(async (_c, ch, _svc, action) => ch === channel && action === 'read');
  try {
    await service.handleSubscribe('alice', { channel });
    for (const action of ['update', 'restoreSnapshot', 'saveVersion', 'updateDocumentMeta', 'deleteDocument', 'seedDocument']) {
      await service.handleAction('alice', action, { ...seed(), documentId: channel.slice(4), update: seed().snapshot, updateId: 'a' });
    }
    expect(service.channelStates.get(channel)?.ydoc.getMap('meta').size).toBe(0);
    expect(router.sendToClient.mock.calls.some(([, m]) => m.type === 'crdt:persisted')).toBe(false);
  } finally { await service.shutdown(); }
});
it('only acknowledges after durable commit and retains dirty state on failure', async () => {
  const { service, store, router } = setup(async () => true);
  const put = jest.spyOn(store, 'putSnapshot').mockRejectedValueOnce(Error('storage unavailable'));
  try {
    await service.handleUpdate('alice', { channel, update: seed().snapshot, updateId: 'one' });
    expect(router.sendToClient).toHaveBeenCalledWith('alice', { type: 'crdt:persistence-error', channel, updateId: 'one' });
    expect(service.channelStates.get(channel)?.operationsSinceSnapshot).toBe(1);
    await service.handleUpdate('alice', { channel, update: seed().snapshot, updateId: 'one' });
    expect(router.sendToClient).toHaveBeenCalledWith('alice', { type: 'crdt:persisted', channel, updateId: 'one' });
    expect(put).toHaveBeenCalledTimes(2);
  } finally { await service.shutdown(); }
});
it('serializes concurrent first-open seeds and refuses another source revision', async () => {
  const { service } = setup(async () => true);
  try {
    const input = seed();
    const results = await Promise.all([service.seedDocument('alice', input), service.seedDocument('alice', input)]);
    expect(results.map(r => r.alreadySeeded)).toEqual([false, true]);
    expect(service.channelStates.get(channel)?.ydoc.getXmlFragment('body').length).toBe(1);
    await expect(service.seedDocument('alice', { ...input, sourceRevision: 'v2' })).rejects.toThrow('another source');
  } finally { await service.shutdown(); }
});
it('rechecks revocation after hydration before accepting bytes', async () => {
  let attempts = 0;
  const { service } = setup(async () => ++attempts === 1);
  try { await service.handleUpdate('alice', { channel, update: seed().snapshot }); expect(service.channelStates.get(channel)?.ydoc.getMap('meta').size).toBe(0); }
  finally { await service.shutdown(); }
});
it('seed obtains existing ownership admission and leaves metadata unchanged on retry', async () => {
  const { service, router } = setup(async () => true);
  const admission = jest.fn(async () => false);
  (router as any).subscribeToChannel = admission;
  const leave = jest.fn();
  (router as any).unsubscribeFromChannel = leave;
  try {
    await expect(service.seedDocument('alice', seed())).rejects.toThrow('ownership');
    expect(service.channelStates.has(channel)).toBe(false);
    admission.mockResolvedValue(true);
    const input = { ...seed(), title: 'Source title', type: 'assessment' };
    await service.seedDocument('alice', input);
    const stored = await service.metadataService.metadataStore.getDocument(channel.slice(4));
    expect(stored).toMatchObject({ title: 'Source title', ownerId: 'alice', docType: 'assessment' });
    await service.metadataService.metadataStore.putDocument({ ...stored!, title: 'Changed by owner' });
    await service.seedDocument('alice', input);
    expect((await service.metadataService.metadataStore.getDocument(channel.slice(4)))?.title).toBe('Changed by owner');
    expect(leave).toHaveBeenCalledTimes(2);
  } finally { await service.shutdown(); }
});
