/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { jest } from '@jest/globals';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import type {
  ViewerWorkNode,
  WorkGraphDeltaBatch,
  WorkGraphSnapshot,
} from '../../../src/work-graph/contracts';
import {
  useWorkGraph,
  type WorkGraphClientScope,
  type WorkGraphClientTransport,
  type WorkGraphSocketRequest,
} from '../../../src/client/work-graph/useWorkGraph';
import { validateWorkGraphDeltaBatch } from '../../../src/work-graph/validation';

Object.defineProperty(globalThis, 'TextEncoder', { value: NodeTextEncoder, configurable: true });

const baseScope: WorkGraphClientScope = {
  viewerId: 'viewer_1',
  personId: 'person_owner',
  day: '2026-09-19',
  timezone: 'America/New_York',
};

function node(id: string): ViewerWorkNode {
  return {
    id,
    kind: 'task',
    title: id,
    status: 'running',
    disclosure: 'summary',
    updatedAt: '2026-09-19T14:00:00.000Z',
    capabilities: [],
  };
}

function snapshot(scope = baseScope, nodes = [node('node_a')], watermark = 10): WorkGraphSnapshot {
  return {
    schemaVersion: 1,
    scope: {
      personId: scope.personId,
      day: scope.day,
      timezone: scope.timezone,
      policyRevision: 'policy_1',
    },
    revision: 1,
    watermark,
    cursor: `cursor_${watermark}`,
    nodes,
    edges: [],
    sources: [],
    partial: false,
  };
}

function delta(generation: string, overrides: Partial<WorkGraphDeltaBatch> = {}): unknown {
  return {
    kind: 'delta',
    batch: {
      schemaVersion: 1,
      subscriptionGeneration: generation,
      previousWatermark: 10,
      watermark: 11,
      cursor: 'cursor_11',
      policyRevision: 'policy_1',
      operations: [{ kind: 'upsert-node', node: node('node_b') }],
      ...overrides,
    },
  };
}

interface Harness {
  transport: WorkGraphClientTransport;
  fetchSnapshot: jest.MockedFunction<WorkGraphClientTransport['fetchSnapshot']>;
  sockets: Array<{ request: WorkGraphSocketRequest; close: jest.Mock }>;
}

function harness(responses: Array<WorkGraphSnapshot | Promise<WorkGraphSnapshot>>): Harness {
  let response = 0;
  const sockets: Harness['sockets'] = [];
  const fetchSnapshot = jest.fn<WorkGraphClientTransport['fetchSnapshot']>(async () => responses[response++]);
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

function generations(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `gen_${index}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useWorkGraph', () => {
  test('bootstraps an authenticated snapshot cursor and applies validated deltas', async () => {
    const testHarness = harness([snapshot()]);
    const { result } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      createSubscriptionGeneration: generations('gen_1'),
    }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.graph.nodes.node_a).toBeDefined();
    expect(testHarness.sockets[0].request.cursor).toBe('cursor_10');
    expect(testHarness.sockets[0].request.subscriptionGeneration).toBe('gen_1');

    const nextDelta = delta('gen_1');
    expect(validateWorkGraphDeltaBatch((nextDelta as { batch: unknown }).batch).ok).toBe(true);
    act(() => testHarness.sockets[0].request.onMessage(nextDelta));
    expect(result.current.graph.nodes.node_b).toBeDefined();
    expect(result.current.graph.watermark).toBe(11);

    // Authentication remains an adapter concern: no token or URL surface is
    // available for accidental query-string or React-state leakage.
    expect(Object.keys(testHarness.fetchSnapshot.mock.calls[0][0]).sort()).toEqual(['scope', 'signal']);
    expect(Object.keys(testHarness.sockets[0].request).sort()).toEqual([
      'cursor', 'onClose', 'onError', 'onMessage', 'scope', 'subscriptionGeneration',
    ]);
  });

  test('closes the old stream and refetches after an exact replay gap', async () => {
    const testHarness = harness([snapshot(), snapshot(baseScope, [node('node_refetched')], 20)]);
    const { result } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      reconnectDelayMs: 0,
      createSubscriptionGeneration: generations('gen_1', 'gen_2'),
    }));
    await waitFor(() => expect(testHarness.sockets).toHaveLength(1));

    act(() => testHarness.sockets[0].request.onMessage(delta('gen_1', {
      previousWatermark: 12,
      watermark: 13,
    })));

    await waitFor(() => expect(testHarness.fetchSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.graph.nodes.node_refetched).toBeDefined());
    expect(testHarness.sockets[0].close).toHaveBeenCalledTimes(1);
    expect(result.current.graph.nodes.node_a).toBeUndefined();
    expect(testHarness.sockets[1].request.subscriptionGeneration).toBe('gen_2');
  });

  test('treats a malformed delta as untrusted and recovers from a fresh snapshot', async () => {
    const testHarness = harness([snapshot(), snapshot(baseScope, [node('node_after_invalid')], 30)]);
    const { result } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      reconnectDelayMs: 0,
      createSubscriptionGeneration: generations('gen_1', 'gen_2'),
    }));
    await waitFor(() => expect(testHarness.sockets).toHaveLength(1));

    act(() => testHarness.sockets[0].request.onMessage(delta('gen_1', { watermark: 10 })));

    await waitFor(() => expect(result.current.graph.nodes.node_after_invalid).toBeDefined());
    expect(testHarness.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.graph.nodes.node_a).toBeUndefined();
  });

  test('clears disclosed data immediately when a subscription expires before retrying', async () => {
    const retrySnapshot = deferred<WorkGraphSnapshot>();
    const testHarness = harness([snapshot(), retrySnapshot.promise]);
    const { result } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      reconnectDelayMs: 0,
      createSubscriptionGeneration: generations('gen_1', 'gen_2'),
    }));
    await waitFor(() => expect(result.current.graph.nodes.node_a).toBeDefined());

    act(() => testHarness.sockets[0].request.onMessage({
      kind: 'invalidate',
      subscriptionGeneration: 'gen_1',
      reason: 'sharing-expired',
    }));

    await waitFor(() => expect(testHarness.fetchSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('loading');
    expect(result.current.graph.nodes).toEqual({});

    await act(async () => retrySnapshot.resolve(snapshot(baseScope, [node('node_still_authorized')], 20)));
    await waitFor(() => expect(result.current.graph.nodes.node_still_authorized).toBeDefined());
  });

  test('scope changes abort and unsubscribe, and late results cannot mix viewers', async () => {
    const oldSnapshot = deferred<WorkGraphSnapshot>();
    const newScope = { ...baseScope, viewerId: 'viewer_2', personId: 'person_other', day: '2026-09-18' };
    const testHarness = harness([oldSnapshot.promise, snapshot(newScope, [node('node_other')])]);
    const options = {
      transport: testHarness.transport,
      createSubscriptionGeneration: generations('gen_1', 'gen_2'),
    };
    const { result, rerender } = renderHook(
      ({ scope }: { scope: WorkGraphClientScope }) => useWorkGraph({ ...options, scope }),
      { initialProps: { scope: baseScope } },
    );
    await waitFor(() => expect(testHarness.fetchSnapshot).toHaveBeenCalledTimes(1));

    rerender({ scope: newScope });
    expect(result.current.graph.nodes).toEqual({});
    expect(result.current.graph.scope.personId).toBe('person_other');
    await waitFor(() => expect(result.current.graph.nodes.node_other).toBeDefined());

    await act(async () => oldSnapshot.resolve(snapshot(baseScope, [node('private_old_viewer')])));
    expect(result.current.graph.nodes.private_old_viewer).toBeUndefined();
    expect(testHarness.fetchSnapshot.mock.calls[0][0].signal.aborted).toBe(true);
  });

  test('scope changes close an established socket and discard its late packets', async () => {
    const newScope = { ...baseScope, viewerId: 'viewer_2', personId: 'person_other', day: '2026-09-18' };
    const testHarness = harness([snapshot(), snapshot(newScope, [node('node_other')])]);
    const createSubscriptionGeneration = generations('gen_1', 'gen_2');
    const { result, rerender } = renderHook(
      ({ scope }: { scope: WorkGraphClientScope }) => useWorkGraph({
        scope,
        transport: testHarness.transport,
        createSubscriptionGeneration,
      }),
      { initialProps: { scope: baseScope } },
    );
    await waitFor(() => expect(testHarness.sockets).toHaveLength(1));

    rerender({ scope: newScope });
    await waitFor(() => expect(testHarness.sockets[0].close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.graph.nodes.node_other).toBeDefined());
    act(() => testHarness.sockets[0].request.onMessage(delta('gen_1', {
      operations: [{ kind: 'upsert-node', node: node('private_old_viewer') }],
    })));
    expect(result.current.graph.nodes.private_old_viewer).toBeUndefined();
  });

  test('reports a generic error and retry starts from empty authorized state', async () => {
    const testHarness = harness([snapshot()]);
    testHarness.fetchSnapshot
      .mockRejectedValueOnce(new Error('private token and upstream URL'))
      .mockResolvedValueOnce(snapshot(baseScope, [node('node_after_retry')]));
    const createSubscriptionGeneration = generations('gen_1', 'gen_2');
    const { result } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      createSubscriptionGeneration,
    }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('snapshot-unavailable');
    expect(JSON.stringify(result.current)).not.toContain('private token');

    act(() => result.current.retry());
    expect(result.current.graph.nodes).toEqual({});
    await waitFor(() => expect(result.current.graph.nodes.node_after_retry).toBeDefined());
    expect(result.current.error).toBeNull();
  });

  test('reconnects with a fresh authorization snapshot and closes on unmount', async () => {
    const testHarness = harness([snapshot(), snapshot(baseScope, [node('node_reconnected')], 20)]);
    const { result, unmount } = renderHook(() => useWorkGraph({
      scope: baseScope,
      transport: testHarness.transport,
      reconnectDelayMs: 0,
      createSubscriptionGeneration: generations('gen_1', 'gen_2'),
    }));
    await waitFor(() => expect(testHarness.sockets).toHaveLength(1));

    act(() => testHarness.sockets[0].request.onClose());
    await waitFor(() => expect(result.current.graph.nodes.node_reconnected).toBeDefined());
    expect(testHarness.sockets[0].close).toHaveBeenCalledTimes(1);

    unmount();
    expect(testHarness.sockets[1].close).toHaveBeenCalledTimes(1);
  });
});
