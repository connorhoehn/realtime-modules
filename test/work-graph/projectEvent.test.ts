import type { AuthenticatedWorkEvent, CloudComputePayload, WorkProjectionState } from '../../src/work-graph/contracts';
import { validCloudEventFixture, workGraphFixtureIds } from '../../src/work-graph/fixtures';
import { projectWorkEvent } from '../../src/work-graph/projectEvent';

const empty = (): WorkProjectionState => ({
  schemaVersion: 1,
  organizationId: workGraphFixtureIds.organization,
  actorId: workGraphFixtureIds.owner,
  revision: 0,
  sessions: {}, nodes: {}, edges: {}, sourceCheckpoints: {}, appliedEventIds: [],
});

const event = (over: Partial<AuthenticatedWorkEvent> = {}): AuthenticatedWorkEvent => ({
  ...validCloudEventFixture,
  ...over,
});
const cloudPayload = validCloudEventFixture.payload as CloudComputePayload;

describe('projectWorkEvent', () => {
  test('deduplicates replayed events and creates explicit compute relations', () => {
    const first = projectWorkEvent(empty(), event());
    const replay = projectWorkEvent(first, event());
    expect(replay).toBe(first);
    expect(Object.values(first.nodes).map((node) => node.kind).sort()).toEqual(['project', 'run', 'terminal']);
    expect(Object.values(first.edges).map((edge) => edge.relation).sort()).toEqual(['runs-in', 'works-on']);
  });

  test('does not let an older transition revive a completed run', () => {
    const completed = projectWorkEvent(empty(), event({
      eventId: 'complete', sourceSequence: '3', occurredAt: '2026-09-19T14:03:00.000Z',
      payload: { ...cloudPayload, lifecycle: 'completed' },
    }));
    const afterOld = projectWorkEvent(completed, event({
      eventId: 'old-start', sourceSequence: '2', occurredAt: '2026-09-19T14:02:00.000Z',
    }));
    expect(Object.values(afterOld.nodes).find((node) => node.kind === 'run')?.status).toBe('completed');
  });

  test('tombstones deleted resources and incident edges', () => {
    const created = projectWorkEvent(empty(), event());
    const deleted = projectWorkEvent(created, event({
      eventId: 'deleted', sourceSequence: '4', occurredAt: '2026-09-19T14:04:00.000Z',
      payload: { ...cloudPayload, lifecycle: 'deleted' },
    }));
    expect(Object.values(deleted.nodes).every((node) => node.deletedAt)).toBe(true);
    expect(Object.values(deleted.edges).every((edge) => edge.deletedAt)).toBe(true);
  });

  test('keeps two agent identities while sharing one explicit run', () => {
    const first = projectWorkEvent(empty(), event({
      eventId: 'agent-a',
      payload: { ...cloudPayload, agentId: 'agent-a' },
    }));
    const second = projectWorkEvent(first, event({
      eventId: 'agent-b', sourceSequence: '2',
      payload: { ...cloudPayload, agentId: 'agent-b' },
    }));
    expect(Object.values(second.nodes).filter((node) => node.kind === 'agent')).toHaveLength(2);
    expect(Object.values(second.nodes).filter((node) => node.kind === 'run')).toHaveLength(1);
  });

  test('does not invent a produced relation from temporal proximity', () => {
    const documentEvent: AuthenticatedWorkEvent = {
      ...validCloudEventFixture,
      eventId: 'doc-save',
      source: 'document',
      sourceSequence: '9',
      resource: { source: 'document', resourceId: 'doc-1' },
      payload: { kind: 'document', lifecycle: 'revision-saved', documentId: 'doc-1', revisionId: 'rev-1' },
    };
    const state = projectWorkEvent(projectWorkEvent(empty(), event()), documentEvent);
    expect(Object.values(state.edges).some((edge) => edge.relation === 'produced')).toBe(false);
  });

  test('rejects a cross-scope actor', () => {
    expect(() => projectWorkEvent(empty(), event({ actor: { ...validCloudEventFixture.actor, actorId: 'other' } }))).toThrow(/scope/);
  });
});
