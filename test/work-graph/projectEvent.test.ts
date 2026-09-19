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
  test('keeps distinct resources that collide under the former 32-bit hash', () => {
    const first = projectWorkEvent(empty(), event({
      payload: { kind: 'cloud-compute', lifecycle: 'started', boxId: 'box-eb5f6a08' },
    }));
    const second = projectWorkEvent(first, event({
      eventId: 'other-resource', sourceSequence: '2',
      payload: { kind: 'cloud-compute', lifecycle: 'started', boxId: 'box-49de7046' },
    }));
    expect(Object.values(second.nodes).map((node) => node.sourceRef.resourceId).sort()).toEqual(['box-49de7046', 'box-eb5f6a08']);
    expect(new Set(Object.keys(second.nodes)).size).toBe(2);
  });

  test('scopes resource identities to their owner and organization', () => {
    const first = projectWorkEvent(empty(), event());
    const otherOwner = { ...empty(), actorId: 'another-owner' };
    const second = projectWorkEvent(otherOwner, event({ actor: { ...validCloudEventFixture.actor, actorId: otherOwner.actorId } }));
    const otherOrganization = { ...empty(), organizationId: 'another-org' };
    const third = projectWorkEvent(otherOrganization, event({
      actor: { ...validCloudEventFixture.actor, organizationId: otherOrganization.organizationId },
      producer: { ...validCloudEventFixture.producer, organizationId: otherOrganization.organizationId },
    }));
    expect(Object.keys(second.nodes).some((id) => id in first.nodes)).toBe(false);
    expect(Object.keys(third.nodes).some((id) => id in first.nodes)).toBe(false);
    expect(Object.keys(second.edges).some((id) => id in first.edges)).toBe(false);
  });

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
    expect(Object.values(afterOld.edges)).toEqual(Object.values(completed.edges));
    expect(afterOld.sourceCheckpoints['cloud-compute']).toBe('3');
  });

  test('tombstones deleted resources and incident edges', () => {
    const created = projectWorkEvent(empty(), event());
    const deleted = projectWorkEvent(created, event({
      eventId: 'deleted', sourceSequence: '4', occurredAt: '2026-09-19T14:04:00.000Z',
      payload: { ...cloudPayload, lifecycle: 'deleted' },
    }));
    expect(Object.values(deleted.nodes).filter((node) => node.deletedAt).map((node) => node.kind)).toEqual(['terminal']);
    expect(Object.values(deleted.edges).every((edge) => edge.deletedAt)).toBe(true);
  });

  test('keeps a shared project and its other terminal when a minimal delete arrives', () => {
    const first = projectWorkEvent(empty(), event());
    const second = projectWorkEvent(first, event({
      eventId: 'second-box', sourceSequence: '2',
      payload: { ...cloudPayload, boxId: 'second-box', jobId: undefined },
    }));
    const deleted = projectWorkEvent(second, event({
      eventId: 'deleted-box', sourceSequence: '3', occurredAt: '2026-09-19T14:04:00.000Z',
      payload: { kind: 'cloud-compute', lifecycle: 'deleted', boxId: cloudPayload.boxId },
    }));
    const project = Object.values(deleted.nodes).find((node) => node.kind === 'project')!;
    const liveTerminal = Object.values(deleted.nodes).find((node) => node.sourceRef.resourceId === 'second-box')!;
    expect(project.deletedAt).toBeUndefined();
    expect(liveTerminal.deletedAt).toBeUndefined();
    expect(Object.values(deleted.edges).filter((edge) => !edge.deletedAt)).toEqual([
      expect.objectContaining({ fromId: liveTerminal.id, toId: project.id }),
    ]);
  });

  test('does not let a delayed delete hide a newer terminal or its relationships', () => {
    const current = projectWorkEvent(empty(), event({ sourceSequence: '3' }));
    const delayed = projectWorkEvent(current, event({
      eventId: 'old-delete', sourceSequence: '2',
      payload: { ...cloudPayload, lifecycle: 'deleted' },
    }));
    expect(delayed.nodes).toEqual(current.nodes);
    expect(delayed.edges).toEqual(current.edges);
  });

  test('uses source-scoped event IDs and still deduplicates within one source', () => {
    const cloud = projectWorkEvent(empty(), event());
    const pipelineEvent = event({
      source: 'pipeline', resource: { source: 'pipeline', resourceId: 'pipeline-1' },
      payload: { kind: 'pipeline', lifecycle: 'started', pipelineId: 'pipeline-1', runId: 'pipeline-run-1', attempt: 1 },
    });
    const pipeline = projectWorkEvent(cloud, pipelineEvent);
    expect(pipeline.revision).toBe(cloud.revision + 1);
    expect(Object.values(pipeline.nodes).some((node) => node.sourceRef.resourceId === 'pipeline-run-1')).toBe(true);
    expect(projectWorkEvent(pipeline, pipelineEvent)).toBe(pipeline);
  });

  test('falls back to timestamps when only one event has a source sequence', () => {
    const current = projectWorkEvent(empty(), event({
      eventId: 'completed', sourceSequence: '3', occurredAt: '2026-09-19T14:03:00.000Z',
      payload: { ...cloudPayload, lifecycle: 'completed' },
    }));
    const delayed = projectWorkEvent(current, event({
      eventId: 'unsequenced-old', sourceSequence: undefined, occurredAt: '2026-09-19T14:02:00.000Z',
    }));
    expect(delayed.nodes).toEqual(current.nodes);
    expect(delayed.edges).toEqual(current.edges);
  });

  test('orders large sequence counters without rounding or falling back to timestamps', () => {
    const current = projectWorkEvent(empty(), event({
      eventId: 'completed', sourceSequence: '9007199254740993', occurredAt: '2026-09-19T14:03:00.000Z',
      payload: { ...cloudPayload, lifecycle: 'completed' },
    }));
    const delayed = projectWorkEvent(current, event({
      eventId: 'older-sequence-later-clock', sourceSequence: '9007199254740992', occurredAt: '2026-09-19T14:04:00.000Z',
    }));
    expect(delayed.nodes).toEqual(current.nodes);
    expect(delayed.edges).toEqual(current.edges);
    expect(delayed.sourceCheckpoints['cloud-compute']).toBe('9007199254740993');
  });

  test('deleting a transcript keeps its meeting and other transcripts', () => {
    const meetingEvent = (id: string, sequence: string, transcriptId: string, lifecycle: 'transcript-ready' | 'transcript-deleted') => event({
      eventId: id, source: 'meeting', sourceSequence: sequence,
      resource: { source: 'meeting', resourceId: 'meeting-1' },
      payload: { kind: 'meeting', lifecycle, meetingId: 'meeting-1', transcriptId },
    });
    const first = projectWorkEvent(empty(), meetingEvent('first', '1', 'transcript-1', 'transcript-ready'));
    const second = projectWorkEvent(first, meetingEvent('second', '2', 'transcript-2', 'transcript-ready'));
    const deleted = projectWorkEvent(second, meetingEvent('deleted', '3', 'transcript-1', 'transcript-deleted'));
    expect(Object.values(deleted.nodes).filter((node) => node.deletedAt).map((node) => node.sourceRef.resourceId)).toEqual(['transcript-1']);
    expect(Object.values(deleted.edges).filter((edge) => !edge.deletedAt)).toHaveLength(1);
    expect(Object.values(deleted.nodes).find((node) => node.kind === 'meeting')).toEqual(Object.values(second.nodes).find((node) => node.kind === 'meeting'));
  });

  test('deleting a recording does not delete its meeting or ready transcript', () => {
    const ready = event({
      eventId: 'ready', source: 'meeting',
      resource: { source: 'meeting', resourceId: 'meeting-1' },
      payload: { kind: 'meeting', lifecycle: 'transcript-ready', meetingId: 'meeting-1', recordingId: 'recording-1', transcriptId: 'transcript-1' },
    });
    const current = projectWorkEvent(empty(), ready);
    const deleted = projectWorkEvent(current, {
      ...ready, eventId: 'recording-deleted', sourceSequence: '2',
      payload: { kind: 'meeting', lifecycle: 'recording-deleted', meetingId: 'meeting-1', recordingId: 'recording-1' },
    });
    expect(deleted.nodes).toEqual(current.nodes);
    expect(deleted.edges).toEqual(current.edges);
  });

  test('document deletion retains historical changes and removes every incident edge', () => {
    const save = (revisionId: string, sequence: string) => event({
      eventId: revisionId, source: 'document', sourceSequence: sequence,
      resource: { source: 'document', resourceId: 'doc-1' },
      payload: { kind: 'document', lifecycle: 'revision-saved', documentId: 'doc-1', revisionId },
    });
    const first = projectWorkEvent(empty(), save('rev-1', '1'));
    const second = projectWorkEvent(first, save('rev-2', '2'));
    const deleted = projectWorkEvent(second, event({
      ...save('rev-3', '3'), eventId: 'doc-deleted',
      payload: { kind: 'document', lifecycle: 'deleted', documentId: 'doc-1', revisionId: 'rev-3' },
    }));
    expect(Object.values(deleted.nodes).filter((node) => node.deletedAt).map((node) => node.kind)).toEqual(['document']);
    expect(Object.values(deleted.nodes).filter((node) => node.kind === 'change')).toHaveLength(2);
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
