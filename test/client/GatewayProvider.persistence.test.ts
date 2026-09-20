import * as Y from 'yjs';
import { GatewayProvider } from '../../src/client/GatewayProvider';
it('never interprets sync as durable save and preserves failed pending bytes for retry', () => {
  jest.useFakeTimers();
  const doc = new Y.Doc(), send = jest.fn();
  const provider = new GatewayProvider(doc, 'doc:test', send);
  try {
    const empty = new Y.Doc(); provider.applySnapshot(Buffer.from(Y.encodeStateAsUpdate(empty)).toString('base64')); empty.destroy();
    expect(provider.persistenceState).toBe('idle');
    doc.getText('body').insert(0, 'durable');
    expect(provider.persistenceState).toBe('pending');
    jest.advanceTimersByTime(200);
    const frame = send.mock.calls.find(([m]) => m.action === 'update')![0];
    expect(frame.updateId).toBeTruthy();
    provider.applyPersistenceError(frame.updateId);
    expect(provider.persistenceState).toBe('error');
    expect(provider.pendingUpdateCount).toBe(1);
    provider.retryPersistence();
    expect(send).toHaveBeenLastCalledWith(frame);
    provider.applyPersisted('wrong-id');
    expect(provider.pendingUpdateCount).toBe(1);
    provider.applyPersisted(frame.updateId);
    expect(provider.persistenceState).toBe('saved');
    expect(provider.pendingUpdateCount).toBe(0);
  } finally { provider.destroy(); doc.destroy(); jest.useRealTimers(); }
});

it('does not replay discarded pre-restore edits when the provider is destroyed', () => {
  jest.useFakeTimers();
  const doc = new Y.Doc(), send = jest.fn();
  const provider = new GatewayProvider(doc, 'doc:test', send);
  doc.getText('body').insert(0, 'pre-restore edits');
  const recovery = Y.encodeStateAsUpdate(doc);
  provider.discardPendingUpdates();
  provider.destroy();
  expect(send.mock.calls.filter(([frame]) => frame.action === 'update')).toHaveLength(0);
  const recovered = new Y.Doc(); Y.applyUpdate(recovered, recovery);
  expect(recovered.getText('body').toString()).toBe('pre-restore edits');
  recovered.destroy(); doc.destroy(); jest.useRealTimers();
});
