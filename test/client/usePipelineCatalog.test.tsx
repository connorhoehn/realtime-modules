/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/usePipelineCatalog.test.tsx
//
// The catalog hook: one read of `GET /api/pipelines/defs?include=rollup`,
// then the `pipeline:all` frames keep each row's rollup current without a
// refetch; a reconnect resubscribes and refreshes once. Plus the `/generate`
// helper's idempotency key.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  usePipelineCatalog,
  generatePipelineDraft,
  newPipelineDraftRequestId,
  fetchPipelineCatalog,
  statusPillFor,
} from '../../src/client/pipelines';
import type { PipelineCatalogEntry, PipelineCatalogRequestError, PipelineRunTransport } from '../../src/client/pipelines';

const API = 'http://api.test';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const send = jest.fn();
  const transport: PipelineRunTransport = {
    send,
    onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
  };
  const emit = (eventType: string, payload: Record<string, unknown>) => {
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType, payload, channel: 'pipeline:all' }); });
  };
  return { transport, send, emit, handlers };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const DOC: PipelineCatalogEntry = {
  id: 'document-agent-edit', name: 'Document edit', version: 3, status: 'published', kind: 'document', workType: 'documents',
  route: ['/doc', 'Read', 'Plan', 'Approval', 'Suggestions'], createdAt: iso(10 * HOUR), updatedAt: iso(HOUR), createdBy: 'system', readOnly: true,
  rollup: {
    pipelineId: 'document-agent-edit', lastRunId: 'r2', lastRunAt: iso(29 * MIN), lastRunStatus: 'completed',
    recent: [
      { runId: 'r2', status: 'completed', startedAt: iso(29 * MIN), completedAt: iso(28 * MIN), at: iso(28 * MIN) },
      { runId: 'r1', status: 'failed', startedAt: iso(2 * HOUR), completedAt: iso(2 * HOUR - 1000), at: iso(2 * HOUR - 1000) },
    ],
    failedOfRecent: 1, runningCount: 0, runCount: 2, updatedAt: iso(28 * MIN),
  },
  pendingApprovals: 2,
};
const LOOP = { id: 'agent-weekly-digest', name: 'Weekly digest', version: 1, status: 'draft', kind: 'agent', createdAt: iso(HOUR), updatedAt: iso(HOUR), createdBy: 'u1' };

let fetchMock: jest.Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  fetchMock = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockResolvedValue(response({ pipelines: [DOC, LOOP] }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('usePipelineCatalog', () => {
  it('reads the list with the rollup, subscribes the firehose, and groups the rows', async () => {
    const { transport, send } = makeTransport();
    const { result } = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/pipelines/defs?include=rollup`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });

    expect(result.current.entries).toHaveLength(2);
    // A platform that predates the rollup, or a definition with none yet, reads as `null`, not undefined.
    expect(result.current.entries[1].rollup).toBeNull();
    // The platform's live approval count wins over the rollup's when the entry carries it.
    expect(result.current.summaries[0].pendingApprovals).toBe(2);
    const groups = result.current.groups();
    expect(groups.map((g) => [g.key, g.entries.map((e) => e.id)])).toEqual([
      ['documents', ['document-agent-edit']],
      ['agents', ['agent-weekly-digest']],
    ]);
    expect(statusPillFor(result.current.summaries[0], NOW).text).toBe('1 of 2 failed · 29m ago');
    expect(statusPillFor(result.current.summaries[1], NOW).text).toBe('Draft');
  });

  it('a run.started then run.completed frame moves the row without a refetch', async () => {
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.entries;

    emit('pipeline.run.started', { runId: 'r3', pipelineId: 'document-agent-edit', startedAt: iso(3 * MIN) });
    expect(result.current.entries).not.toBe(before);
    expect(result.current.entries[1]).toBe(before[1]);
    expect(result.current.summaries[0]).toMatchObject({ lastRunId: 'r3', lastRunStatus: 'running', runningCount: 1, totalCount: 3 });
    expect(statusPillFor(result.current.summaries[0], NOW).text).toBe('Running · 3m ago');

    emit('pipeline.run.completed', { runId: 'r3', pipelineId: 'document-agent-edit', completedAt: iso(MIN) });
    expect(result.current.summaries[0]).toMatchObject({ lastRunId: 'r3', lastRunStatus: 'completed', runningCount: 0, failedCount: 1, totalCount: 3 });
    expect(result.current.entries[0].rollup).toMatchObject({ updatedAt: iso(MIN) });
    expect(statusPillFor(result.current.summaries[0], NOW).text).toBe('1 of 3 failed · 3m ago');

    // A duplicate delivery (MQ + Redis copies) changes nothing.
    const settled = result.current.entries;
    emit('pipeline.run.completed', { runId: 'r3', pipelineId: 'document-agent-edit', completedAt: iso(MIN) });
    expect(result.current.entries).toBe(settled);

    // Steps and tokens are not rollup events; a run of an unlisted pipeline is not invented.
    emit('pipeline.step.completed', { runId: 'r3', pipelineId: 'document-agent-edit', stepId: 'apply' });
    emit('pipeline.run.started', { runId: 'x', pipelineId: 'not-in-the-list' });
    expect(result.current.entries).toBe(settled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a run.failed frame on a row with no rollup yet starts one, and the pill turns red', async () => {
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit('pipeline.run.failed', { runId: 'l1', pipelineId: 'agent-weekly-digest', failedAt: iso(10 * HOUR), startedAt: iso(10 * HOUR + MIN) });
    expect(result.current.summaries[1]).toMatchObject({ lastRunStatus: 'failed', failedCount: 1, totalCount: 1, rollupPending: false });
    expect(statusPillFor(result.current.summaries[1], NOW).text).toBe('Failed · 10h ago');
  });

  it('a reconnect (new session epoch) resubscribes and refreshes exactly once', async () => {
    const { transport, send } = makeTransport();
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport, sessionEpoch: epoch }),
      { initialProps: { epoch: 1 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const subscribes = () => send.mock.calls.filter((c) => (c[0] as { action?: string }).action === 'subscribe').length;
    expect(subscribes()).toBe(1);

    rerender({ epoch: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(subscribes()).toBe(1);

    rerender({ epoch: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(subscribes()).toBe(2);
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:all' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refresh() re-reads; a failed read keeps the last list and reports the error', async () => {
    const { transport } = makeTransport();
    const { result } = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(response({ error: 'boom' }, 500));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.loading).toBe(false);
  });

  it('with no token nothing is read; with `transport: null` nothing is subscribed', async () => {
    const { transport, send } = makeTransport();
    const a = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: null, transport }));
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a.result.current.entries).toEqual([]);
    // The socket is still subscribed — a token arriving later starts the read, and frames already flow.
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    const b = renderHook(() => usePipelineCatalog({ apiBaseUrl: API, idToken: 'tok', transport: null }));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(send).not.toHaveBeenCalled();
    expect(b.result.current.entries).toHaveLength(2);
  });
});

describe('fetchPipelineCatalog', () => {
  it('normalises a list from a platform without rollups and throws the server message on failure', async () => {
    fetchMock.mockResolvedValueOnce(response({ pipelines: [{ id: 'a', name: 'A', version: 1, status: 'draft', createdAt: 'x', updatedAt: 'x' }, { nope: true }] }));
    const list = await fetchPipelineCatalog(API, 'tok');
    expect(list).toHaveLength(1);
    expect(list[0].rollup).toBeNull();
    fetchMock.mockResolvedValueOnce(response({ error: 'forbidden' }, 403));
    await expect(fetchPipelineCatalog(API, 'tok')).rejects.toMatchObject({ message: 'forbidden', status: 403 });
  });
});

describe('generatePipelineDraft', () => {
  const planned = { pipeline: { ...LOOP, id: 'agent-digest-a1b2c3', origin: { kind: 'agent', plannerSource: 'model' } }, planner: { source: 'model', steps: 4 } };

  it('posts the instruction with the action and carries the request id in the body and the Idempotency-Key header', async () => {
    fetchMock.mockResolvedValueOnce(response(planned));
    const out = await generatePipelineDraft(API, 'tok', { instruction: 'Summarise the week [200k]', mode: 'draft', requestId: 'req-1', hints: ['docs'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/pipelines/defs/generate`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('req-1');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init?.body as string)).toEqual({ instruction: 'Summarise the week [200k]', mode: 'draft', requestId: 'req-1', hints: ['docs'] });
    expect(out.requestId).toBe('req-1');
    expect(out.pipeline.id).toBe('agent-digest-a1b2c3');
    expect(out.planner).toEqual({ source: 'model', steps: 4 });
  });

  it('generates one request id per call when none is given, and a retry with that id sends the same key', async () => {
    fetchMock.mockResolvedValue(response(planned));
    const a = await generatePipelineDraft(API, 'tok', { instruction: 'x', mode: 'run' });
    const b = await generatePipelineDraft(API, 'tok', { instruction: 'x', mode: 'run' });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(a.requestId).toMatch(uuid);
    expect(b.requestId).toMatch(uuid);
    expect(a.requestId).not.toBe(b.requestId);
    const keyOf = (i: number) => (fetchMock.mock.calls[i][1]?.headers as Record<string, string>)['Idempotency-Key'];
    expect(keyOf(0)).toBe(a.requestId);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).requestId).toBe(a.requestId);

    const retry = await generatePipelineDraft(API, 'tok', { instruction: 'x', mode: 'run', requestId: a.requestId });
    expect(retry.requestId).toBe(a.requestId);
    expect(keyOf(2)).toBe(a.requestId);
    expect(newPipelineDraftRequestId()).toMatch(uuid);
  });

  it('a 422 surfaces the planner code and detail', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'invalid_instruction', detail: 'Say what the loop should do.' }, 422));
    const err = await generatePipelineDraft(API, 'tok', { instruction: '', mode: 'draft' }).catch((e: PipelineCatalogRequestError) => e);
    expect(err).toMatchObject({ status: 422, code: 'invalid_instruction', detail: 'Say what the loop should do.', message: 'Say what the loop should do.' });
    fetchMock.mockResolvedValueOnce(response({ error: 'idempotency_in_progress' }, 409));
    const busy = await generatePipelineDraft(API, 'tok', { instruction: 'x', mode: 'run', requestId: 'k' }).catch((e: PipelineCatalogRequestError) => e);
    expect(busy).toMatchObject({ status: 409, code: 'idempotency_in_progress' });
    fetchMock.mockResolvedValueOnce(response({ ...planned, runError: 'no devbox' }));
    await expect(generatePipelineDraft(API, 'tok', { instruction: 'x', mode: 'run' })).resolves.toMatchObject({ runError: 'no devbox', requestId: expect.any(String) });
  });
});
