/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/documentsWork.test.tsx
//
// The Documents four-pane hooks (client/documents): work fields with
// optimistic PATCH + rollback on 409, the Work list grouped by status and kept
// live from id-only `doc-work-scope:*` signals, run drafts with a stable
// request id, and estimates ("No prior runs" when null). Each hook re-reads on
// reconnect and never polls.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  acquireChannelSubscription,
  applyWorkUpdate,
  docWorkSignalFromFrame,
  docWorkScopeChannelMatches,
  groupWorkRows,
  invalidateRunEstimates,
  normalizeRunEstimate,
  runDraftPhase,
  useDocumentWork,
  useRunDraft,
  useRunEstimate,
  useWorkList,
} from '../../src/client/documents';
import type { DocumentWork, RunDraft, WorkListRow } from '../../src/client/documents';
import { usePipelineCatalog } from '../../src/client/pipelines';
import type { PipelineRunTransport } from '../../src/client/pipelines';

const API = 'http://api.test';

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const send = jest.fn();
  const transport: PipelineRunTransport = {
    send,
    onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
  };
  const emit = (frame: unknown) => { act(() => { for (const h of Array.from(handlers)) h(frame); }); };
  return { transport, send, emit, handlers };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Array<{ method: string; match: RegExp; handle: Handler }>;
let fetchMock: jest.Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
const route = (method: string, match: RegExp, handle: Handler) => { routes.unshift({ method, match, handle }); };
const calls = (method: string, match: RegExp) =>
  fetchMock.mock.calls.filter(([u, i]) => (i?.method ?? 'GET') === method && match.test(String(u)));

beforeEach(() => {
  routes = [];
  invalidateRunEstimates();
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const r = routes.find((x) => x.method === method && x.match.test(url));
    if (!r) throw new Error(`unrouted ${method} ${url}`);
    return r.handle(url, init);
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => { jest.restoreAllMocks(); });

const WORK: DocumentWork = {
  documentId: 'd1', organizationId: 'org', status: 'next', points: 3, ownerId: 'u1', rank: 'a',
  criteria: { c1: { text: 'Traces', done: false, rank: 'a' } }, links: {}, fieldRevisions: { status: 1 },
  revision: 2, updatedAt: '2026-09-23T10:00:00.000Z', updatedBy: 'u1', scopeId: 'p1', tracked: true,
};

describe('pure helpers', () => {
  it('applies set, criteria and link ops; null clears a field', () => {
    const next = applyWorkUpdate(WORK, {
      set: { status: 'in_progress', points: null },
      criteria: [{ op: 'check', id: 'c1', done: true }, { op: 'add', id: 'c2', text: 'Logs' }, { op: 'check', id: 'gone', done: true }],
      links: [{ op: 'add', id: 'l1', documentId: 'd9', relation: 'decided-by' }],
    });
    expect(next.status).toBe('in_progress');
    expect('points' in next).toBe(false);
    expect(next.criteria.c1.done).toBe(true);
    expect(next.criteria.c2).toEqual({ text: 'Logs', done: false, rank: 'an' });
    expect(next.links.l1.relation).toBe('decided-by');
    expect(WORK.criteria.c1.done).toBe(false);
  });

  it('groups by work status in order, untracked under "Not planned", rows by rank', () => {
    const rows = [
      { ...WORK, documentId: 'a', status: 'done', rank: 'b' },
      { ...WORK, documentId: 'b', status: undefined },
      { ...WORK, documentId: 'c', status: 'next', rank: 'b' },
      { ...WORK, documentId: 'd', status: 'next', rank: 'a' },
    ] as WorkListRow[];
    const groups = groupWorkRows(rows);
    expect(groups.map((g) => [g.label, g.count])).toEqual([['Next up', 2], ['Done', 1], ['Not planned', 1]]);
    expect(groups[0].rows.map((r) => r.documentId)).toEqual(['d', 'c']);
    expect(groupWorkRows([], { includeEmpty: true })).toHaveLength(5);
  });

  it('reads signals from the payload and ignores other frames', () => {
    expect(docWorkSignalFromFrame({ type: 'doc:work_updated', channel: 'doc-work:d1', payload: { documentId: 'd1', revision: 4, fields: ['status'] } }))
      .toEqual({ type: 'doc:work_updated', documentId: 'd1', revision: 4, fields: ['status'], channel: 'doc-work:d1' });
    expect(docWorkSignalFromFrame({ type: 'doc:run_draft_updated', payload: { documentId: 'd1', draftId: 'r1', status: 'dispatched', revision: 2, runId: 'run1' } }))
      .toMatchObject({ draftId: 'r1', status: 'dispatched', runId: 'run1' });
    expect(docWorkSignalFromFrame({ type: 'doc:comment_added', payload: { documentId: 'd1' } })).toBeUndefined();
  });

  it('an estimate with no runs is null; dispatching over 60 s is unconfirmed', () => {
    expect(normalizeRunEstimate(null)).toBeNull();
    expect(normalizeRunEstimate({ pipelineId: 'p', basis: { runs: 0, repriced: false }, costUsd: null, durationMs: null, confidence: 'none' })).toBeNull();
    const d = { status: 'dispatching', updatedAt: '2026-09-23T10:00:00.000Z' } as RunDraft;
    expect(runDraftPhase(d, Date.parse('2026-09-23T10:00:30.000Z'))).toBe('dispatching');
    expect(runDraftPhase(d, Date.parse('2026-09-23T10:01:01.000Z'))).toBe('unconfirmed');
    expect(runDraftPhase(null)).toBe('none');
  });

  it('refcounts a channel per transport and re-sends on a new epoch', () => {
    const send = jest.fn();
    const r1 = acquireChannelSubscription(send, 'k', 'sub', 'unsub', 1);
    const r2 = acquireChannelSubscription(send, 'k', 'sub', 'unsub', 1);
    expect(send.mock.calls).toEqual([['sub']]);
    r1();
    r1();
    expect(send).toHaveBeenCalledTimes(1);
    // Reconnect: the effect re-runs, and the first acquirer on the new epoch re-sends.
    r2();
    expect(send.mock.calls).toEqual([['sub'], ['unsub']]);
    const a = acquireChannelSubscription(send, 'k', 'sub', 'unsub', 1);
    const b = acquireChannelSubscription(send, 'k', 'sub', 'unsub', 1);
    b();
    const b2 = acquireChannelSubscription(send, 'k', 'sub', 'unsub', 2);
    expect(send.mock.calls.slice(2)).toEqual([['sub'], ['sub']]);
    a(); b2();
    expect(send.mock.calls.at(-1)).toEqual(['unsub']);
  });
});

describe('useDocumentWork', () => {
  it('reads, subscribes doc-work:<id>, applies an edit optimistically and keeps the saved row', async () => {
    let row = { ...WORK };
    route('GET', /\/api\/documents\/d1\/work$/, () => response(row));
    let release!: () => void;
    route('PATCH', /\/api\/documents\/d1\/work$/, (_u, init) => new Promise((resolve) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ expectedRevision: 2, set: { status: 'in_progress' } });
      row = { ...row, status: 'in_progress', revision: 3 };
      release = () => resolve(response(row));
    }));
    const { transport, send } = makeTransport();
    const { result } = renderHook(() => useDocumentWork('d1', { apiBaseUrl: API, idToken: 't', transport, documentGrant: 'g1' }));
    await waitFor(() => expect(result.current.work?.revision).toBe(2));
    expect(send).toHaveBeenCalledWith({ service: 'doc-work', action: 'subscribe', documentId: 'd1', documentGrant: 'g1' });
    expect(result.current.tracked).toBe(true);

    let saved: Promise<DocumentWork>;
    act(() => { saved = result.current.update({ set: { status: 'in_progress' } }); });
    await waitFor(() => expect(result.current.work?.status).toBe('in_progress'));
    expect(result.current.pending).toBe(1);
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => { release(); await saved; });
    expect(result.current.pending).toBe(0);
    expect(result.current.work?.revision).toBe(3);
  });

  it('rolls back on 409, reports the conflict, and re-reads', async () => {
    route('GET', /\/api\/documents\/d1\/work$/, () => response(WORK));
    route('PATCH', /\/api\/documents\/d1\/work$/, () => response({ error: 'conflict', message: 'points changed', fields: ['points'] }, 409));
    const { transport } = makeTransport();
    const { result } = renderHook(() => useDocumentWork('d1', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(result.current.work).not.toBeNull());
    const getsBefore = calls('GET', /\/work$/).length;
    await act(async () => { await expect(result.current.update({ set: { points: 8 } })).rejects.toMatchObject({ status: 409 }); });
    expect(result.current.work?.points).toBe(3);
    expect(result.current.conflict).toEqual({ fields: ['points'], message: 'points changed' });
    await waitFor(() => expect(calls('GET', /\/work$/).length).toBe(getsBefore + 1));
  });

  it('re-reads on a newer signal, ignores a stale one, and re-reads + resubscribes on reconnect', async () => {
    let row = { ...WORK };
    route('GET', /\/api\/documents\/d1\/work$/, () => response(row));
    const { transport, send, emit } = makeTransport();
    const { result, rerender } = renderHook(({ epoch }) => useDocumentWork('d1', { apiBaseUrl: API, idToken: 't', transport, sessionEpoch: epoch }), { initialProps: { epoch: 1 } });
    await waitFor(() => expect(result.current.work?.revision).toBe(2));
    const reads = () => calls('GET', /\/work$/).length;

    emit({ type: 'doc:work_updated', channel: 'doc-work:d1', payload: { documentId: 'd1', revision: 2 } });
    emit({ type: 'doc:work_updated', channel: 'doc-work:d2', payload: { documentId: 'd2', revision: 9 } });
    expect(reads()).toBe(1);

    row = { ...row, points: 5, revision: 3 };
    emit({ type: 'doc:work_updated', channel: 'doc-work:d1', payload: { documentId: 'd1', revision: 3, fields: ['points'] } });
    await waitFor(() => expect(result.current.work?.points).toBe(5));
    expect(reads()).toBe(2);

    const subs = () => send.mock.calls.filter(([f]) => (f as { action?: string }).action === 'subscribe').length;
    expect(subs()).toBe(1);
    rerender({ epoch: 2 });
    await waitFor(() => expect(reads()).toBe(3));
    expect(subs()).toBe(2);
  });
});

describe('useWorkList', () => {
  const ROWS = [
    { ...WORK, documentId: 'd1', status: 'next', points: 3, activeRun: { runId: 'run1', pipelineId: 'p-x', status: 'running' } },
    { ...WORK, documentId: 'd2', status: 'done', points: 5, activeRun: null },
    { documentId: 'd3', organizationId: 'org', revision: 0, tracked: false },
  ];

  it('groups rows, moves a row on the scope signal at once, then re-reads only that record', async () => {
    route('GET', /\/api\/document-work\?scope=p1$/, () => response({ scope: 'p1', rows: ROWS, rollup: { pointsDone: 5, pointsTotal: 8, decisions: 1, agents: 1, spentUsd: 0.4 } }));
    let d1 = { ...WORK, status: 'in_review', points: 4, revision: 3 };
    route('GET', /\/api\/documents\/d1\/work$/, () => response(d1));
    const { transport, send, emit } = makeTransport();
    const { result } = renderHook(() => useWorkList('p1', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(send).toHaveBeenCalledWith({ service: 'doc-work', action: 'subscribe', scopeId: 'p1' });
    expect(result.current.groups().map((g) => g.key)).toEqual(['next', 'done', 'not_planned']);
    expect(result.current.rollup).toMatchObject({ pointsDone: 5, pointsTotal: 8, spentUsd: 0.4 });

    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:p1', payload: { documentId: 'd1', revision: 3, status: 'in_review', rank: 'a' } });
    expect(result.current.rows.find((r) => r.documentId === 'd1')?.status).toBe('in_review');
    await waitFor(() => expect(result.current.rows.find((r) => r.documentId === 'd1')?.points).toBe(4));
    expect(calls('GET', /document-work/)).toHaveLength(1);
    expect(result.current.rows.find((r) => r.documentId === 'd1')?.activeRun?.runId).toBe('run1');
    expect(result.current.rollup).toMatchObject({ pointsDone: 5, pointsTotal: 9 });

    // A new document joins the scope.
    route('GET', /\/api\/documents\/d4\/work$/, () => response({ ...WORK, documentId: 'd4', status: 'next', revision: 1 }));
    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:p1', payload: { documentId: 'd4', revision: 1, status: 'next' } });
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    // One that moved to another scope leaves.
    d1 = { ...d1, scopeId: 'p2', revision: 4 };
    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:p1', payload: { documentId: 'd1', revision: 4 } });
    await waitFor(() => expect(result.current.rows.map((r) => r.documentId)).not.toContain('d1'));
  });

  it('a type scope follows the org-qualified channel the gateway subscribes (doc-work-scope:<org>:type:<t>)', async () => {
    expect(docWorkScopeChannelMatches('doc-work-scope:dev-org:type:page', 'type:page')).toBe(true);
    expect(docWorkScopeChannelMatches('doc-work-scope:type:page', 'type:page')).toBe(true);
    expect(docWorkScopeChannelMatches('doc-work-scope:dev-org:type:deck', 'type:page')).toBe(false);
    expect(docWorkScopeChannelMatches('doc-work-scope:a:b:type:page', 'type:page')).toBe(false);
    expect(docWorkScopeChannelMatches('doc-work-scope:dev-org:p1', 'p1')).toBe(false);
    route('GET', /\/api\/document-work\?scope=type%3Apage$/, () => response({ scope: 'type:page', rows: [{ ...WORK, documentId: 'd1', status: 'next', revision: 1, scopeId: 'type:page' }], rollup: {} }));
    route('GET', /\/api\/documents\/d5\/work$/, () => response({ ...WORK, documentId: 'd5', status: 'next', revision: 1, scopeId: 'type:page' }));
    const { transport, send, emit } = makeTransport();
    const { result } = renderHook(() => useWorkList('type:page', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(send).toHaveBeenCalledWith({ service: 'doc-work', action: 'subscribe', scopeId: 'type:page' });
    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:dev-org:type:page', payload: { documentId: 'd1', revision: 2, status: 'in_progress' } });
    expect(result.current.rows[0].status).toBe('in_progress');
    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:dev-org:type:page', payload: { documentId: 'd5', revision: 1, status: 'next' } });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    emit({ type: 'doc:work_updated', channel: 'doc-work-scope:dev-org:type:deck', payload: { documentId: 'd1', revision: 3, status: 'done' } });
    expect(result.current.rows.find((r) => r.documentId === 'd1')?.status).toBe('in_progress');
  });

  it('follows a row’s run on pipeline:all, sharing one subscription with the catalog', async () => {
    route('GET', /\/api\/document-work\?scope=p1$/, () => response({ rows: ROWS, rollup: {} }));
    route('GET', /\/api\/pipelines\/defs/, () => response({ pipelines: [] }));
    const { transport, send, emit } = makeTransport();
    const list = renderHook(() => useWorkList('p1', { apiBaseUrl: API, idToken: 't', transport }));
    const catalog = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(list.result.current.rows).toHaveLength(3));
    const pipelineSubs = () => send.mock.calls.filter(([f]) => (f as { channel?: string }).channel === 'pipeline:all');
    expect(pipelineSubs()).toHaveLength(1);

    emit({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'run1', pipelineId: 'p-x', completedAt: '2026-09-23T11:00:00.000Z' } });
    expect(list.result.current.rows[0].activeRun?.status).toBe('completed');

    catalog.unmount();
    expect(pipelineSubs()).toHaveLength(1);
    list.unmount();
    expect(pipelineSubs().at(-1)?.[0]).toMatchObject({ action: 'unsubscribe' });
  });
});

describe('useRunDraft', () => {
  const DRAFT: RunDraft = {
    documentId: 'd1', draftId: 'dr1', organizationId: 'org', createdBy: 'u1', pipelineId: 'p-x', instruction: 'Plan it',
    status: 'draft', revision: 1, updatedAt: '2026-09-23T10:00:00.000Z',
  };

  it('keeps one draft id across a resend, and a double dispatch is one POST', async () => {
    route('GET', /\/run-drafts$/, () => response({ drafts: [] }));
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let fail = true;
    route('PUT', /\/run-drafts\/[^/]+$/, (url, init) => {
      puts.push({ url, body: JSON.parse(String(init?.body)) });
      if (fail) { fail = false; return response({ error: 'timeout' }, 503); }
      return response({ ...DRAFT, draftId: url.split('/').pop()! });
    });
    const { transport } = makeTransport();
    const { result } = renderHook(() => useRunDraft('d1', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.phase).toBe('none');
    const minted = result.current.draftId;

    await act(async () => { await expect(result.current.save({ pipelineId: 'p-x', instruction: 'Plan it' })).rejects.toMatchObject({ status: 503 }); });
    await act(async () => { await result.current.save({ pipelineId: 'p-x', instruction: 'Plan it' }); });
    expect(puts.map((p) => p.url.split('/').pop())).toEqual([minted, minted]);
    expect(result.current.draft?.draftId).toBe(minted);
    expect(result.current.phase).toBe('draft');

    let resolveDispatch!: (r: Response) => void;
    route('POST', /\/dispatch$/, () => new Promise((r) => { resolveDispatch = r; }));
    let p1!: Promise<RunDraft>, p2!: Promise<RunDraft>;
    act(() => { p1 = result.current.dispatch(); p2 = result.current.dispatch(); });
    expect(p1).toBe(p2);
    await waitFor(() => expect(resolveDispatch).toBeDefined());
    await act(async () => { resolveDispatch(response({ ...DRAFT, draftId: minted, status: 'dispatched', runId: 'run9', revision: 3 })); await p1; });
    expect(calls('POST', /\/dispatch$/)).toHaveLength(1);
    expect(result.current.phase).toBe('dispatched');
    // The next save starts the next draft.
    expect(result.current.draftId).not.toBe(minted);

    route('POST', /\/api\/pipelines\/run9\/cancel$/, () => response({ ok: true }));
    await act(async () => { await result.current.stop('user'); });
    expect(calls('POST', /run9\/cancel$/)[0][1]?.headers).toMatchObject({ 'Idempotency-Key': 'run-draft-cancel:run9' });
  });

  it('restores from the draft row on load and re-reads the draft on its signal', async () => {
    route('GET', /\/run-drafts$/, () => response({ drafts: [{ ...DRAFT, status: 'cancelled', draftId: 'old', updatedAt: '2026-09-23T11:00:00.000Z' }, { ...DRAFT, status: 'dispatched', runId: 'run1', revision: 3 }] }));
    route('GET', /\/run-drafts\/dr1$/, () => response({ ...DRAFT, status: 'dispatched', runId: 'run1', revision: 4, dispatchedBy: 'u1' }));
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => useRunDraft('d1', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(result.current.draft?.runId).toBe('run1'));
    expect(result.current.draft?.draftId).toBe('dr1');
    emit({ type: 'doc:run_draft_updated', channel: 'doc-work:d1', payload: { documentId: 'd1', draftId: 'dr1', status: 'dispatched', revision: 4, runId: 'run1' } });
    await waitFor(() => expect(result.current.draft?.revision).toBe(4));
  });
});

describe('useRunEstimate', () => {
  it('says "No prior runs" for null, shares one read, and re-reads when a run of that pipeline completes', async () => {
    let body: unknown = null;
    route('GET', /\/api\/pipelines\/p-x\/estimate\?model=haiku$/, () => response(body));
    const { transport, emit } = makeTransport();
    const a = renderHook(() => useRunEstimate('p-x', 'haiku', { apiBaseUrl: API, idToken: 't', transport }));
    const b = renderHook(() => useRunEstimate('p-x', 'haiku', { apiBaseUrl: API, idToken: 't', transport }));
    await waitFor(() => expect(a.result.current.noPriorRuns).toBe(true));
    await waitFor(() => expect(b.result.current.noPriorRuns).toBe(true));
    expect(a.result.current.estimate).toBeNull();
    expect(calls('GET', /estimate/)).toHaveLength(1);

    body = { pipelineId: 'p-x', basis: { runs: 3, model: 'haiku', repriced: true }, costUsd: { low: 0.03, high: 0.3 }, durationMs: { low: 60000, high: 360000 }, confidence: 'medium' };
    emit({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'r5', pipelineId: 'other' } });
    expect(calls('GET', /estimate/)).toHaveLength(1);
    emit({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'r6', pipelineId: 'p-x' } });
    await waitFor(() => expect(a.result.current.estimate?.costUsd).toEqual({ low: 0.03, high: 0.3 }));
    await waitFor(() => expect(b.result.current.estimate?.basis.runs).toBe(3));
    expect(a.result.current.noPriorRuns).toBe(false);
    expect(calls('GET', /estimate/)).toHaveLength(2);
  });
});
