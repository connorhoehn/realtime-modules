/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { jest } from '@jest/globals';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import type { WorkGraphSnapshotV2 } from '../../../src/work-graph/contractsV2';
import {
  useWorkGraph,
  type WorkGraphClientScope,
  type WorkGraphClientTransport,
  type WorkGraphSocketRequest,
} from '../../../src/client/work-graph/useWorkGraph';

Object.defineProperty(globalThis, 'TextEncoder', { value: NodeTextEncoder, configurable: true });

const scope: WorkGraphClientScope = {
  viewerId: 'viewer_1',
  personId: 'person_owner',
  day: '2026-09-21',
  timezone: 'America/New_York',
};
const windowStart = '2026-09-21T13:15:00.000Z';
const windowEnd = '2026-09-21T13:30:00.000Z';

function snapshotV2(over: Partial<WorkGraphSnapshotV2> = {}): WorkGraphSnapshotV2 {
  const at = windowEnd;
  return {
    schemaVersion: 2,
    scope: { personId: scope.personId, day: scope.day, timezone: scope.timezone, policyRevision: 'policy_1' },
    revision: 1, watermark: 10, cursor: 'cursor_10', partial: false, sources: [],
    query: { schemaVersion: 2, personId: scope.personId, day: scope.day, timezone: scope.timezone, windowStart, windowEnd, mode: 'live' },
    temporal: { mode: 'live', observedAt: at, coverage: { from: windowStart, through: at, complete: true } },
    nodes: [
      { id: 'meeting', kind: 'meeting', title: 'Planning sync', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: [] },
      { id: 'deck', kind: 'document', title: 'Sprint review', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: ['view-document'] },
    ],
    edges: [{ id: 'produced', fromId: 'meeting', toId: 'deck', relation: 'produced', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: [] }],
    efforts: [{ id: 'effort.meeting', anchorNodeId: 'meeting', title: 'Sprint review', subtitle: 'v3 generating · v2 available', nodeIds: ['meeting', 'deck'], edgeIds: ['produced'], contextNodeIds: [] }],
    details: [{ nodeId: 'deck', summary: 'First draft · 09:27', lines: ['2 speakers · 1 action item'], feedback: { count: 2, through: at } }],
    operations: [], eventBuckets: [{ at, count: 2 }],
    ...over,
  };
}

interface Harness {
  transport: WorkGraphClientTransport;
  fetchSnapshot: jest.MockedFunction<WorkGraphClientTransport['fetchSnapshot']>;
  sockets: Array<{ request: WorkGraphSocketRequest; close: jest.Mock }>;
}

function harness(responses: unknown[]): Harness {
  let index = 0;
  const sockets: Harness['sockets'] = [];
  const fetchSnapshot = jest.fn<WorkGraphClientTransport['fetchSnapshot']>(async () => responses[index++]);
  return {
    fetchSnapshot,
    sockets,
    transport: {
      fetchSnapshot,
      openWebSocket(request) {
        const close = jest.fn();
        sockets.push({ request, close });
        return { close };
      },
    },
  };
}

const v2Options = {
  scope,
  schemaVersion: 2 as const,
  window: { start: windowStart, end: windowEnd, mode: 'live' as const },
  createSubscriptionGeneration: () => 'gen_1',
};

describe('useWorkGraph schemaVersion 2 opt-in', () => {
  test('asks for the activity layer and exposes validated efforts, details and buckets', async () => {
    const test = harness([snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(test.fetchSnapshot.mock.calls[0][0].activity).toEqual({
      schemaVersion: 2, windowStart, windowEnd, mode: 'live',
    });
    expect(test.sockets[0].request.activity?.schemaVersion).toBe(2);
    // The v1 graph state is populated exactly as before alongside the new layer.
    expect(result.current.graph.nodes.deck?.title).toBe('Sprint review');
    expect(result.current.graph.activity?.efforts[0].subtitle).toBe('v3 generating · v2 available');
    expect(result.current.graph.activity?.details[0].lines).toEqual(['2 speakers · 1 action item']);
    expect(result.current.graph.activity?.temporal.mode).toBe('live');
  });

  test('refuses a v1 body, and a v2 caller never sees a partially validated activity layer', async () => {
    const v1Body = { ...snapshotV2(), schemaVersion: 1 };
    const test = harness([v1Body, { ...snapshotV2(), details: [{ nodeId: 'not-a-node' }] }]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.error).toBe('invalid-snapshot'));
    expect(result.current.graph.activity).toBeUndefined();
    expect(result.current.graph.nodes).toEqual({});
  });

  test('rejects a window that is not a real interval inside the person local day', async () => {
    const test = harness([snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({
      ...v2Options,
      window: { start: windowEnd, end: windowStart, mode: 'live' },
      transport: test.transport,
    }));
    await waitFor(() => expect(result.current.error).toBe('invalid-query'));
    expect(test.fetchSnapshot).not.toHaveBeenCalled();
  });

  test('accepts an activity refresh for the live generation and drops stale or foreign ones', async () => {
    const test = harness([snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const refreshed = snapshotV2({
      efforts: [{ id: 'effort.meeting', anchorNodeId: 'meeting', title: 'Sprint review', subtitle: 'v3 failed · v2 available', nodeIds: ['meeting', 'deck'], edgeIds: ['produced'], contextNodeIds: [] }],
    });
    act(() => test.sockets[0].request.onMessage({ kind: 'activity', subscriptionGeneration: 'gen_1', policyRevision: 'policy_1', snapshot: refreshed }));
    expect(result.current.graph.activity?.efforts[0].subtitle).toBe('v3 failed · v2 available');

    // A refresh carrying another authorization decision must not be shown.
    act(() => test.sockets[0].request.onMessage({ kind: 'activity', subscriptionGeneration: 'gen_1', policyRevision: 'policy_2', snapshot: snapshotV2() }));
    expect(result.current.graph.activity?.efforts[0].subtitle).toBe('v3 failed · v2 available');
    act(() => test.sockets[0].request.onMessage({ kind: 'activity', subscriptionGeneration: 'other', snapshot: snapshotV2() }));
    expect(result.current.graph.activity?.efforts[0].subtitle).toBe('v3 failed · v2 available');
  });

  test('a v1 caller still sends the original request body and rejects the activity message', async () => {
    const v1Snapshot = { ...snapshotV2(), schemaVersion: 1 as const };
    delete (v1Snapshot as Record<string, unknown>).query;
    delete (v1Snapshot as Record<string, unknown>).temporal;
    delete (v1Snapshot as Record<string, unknown>).efforts;
    delete (v1Snapshot as Record<string, unknown>).details;
    delete (v1Snapshot as Record<string, unknown>).operations;
    delete (v1Snapshot as Record<string, unknown>).eventBuckets;
    const test = harness([v1Snapshot, v1Snapshot]);
    const { result } = renderHook(() => useWorkGraph({
      scope, transport: test.transport, createSubscriptionGeneration: () => 'gen_1',
    }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(Object.keys(test.fetchSnapshot.mock.calls[0][0]).sort()).toEqual(['scope', 'signal']);
    expect(result.current.graph.activity).toBeUndefined();

    // An unknown message kind still forces recovery rather than being ignored.
    act(() => test.sockets[0].request.onMessage({ kind: 'activity', subscriptionGeneration: 'gen_1', snapshot: snapshotV2() }));
    await waitFor(() => expect(test.sockets.length).toBe(2));
  });

  test('applies a schemaVersion 2 delta (graph ops + view) without refetching (NFR #22)', async () => {
    const test = harness([snapshotV2(), snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const at = windowEnd;
    const change = { id: 'change', kind: 'change', title: 'Document change', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: [] };
    const { query, temporal, operations, eventBuckets } = snapshotV2();
    const view = {
      query, temporal, operations, eventBuckets,
      efforts: [{ id: 'effort.meeting', anchorNodeId: 'meeting', title: 'Sprint review', subtitle: 'v3 ready', nodeIds: ['meeting', 'deck', 'change'], edgeIds: ['produced'], contextNodeIds: [] }],
      details: [{ nodeId: 'change', summary: 'Edited', lines: [] }],
    };
    const batch = {
      schemaVersion: 2, subscriptionGeneration: 'gen_1', previousWatermark: 10, watermark: 11,
      cursor: 'cursor_11', policyRevision: 'policy_1', operations: [{ kind: 'upsert-node', node: change }], view,
    };
    act(() => test.sockets[0].request.onMessage({ kind: 'delta', batch }));
    expect(result.current.graph.nodes.change?.title).toBe('Document change');
    expect(result.current.graph.watermark).toBe(11);
    expect(result.current.graph.activity?.efforts[0].subtitle).toBe('v3 ready');
    expect(result.current.graph.activity?.details.map((d) => d.nodeId)).toEqual(['change']);
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(test.sockets).toHaveLength(1);

    // A replayed (already applied) batch is a no-op, not a recovery.
    act(() => test.sockets[0].request.onMessage({ kind: 'delta', batch }));
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test('a v2 delta whose view points at a node the viewer does not hold recovers with a fresh snapshot', async () => {
    const test = harness([snapshotV2(), snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const { query, temporal, operations, eventBuckets, efforts } = snapshotV2();
    const batch = {
      schemaVersion: 2, subscriptionGeneration: 'gen_1', previousWatermark: 10, watermark: 11,
      cursor: 'cursor_11', policyRevision: 'policy_1', operations: [],
      view: { query, temporal, operations, eventBuckets, efforts, details: [{ nodeId: 'hidden', summary: 'x', lines: [] }] },
    };
    act(() => test.sockets[0].request.onMessage({ kind: 'delta', batch }));
    await waitFor(() => expect(test.fetchSnapshot).toHaveBeenCalledTimes(2));
  });

  test('applies viewPatch frames against the last streamed view and asks for them on subscribe (NFR #66)', async () => {
    const test = harness([snapshotV2(), snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(test.sockets[0].request.viewPatch).toBe(1);
    const at = windowEnd;
    const change = { id: 'change', kind: 'change', title: 'Document change', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: [] };
    const base = snapshotV2();
    const { query, temporal, operations, eventBuckets } = base;
    const full = {
      query, temporal, operations, eventBuckets,
      efforts: [{ ...base.efforts[0], nodeIds: ['meeting', 'deck', 'change'] }],
      details: [...base.details, { nodeId: 'change', summary: 'Edited', lines: [] }],
    };
    const frame = (previousWatermark: number, extra: Record<string, unknown>) => ({
      kind: 'delta',
      batch: {
        schemaVersion: 2, subscriptionGeneration: 'gen_1', previousWatermark, watermark: previousWatermark + 1,
        cursor: `cursor_${previousWatermark + 1}`, policyRevision: 'policy_1', operations: [], ...extra,
      },
    });
    act(() => test.sockets[0].request.onMessage({ kind: 'delta', batch: { ...frame(10, {}).batch, operations: [{ kind: 'upsert-node', node: change }], view: full } }));
    expect(result.current.graph.activity?.details.map((d) => d.nodeId)).toEqual(['deck', 'change']);

    // The patch rewrites one detail and removes another; untouched entries survive.
    act(() => test.sockets[0].request.onMessage(frame(11, {
      viewPatch: {
        baseWatermark: 11, query, temporal, operations,
        details: { upsert: [{ nodeId: 'change', summary: 'Edited twice', lines: [] }], remove: ['deck'] },
      },
    })));
    expect(result.current.graph.watermark).toBe(12);
    expect(result.current.graph.activity?.details).toEqual([{ nodeId: 'change', summary: 'Edited twice', lines: [] }]);
    expect(result.current.graph.activity?.efforts[0].nodeIds).toEqual(['meeting', 'deck', 'change']);
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);

    // A patch for a view this reader does not hold resyncs quietly, graph kept.
    act(() => test.sockets[0].request.onMessage(frame(12, {
      viewPatch: { baseWatermark: 7, query, temporal, operations },
    })));
    expect(result.current.error).toBeNull();
    expect(result.current.graph.nodes.change).toBeDefined();
    await waitFor(() => expect(test.fetchSnapshot).toHaveBeenCalledTimes(2));
  });

  test('a viewPatch before any streamed view resyncs instead of patching the snapshot view', async () => {
    const test = harness([snapshotV2(), snapshotV2()]);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const { query, temporal, operations, eventBuckets } = snapshotV2();
    act(() => test.sockets[0].request.onMessage({
      kind: 'delta',
      batch: {
        schemaVersion: 2, subscriptionGeneration: 'gen_1', previousWatermark: 10, watermark: 11,
        cursor: 'cursor_11', policyRevision: 'policy_1', operations: [],
        viewPatch: { baseWatermark: 10, query, temporal, operations },
      },
    }));
    await waitFor(() => expect(test.fetchSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.error).toBeNull();
  });
});

describe('useWorkGraph recovery from transient failures (NFR #68)', () => {
  afterEach(() => jest.useRealTimers());

  /** One act per second: a timer's state update only re-runs the effect once its act ends. */
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      await act(async () => { await jest.advanceTimersByTimeAsync(Math.min(500, ms - elapsed)); });
    }
  }

  function flaky(outcomes: Array<'fail' | 'refuse' | 'ok'>) {
    const test = harness([]);
    let call = 0;
    test.fetchSnapshot.mockImplementation(async () => {
      const outcome = outcomes[call++] ?? 'ok';
      if (outcome === 'fail') throw Object.assign(new Error('fetch failed'), { status: null });
      if (outcome === 'refuse') throw Object.assign(new Error('not shared'), { status: 404 });
      return snapshotV2();
    });
    return test;
  }

  test('retries a failed snapshot with growing, jittered backoff and recovers without a reload', async () => {
    jest.useFakeTimers();
    const test = flaky(['fail', 'fail', 'fail', 'ok']);
    const { result } = renderHook(() => useWorkGraph({
      ...v2Options, transport: test.transport, reconnectDelayMs: 1_000, random: () => 1,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    // 1 s, then 2 s, then 4 s (random = 1 is the top of the jitter range).
    await act(async () => { await jest.advanceTimersByTimeAsync(999); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(1); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(2_000); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    await act(async () => { await jest.advanceTimersByTimeAsync(4_000); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
  });

  test('jitter spreads the retry below the ceiling', async () => {
    jest.useFakeTimers();
    const test = flaky(['fail', 'ok']);
    renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport, reconnectDelayMs: 1_000, random: () => 0 }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await jest.advanceTimersByTimeAsync(500); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  test('reports unavailable only after a sustained outage, keeps retrying, and clears on recovery', async () => {
    jest.useFakeTimers();
    const test = flaky(Array.from({ length: 8 }, () => 'fail' as const));
    const { result } = renderHook(() => useWorkGraph({
      ...v2Options, transport: test.transport, reconnectDelayMs: 1_000, retryMaxDelayMs: 4_000,
      outageGraceMs: 10_000, random: () => 1,
    }));
    await act(async () => { await Promise.resolve(); });
    // Attempts at 0, 1, 3, 7, 11 s (backoff capped at 4 s).
    await advance(7_000);
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBeNull();
    await advance(4_000);
    expect(result.current.error).toBe('snapshot-unavailable');
    await advance(20_000);
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(9);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
  });

  test('a refusal (404) is final: no retry loop', async () => {
    jest.useFakeTimers();
    const test = flaky(['refuse']);
    const { result } = renderHook(() => useWorkGraph({ ...v2Options, transport: test.transport }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toBe('snapshot-unavailable');
    await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
    expect(test.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test('a dropped stream (gateway restart) backs off across repeated drops and resets after a good snapshot', async () => {
    jest.useFakeTimers();
    const test = flaky([]);
    const { result } = renderHook(() => useWorkGraph({
      ...v2Options, transport: test.transport, reconnectDelayMs: 1_000, random: () => 1,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(test.sockets).toHaveLength(1);
    act(() => test.sockets[0].request.onClose());
    expect(result.current.error).toBeNull();
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(test.sockets).toHaveLength(2);
    expect(result.current.status).toBe('ready');
    // The good snapshot reset the backoff: the next drop waits 1 s again.
    act(() => test.sockets[1].request.onError());
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(test.sockets).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });
});
