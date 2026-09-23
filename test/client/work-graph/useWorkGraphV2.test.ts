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
});

