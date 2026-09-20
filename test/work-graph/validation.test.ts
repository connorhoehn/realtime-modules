import { describe, expect, it } from '@jest/globals';
import {
  activeSharingGrantFixture,
  emptySnapshotFixture,
  nodeReferenceFixture,
  validCloudEventFixture,
  validationOutcomeFixtures,
  workGraphFixtureIds,
} from '../../src/work-graph/fixtures';
import {
  validateAuthenticatedWorkEvent,
  validateWorkGraphDeltaBatch,
  validateWorkGraphSnapshot,
  validateWorkReference,
  validateWorkSharingGrant,
} from '../../src/work-graph/validation';

describe('work graph protocol validation', () => {
  it.each(validationOutcomeFixtures)('$name has the expected outcome', ({ value, validatesAs, valid }) => {
    const validator = {
      event: validateAuthenticatedWorkEvent,
      grant: validateWorkSharingGrant,
      reference: validateWorkReference,
    }[validatesAs];
    expect(validator(value).ok).toBe(valid);
  });

  it('rejects a malformed source identity instead of trusting a claimed organization', () => {
    expect(validateAuthenticatedWorkEvent({
      ...validCloudEventFixture,
      actor: { ...validCloudEventFixture.actor, sourceSubject: 'not an opaque source subject!' },
    }).ok).toBe(false);
  });

  it('rejects a snapshot edge with an endpoint absent from the disclosed nodes', () => {
    const node = {
      id: workGraphFixtureIds.projectNode,
      kind: 'project' as const,
      title: 'Project',
      status: 'running' as const,
      disclosure: 'summary' as const,
      updatedAt: '2026-09-19T14:00:00.000Z',
      capabilities: [],
    };
    expect(validateWorkGraphSnapshot({
      ...emptySnapshotFixture,
      nodes: [node],
      edges: [{
        id: workGraphFixtureIds.edge,
        fromId: node.id,
        toId: 'wg_node_not_disclosed',
        relation: 'runs-in',
        status: 'running',
        disclosure: 'summary',
        updatedAt: '2026-09-19T14:00:00.000Z',
        capabilities: [],
      }],
    }).ok).toBe(false);
  });

  it('rejects delta batches over the fixed operation limit', () => {
    const operations = Array.from({ length: 201 }, (_, index) => ({
      kind: 'remove-node' as const,
      nodeId: `wg_node_${index}`,
    }));
    expect(validateWorkGraphDeltaBatch({
      schemaVersion: 1,
      subscriptionGeneration: 'subscription_fixture',
      previousWatermark: 1,
      watermark: 2,
      cursor: 'opaque.fixture.cursor',
      policyRevision: 'policy-fixture-1',
      operations,
    }).ok).toBe(false);
  });

  it('accepts scoped signed cursors longer than resource IDs but still bounds them', () => {
    const signedCursor = `wg1.${'a'.repeat(500)}.signature`;
    expect(validateWorkGraphSnapshot({
      ...emptySnapshotFixture,
      cursor: signedCursor,
    }).ok).toBe(true);
    expect(validateWorkGraphSnapshot({
      ...emptySnapshotFixture,
      cursor: `wg1.${'a'.repeat(4_096)}`,
    }).ok).toBe(false);
  });

  it('rejects a reference target that mixes node and edge forms', () => {
    expect(validateWorkReference({
      ...nodeReferenceFixture,
      target: { kind: 'node', id: workGraphFixtureIds.terminalNode, edgeId: workGraphFixtureIds.edge },
    }).ok).toBe(false);
  });

  it('rejects unsupported protocol versions and dangerous extra fields', () => {
    expect(validateWorkReference({ ...nodeReferenceFixture, version: 2 }).ok).toBe(false);
    expect(validateWorkSharingGrant({ ...activeSharingGrantFixture, constructor: 'poison' }).ok).toBe(false);
  });

  it('rejects impossible calendar and timestamp values', () => {
    expect(validateWorkReference({ ...nodeReferenceFixture, day: '2026-02-30' }).ok).toBe(false);
    expect(validateAuthenticatedWorkEvent({ ...validCloudEventFixture, occurredAt: '2026-02-30T14:00:00.000Z' }).ok).toBe(false);
  });

  it('requires viewer update timestamps used for ordering', () => {
    expect(validateWorkGraphSnapshot({
      ...emptySnapshotFixture,
      nodes: [{ id: 'wg_node_missing_time', kind: 'task', title: 'Task', status: 'idle', disclosure: 'summary', capabilities: [] }],
    }).ok).toBe(false);
  });
});
