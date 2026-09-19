import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphDeltaBatch, WorkGraphSnapshot } from '../../../src/work-graph/contracts';
import { applyWorkGraphSnapshot, createClientWorkGraphState, reduceWorkGraphStream } from '../../../src/client/work-graph/reduceSnapshot';

const scope = { personId: 'person_owner', day: '2026-09-19', timezone: 'America/New_York' };
const node = (id: string): ViewerWorkNode => ({ id, kind: 'task', title: id, status: 'running', disclosure: 'summary', updatedAt: '2026-09-19T14:00:00.000Z', capabilities: [] });
const edge = (id: string, fromId = 'node_a', toId = 'node_b'): ViewerWorkEdge => ({ id, fromId, toId, relation: 'derived-from', status: 'running', disclosure: 'summary', updatedAt: '2026-09-19T14:00:00.000Z', capabilities: [] });
const snapshot = (nodes = [node('node_a'), node('node_b')], edges = [edge('edge_ab')]): WorkGraphSnapshot => ({
  schemaVersion: 1, scope: { ...scope, policyRevision: 'policy_1' }, revision: 1, watermark: 10,
  cursor: 'cursor_10', nodes, edges, sources: [], partial: false,
});
const batch = (over: Partial<WorkGraphDeltaBatch> = {}): WorkGraphDeltaBatch => ({
  schemaVersion: 1, subscriptionGeneration: 'gen_1', previousWatermark: 10, watermark: 11,
  cursor: 'cursor_11', policyRevision: 'policy_1', operations: [], ...over,
});

describe('work graph client reducer', () => {
  const ready = () => applyWorkGraphSnapshot(createClientWorkGraphState(scope, 'gen_1'), snapshot(), { scope, subscriptionGeneration: 'gen_1' });

  test('applies a batch once and ignores its duplicate', () => {
    const first = reduceWorkGraphStream(ready(), { kind: 'delta', batch: batch({ operations: [{ kind: 'upsert-node', node: node('node_c') }] }) });
    const duplicate = reduceWorkGraphStream(first, { kind: 'delta', batch: batch({ operations: [{ kind: 'remove-node', nodeId: 'node_c' }] }) });
    expect(first.nodes.node_c).toBeDefined();
    expect(duplicate).toBe(first);
  });

  test('marks a replay gap for refetch without applying partial operations', () => {
    const state = ready();
    const next = reduceWorkGraphStream(state, { kind: 'delta', batch: batch({ previousWatermark: 12, watermark: 13, operations: [{ kind: 'remove-node', nodeId: 'node_a' }] }) });
    expect(next.status).toBe('refetch-required');
    expect(next.nodes.node_a).toBeDefined();
  });

  test('policy invalidation clears state and delayed old upserts stay discarded', () => {
    const invalid = reduceWorkGraphStream(ready(), { kind: 'invalidate', subscriptionGeneration: 'gen_1', reason: 'policy-changed' });
    expect(Object.keys(invalid.nodes)).toHaveLength(0);
    const delayed = reduceWorkGraphStream(invalid, { kind: 'delta', batch: batch({ operations: [{ kind: 'upsert-node', node: node('private_node') }] }) });
    expect(delayed).toBe(invalid);
  });

  test('node removal also removes incident edges atomically', () => {
    const next = reduceWorkGraphStream(ready(), { kind: 'delta', batch: batch({ operations: [{ kind: 'remove-node', nodeId: 'node_a' }] }) });
    expect(next.nodes.node_a).toBeUndefined();
    expect(next.edges.edge_ab).toBeUndefined();
  });

  test('ignores old fetches and packets after switching person/date generation', () => {
    const switchedScope = { ...scope, personId: 'person_other', day: '2026-09-18' };
    const switched = createClientWorkGraphState(switchedScope, 'gen_2');
    expect(applyWorkGraphSnapshot(switched, snapshot(), { scope, subscriptionGeneration: 'gen_1' })).toBe(switched);
    expect(reduceWorkGraphStream(switched, { kind: 'delta', batch: batch() })).toBe(switched);
  });

  test('marks stale source state partial', () => {
    const next = reduceWorkGraphStream(ready(), { kind: 'delta', batch: batch({ operations: [{ kind: 'source-health', source: { source: 'meeting', health: 'disconnected', checkedAt: '2026-09-19T14:01:00.000Z' } }] }) });
    expect(next.status).toBe('partial');
    expect(next.sources.meeting?.health).toBe('disconnected');
  });
});
