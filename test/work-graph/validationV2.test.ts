import { describe, expect, it } from '@jest/globals';
import type { WorkGraphSnapshotV2 } from '../../src/work-graph/contractsV2';
import { validateWorkGraphQueryV2, validateWorkGraphSnapshotV2, validateWorkReferenceV2 } from '../../src/work-graph/validationV2';
import { validateWorkGraphSnapshot, validateWorkReference } from '../../src/work-graph/validation';
import { emptySnapshotFixture, nodeReferenceFixture } from '../../src/work-graph/fixtures';

const at = '2026-09-20T13:42:00.000Z';
function snapshot(): WorkGraphSnapshotV2 {
  return {
    schemaVersion: 2, scope: { personId: 'owner', day: '2026-09-20', timezone: 'America/New_York', policyRevision: 'policy-1' }, revision: 1, watermark: 1, cursor: 'opaque-cursor', partial: false,
    query: { schemaVersion: 2, personId: 'owner', day: '2026-09-20', timezone: 'America/New_York', windowStart: '2026-09-20T13:27:00.000Z', windowEnd: at, mode: 'live' },
    temporal: { mode: 'live', observedAt: at, coverage: { from: '2026-09-20T12:00:00.000Z', through: at, complete: true } },
    nodes: [{ id: 'run', title: 'Generation', kind: 'run', status: 'running', disclosure: 'details', updatedAt: at, capabilities: [] }, { id: 'deck', title: 'Sprint review', kind: 'document', status: 'completed', disclosure: 'details', updatedAt: at, capabilities: ['view-document'] }],
    edges: [{ id: 'output', fromId: 'run', toId: 'deck', relation: 'produced', status: 'running', disclosure: 'details', updatedAt: at, capabilities: [] }], sources: [],
    efforts: [{ id: 'sprint', anchorNodeId: 'deck', title: 'Sprint review', nodeIds: ['run', 'deck'], edgeIds: ['output'], contextNodeIds: [] }],
    details: [{ nodeId: 'deck', artifact: { mediaKind: 'presentation', revisions: [{ id: 'v2', label: 'v2', createdAt: at, previewHandle: 'preview-v2', anchors: [{ kind: 'slide', id: 'slide-1', label: 'Release risks' }] }], pending: { revisionId: 'v3', attemptId: 'attempt-3', label: 'v3', status: 'generating', startedAt: at, updatedAt: at } }, feedback: { count: 2, through: at }, attention: { kind: 'reviewing', observedAt: at, expiresAt: '2026-09-20T13:43:00.000Z', revisionId: 'v2' } }],
    operations: [{ edgeId: 'output', processNodeId: 'run', attemptId: 'attempt-3', observedAt: at, expiresAt: '2026-09-20T13:43:00.000Z' }], eventBuckets: [{ at, count: 2 }],
  };
}

describe('opt-in work graph v2 boundary', () => {
  it('keeps v1 and v2 readers explicit and preserves existing v1 payloads', () => {
    expect(validateWorkGraphSnapshot(emptySnapshotFixture).ok).toBe(true);
    expect(validateWorkGraphSnapshotV2(snapshot()).ok).toBe(true);
    expect(validateWorkGraphSnapshot(snapshot()).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2(emptySnapshotFixture).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...snapshot(), schemaVersion: 3 }).ok).toBe(false);
  });

  it.each([null, {}, { schemaVersion: 2 }, { ...snapshot(), operations: [null] }, { ...snapshot(), efforts: [null] }, { ...snapshot(), details: [null] }])('rejects malformed input without throwing: %j', (value) => {
    expect(() => validateWorkGraphSnapshotV2(value)).not.toThrow();
    expect(validateWorkGraphSnapshotV2(value).ok).toBe(false);
  });

  it('rejects private source fields, dangling effort members, hidden detail and duplicate operation evidence', () => {
    const value = snapshot();
    expect(validateWorkGraphSnapshotV2({ ...value, sourceRef: { resourceId: 'private' } }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, efforts: [{ ...value.efforts[0], nodeIds: ['run', 'deck', 'private'] }] }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, nodes: value.nodes.map((node) => node.id === 'deck' ? { ...node, disclosure: 'existence', locked: true } : node) }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, operations: [...value.operations, value.operations[0]] }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, nodes: value.nodes.map((node) => node.id === 'run' ? { ...node, disclosure: 'existence', locked: true } : node) }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, details: [{ ...value.details[0], artifact: { ...value.details[0].artifact, revisions: [{ ...value.details[0].artifact!.revisions[0], url: 'https://private.example/blob' }] } }] }).ok).toBe(false);
  });

  it('cannot present a pending revision as available or point review attention at a hidden revision', () => {
    const value = snapshot();
    const detail = value.details[0];
    expect(validateWorkGraphSnapshotV2({ ...value, details: [{ ...detail, artifact: { ...detail.artifact, pending: { ...detail.artifact!.pending, revisionId: 'v2' } } }] }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, details: [{ ...detail, attention: { ...detail.attention, revisionId: 'private' } }] }).ok).toBe(false);
  });

  it('rejects future revisions, attention, counts and node state in an as-of response', () => {
    const value = snapshot();
    value.query.mode = 'as-of'; value.temporal.mode = 'as-of';
    expect(validateWorkGraphSnapshotV2(value).ok).toBe(true);
    const future = '2026-09-20T13:43:00.000Z';
    const detail = value.details[0];
    expect(validateWorkGraphSnapshotV2({ ...value, details: [{ ...detail, artifact: { ...detail.artifact, revisions: [{ ...detail.artifact!.revisions[0], createdAt: future }] } }] }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, details: [{ ...detail, feedback: { count: 3, through: future } }] }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, nodes: value.nodes.map((node) => ({ ...node, updatedAt: future })) }).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...value, temporal: { ...value.temporal, mode: 'live' } }).ok).toBe(false);
  });

  it('validates real local-day bounds across both DST changes', () => {
    const query = snapshot().query;
    expect(validateWorkGraphQueryV2({ ...query, day: '2026-11-01', windowStart: '2026-11-01T04:00:00.000Z', windowEnd: '2026-11-02T05:00:00.000Z' }).ok).toBe(true);
    expect(validateWorkGraphQueryV2({ ...query, day: '2026-03-08', windowStart: '2026-03-08T05:00:00.000Z', windowEnd: '2026-03-09T04:00:00.000Z' }).ok).toBe(true);
    expect(validateWorkGraphQueryV2({ ...query, day: '2026-03-08', windowStart: '2026-03-08T05:00:00.000Z', windowEnd: '2026-03-09T05:00:00.000Z' }).ok).toBe(false);
    expect(validateWorkGraphQueryV2({ ...query, windowEnd: query.windowStart }).ok).toBe(false);
  });

  it('compares v1 timestamp instants and bounds heat counts to the authorized local day', () => {
    const value = snapshot();
    value.query.mode = 'as-of'; value.temporal.mode = 'as-of';
    value.nodes[0].updatedAt = '2026-09-20T13:42:00Z';
    expect(validateWorkGraphSnapshotV2(value).ok).toBe(true);
    value.nodes[0].updatedAt = '2026-09-20T13:42:01Z';
    expect(validateWorkGraphSnapshotV2(value).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2({ ...snapshot(), eventBuckets: [{ at: '2026-09-20T03:59:00.000Z', count: 1 }] }).ok).toBe(false);
  });

  it('keeps revision and anchor references opaque, versioned and immutable', () => {
    const reference = { ...nodeReferenceFixture, version: 2, target: { kind: 'node', id: 'deck', revisionId: 'v2', anchor: { kind: 'slide', id: 'slide-1' } } };
    expect(validateWorkReferenceV2(reference).ok).toBe(true);
    expect(validateWorkReference(reference).ok).toBe(false);
    expect(validateWorkReferenceV2({ ...reference, target: { ...reference.target, revisionId: undefined } }).ok).toBe(false);
    expect(validateWorkReferenceV2({ ...reference, target: { ...reference.target, kind: 'edge' } }).ok).toBe(false);
    expect(validateWorkReferenceV2({ ...reference, title: 'Private title' }).ok).toBe(false);
  });
});

describe('NFR #126 — the reason a run is waiting', () => {
  const paused = (pause: unknown, status = 'waiting', kind = 'run') => {
    const value = snapshot();
    return { ...value, nodes: value.nodes.map((node) => node.id === 'run' ? { ...node, status, kind } : node), details: [...value.details, { nodeId: 'run', pause }] };
  };
  it('accepts a breakpoint with its step and an approval gate with or without one', () => {
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'paused_at_breakpoint', step: 'write' })).ok).toBe(true);
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'awaiting_approval', step: 'Approve the deck' })).ok).toBe(true);
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'awaiting_approval' })).ok).toBe(true);
  });
  it('rejects an unknown reason, an extra key or an empty step', () => {
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'sleeping' })).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'awaiting_approval', approver: 'frank' })).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'paused_at_breakpoint', step: '' })).ok).toBe(false);
  });
  it('rejects a pause on a run that is not waiting, or on a node that is not a process', () => {
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'paused_at_breakpoint', step: 'write' }, 'running')).ok).toBe(false);
    expect(validateWorkGraphSnapshotV2(paused({ reason: 'paused_at_breakpoint', step: 'write' }, 'waiting', 'document')).ok).toBe(false);
  });
});
