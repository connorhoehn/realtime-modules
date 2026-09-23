/**
 * @jest-environment jsdom
 */

// useDocumentFolders — the explorer's folders over the gateway's
// `document-folders` service: subscribe on mount, the tree with nested counts,
// live merge of hub events from other replicas, optimistic moves settled or
// reverted by the server's answer (including a conflict), request ids.

import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { deriveDocumentFolders, mergeDocumentFolderEvent, positionBetween, useDocumentFolders } from '../../src/client/documents/folders';
import type { PipelineRunTransport } from '../../src/client/pipelines';

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const send = jest.fn();
  const transport: PipelineRunTransport = {
    send,
    onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
  };
  const emit = (frame: unknown) => { act(() => { for (const h of Array.from(handlers)) h(frame); }); };
  return { transport, send, emit };
}

const folder = (id: string, name: string, parentFolderId: string | null, version = 1, createdBy = 'alice') => ({
  id, name, parentFolderId, position: 1, createdBy, createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', version, count: 0, directCount: 0,
});

const LIST = {
  type: 'document-folders:list', orgId: 'org1', channel: 'doc-folders:org1', unfiledCount: 1, totalCount: 4,
  folders: [folder('sp', 'Sprint planning', null), folder('mt', 'Meetings', 'sp'), folder('ra', 'Release assets', 'sp')],
  documents: [
    { documentId: 'd1', folderId: 'mt', position: 1, version: 1 },
    { documentId: 'd2', folderId: 'mt', position: 2, version: 1 },
    { documentId: 'd3', folderId: 'ra', position: 1, version: 1 },
    { documentId: 'd4', folderId: null, position: 0, version: 0 },
  ],
};

function sentOf(send: jest.Mock, action: string) {
  return send.mock.calls.map(([f]) => f as Record<string, any>).filter((f) => f.action === action);
}

describe('useDocumentFolders', () => {
  it('subscribes on mount and derives the tree with nested counts', async () => {
    const t = makeTransport();
    const { result, unmount } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1, currentUserId: 'alice' }));
    expect(sentOf(t.send, 'subscribe')).toHaveLength(1);
    expect(sentOf(t.send, 'subscribe')[0]).toMatchObject({ service: 'document-folders', requestId: expect.any(String) });
    expect(result.current.loading).toBe(true);
    t.emit(LIST);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [sprint] = result.current.tree;
    expect(sprint).toMatchObject({ name: 'Sprint planning', count: 3, directCount: 0, depth: 0 });
    expect(sprint.children.map((c) => [c.name, c.count, c.depth])).toEqual([['Meetings', 2, 1], ['Release assets', 1, 1]]);
    expect(sprint.children[0].documentIds).toEqual(['d1', 'd2']);
    expect(result.current.unfiled).toEqual(['d4']);
    expect(result.current.totalCount).toBe(4);
    expect(result.current.folderOf('d3')).toBe('ra');
    expect(result.current.pathOf('mt').map((f) => f.name)).toEqual(['Sprint planning', 'Meetings']);
    unmount();
    expect(sentOf(t.send, 'unsubscribe')).toHaveLength(1);
  });

  it('merges a move made on another replica: counts follow, stale versions and unknown documents are ignored', async () => {
    const t = makeTransport();
    const { result } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1 }));
    t.emit(LIST);
    t.emit({ type: 'document-folders:event', kind: 'documentsMoved', moves: [{ documentId: 'd1', folderId: 'ra', fromFolderId: 'mt', position: 5, version: 2 }] });
    await waitFor(() => expect(result.current.folderOf('d1')).toBe('ra'));
    const counts = Object.fromEntries(result.current.folders.map((f) => [f.name, f.count]));
    expect(counts).toEqual({ 'Sprint planning': 3, Meetings: 1, 'Release assets': 2 });
    // Stale (version 1 again) and a document this viewer was never shown.
    t.emit({ type: 'document-folders:event', kind: 'documentsMoved', moves: [{ documentId: 'd1', folderId: 'mt', position: 1, version: 1 }, { documentId: 'hidden', folderId: 'mt', position: 1, version: 3 }] });
    expect(result.current.folderOf('d1')).toBe('ra');
    expect(result.current.placements.hidden).toBeUndefined();
  });

  it('folder events add, rename and remove folders; a new document starts Unfiled', async () => {
    const t = makeTransport();
    const { result } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1, currentUserId: 'alice' }));
    t.emit(LIST);
    t.emit({ type: 'document-folders:event', kind: 'folderUpserted', folder: folder('rs', 'Research', null, 1, 'alice') });
    await waitFor(() => expect(result.current.folders.map((f) => f.name)).toContain('Research'));
    // Someone else's empty folder is not shown (R1.5) until a visible document lands in it.
    t.emit({ type: 'document-folders:event', kind: 'folderUpserted', folder: folder('bob', 'Bob only', null, 1, 'bob') });
    expect(result.current.folders.map((f) => f.name)).not.toContain('Bob only');
    t.emit({ type: 'document-folders:event', kind: 'folderUpserted', folder: { ...folder('rs', 'Research 2', null, 2) } });
    expect(result.current.folders.find((f) => f.id === 'rs')?.name).toBe('Research 2');
    t.emit({ type: 'document-folders:event', kind: 'folderDeleted', folderId: 'rs' });
    expect(result.current.folders.find((f) => f.id === 'rs')).toBeUndefined();
    t.emit({ type: 'crdt', action: 'documentCreated', document: { id: 'd9' } });
    expect(result.current.unfiled).toContain('d9');
    t.emit({ type: 'crdt', action: 'documentDeleted', documentId: 'd9' });
    expect(result.current.unfiled).not.toContain('d9');
  });

  it('moves optimistically with the version it saw, then settles on the answer', async () => {
    const t = makeTransport();
    const { result } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1 }));
    t.emit(LIST);
    let settled: any;
    act(() => { void result.current.moveDocument('d4', 'mt', 3).then((r) => { settled = r; }); });
    expect(result.current.placements.d4).toMatchObject({ folderId: 'mt', pending: true });
    const [frame] = sentOf(t.send, 'moveDocuments');
    expect(frame.moves).toEqual([{ documentId: 'd4', folderId: 'mt', position: 3, expectedVersion: 0 }]);
    t.emit({ type: 'document-folders:result', requestId: frame.requestId, action: 'moveDocuments', ok: true, results: [{ documentId: 'd4', ok: true, placement: { documentId: 'd4', folderId: 'mt', position: 3, version: 1 } }] });
    await waitFor(() => expect(settled).toMatchObject({ ok: true }));
    expect(result.current.placements.d4).toEqual({ documentId: 'd4', folderId: 'mt', position: 3, version: 1 });
  });

  it('a conflicting move is replaced by the placement the server says is current', async () => {
    const t = makeTransport();
    const { result } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1 }));
    t.emit(LIST);
    let settled: any;
    act(() => { void result.current.moveDocument('d1', 'ra').then((r) => { settled = r; }); });
    const [frame] = sentOf(t.send, 'moveDocuments');
    expect(frame.moves[0].expectedVersion).toBe(1);
    t.emit({
      type: 'document-folders:result', requestId: frame.requestId, action: 'moveDocuments', ok: false, code: 'conflict',
      results: [{ documentId: 'd1', ok: false, code: 'conflict', current: { documentId: 'd1', folderId: null, position: 9, version: 2 } }],
    });
    await waitFor(() => expect(settled).toMatchObject({ ok: false, code: 'conflict' }));
    expect(result.current.placements.d1).toEqual({ documentId: 'd1', folderId: null, position: 9, version: 2 });
    expect(result.current.error).toMatchObject({ code: 'conflict' });
  });

  it('folder mutations carry request ids and the folder version; no answer times out', async () => {
    jest.useFakeTimers();
    try {
      const t = makeTransport();
      const { result } = renderHook(() => useDocumentFolders({ transport: t.transport, sessionEpoch: 1, timeoutMs: 50 }));
      t.emit(LIST);
      let r: any;
      act(() => { void result.current.renameFolder('mt', 'Meetings 2').then((x) => { r = x; }); });
      expect(sentOf(t.send, 'renameFolder')[0]).toMatchObject({ folderId: 'mt', name: 'Meetings 2', expectedVersion: 1, requestId: expect.any(String) });
      await act(async () => { jest.advanceTimersByTime(60); });
      expect(r).toMatchObject({ ok: false, code: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-subscribes on a new session epoch (a reconnect heals missed events)', () => {
    const t = makeTransport();
    const { rerender } = renderHook(({ epoch }) => useDocumentFolders({ transport: t.transport, sessionEpoch: epoch }), { initialProps: { epoch: 1 } });
    rerender({ epoch: 2 });
    expect(sentOf(t.send, 'subscribe')).toHaveLength(2);
  });

  it('pure helpers: positions between neighbours, derivation, merge', () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(undefined, 2)).toBe(1);
    expect(positionBetween(4, undefined)).toBe(5);
    const state = { folders: { a: { ...folder('a', 'A', null), listed: true } }, placements: { x: { documentId: 'x', folderId: 'a', position: 1, version: 1 } } };
    expect(deriveDocumentFolders(state).folders[0]).toMatchObject({ count: 1, directCount: 1 });
    expect(mergeDocumentFolderEvent(state, { kind: 'documentsMoved', moves: [{ documentId: 'x', folderId: null, position: 0, version: 1 }] })).toBe(state);
  });
});
