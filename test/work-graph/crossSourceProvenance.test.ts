import type { AuthenticatedWorkEvent, WorkProjectionState } from '../../src/work-graph/contracts';
import { validCloudEventFixture, workGraphFixtureIds } from '../../src/work-graph/fixtures';
import { projectWorkEvent } from '../../src/work-graph/projectEvent';
import { validateAuthenticatedWorkEvent } from '../../src/work-graph/validation';

const empty = (): WorkProjectionState => ({
  schemaVersion: 1,
  organizationId: workGraphFixtureIds.organization,
  actorId: workGraphFixtureIds.owner,
  revision: 0,
  sessions: {}, nodes: {}, edges: {}, sourceCheckpoints: {}, appliedEventIds: [],
});

let sequence = 0;
function event(
  source: AuthenticatedWorkEvent['source'],
  payload: AuthenticatedWorkEvent['payload'],
  resourceId: string,
): AuthenticatedWorkEvent {
  sequence += 1;
  return {
    ...validCloudEventFixture,
    eventId: `event-${sequence}`,
    idempotencyKey: `event-${sequence}`,
    source,
    sourceSequence: String(sequence),
    occurredAt: new Date(Date.UTC(2026, 8, 21, 12, sequence)).toISOString(),
    resource: { source, resourceId },
    payload,
  };
}

function relations(state: WorkProjectionState): string[] {
  return Object.values(state.edges)
    .filter((edge) => !edge.deletedAt)
    .map((edge) => `${state.nodes[edge.fromId].title} -${edge.relation}-> ${state.nodes[edge.toId].title}`)
    .sort();
}

const meeting = event('meeting', {
  kind: 'meeting', lifecycle: 'transcript-ready', meetingId: 'call-1',
  transcriptId: 'transcript-1', safeLabel: 'Planning sync',
}, 'call-1');
const releasePlan = event('document', {
  kind: 'document', lifecycle: 'revision-saved', documentId: 'doc-release',
  revisionId: 'rev-6', safeLabel: 'Release plan',
}, 'doc-release');
const run = event('pipeline', {
  kind: 'pipeline', lifecycle: 'started', pipelineId: 'deck-pipeline', runId: 'run-9', attempt: 3,
  safeLabel: 'Generate presentation',
  inputs: [{ source: 'meeting', resourceId: 'transcript-1' }, { source: 'document', resourceId: 'doc-release' }],
}, 'run-9');
const deck = event('document', {
  kind: 'document', lifecycle: 'revision-saved', documentId: 'doc-deck',
  revisionId: 'rev-2', safeLabel: 'Sprint review', producedByRunId: 'run-9',
}, 'doc-deck');

describe('source-declared cross-source provenance', () => {
  test('accepts the new optional payload fields without changing existing events', () => {
    for (const candidate of [meeting, releasePlan, run, deck, validCloudEventFixture]) {
      expect(validateAuthenticatedWorkEvent(candidate).ok).toBe(true);
    }
    // The additive fields are still rejected on payload kinds that never declared them.
    expect(validateAuthenticatedWorkEvent({
      ...releasePlan,
      payload: { ...releasePlan.payload, inputs: [{ source: 'document', resourceId: 'doc-release' }] },
    }).ok).toBe(false);
  });

  test('links a run to the inputs its source named and to the revision it produced', () => {
    const state = [meeting, releasePlan, run, deck].reduce(projectWorkEvent, empty());
    expect(relations(state)).toEqual([
      'Document change -edited-> Release plan',
      'Document change -edited-> Sprint review',
      'Generate presentation -derived-from-> Release plan',
      'Generate presentation -derived-from-> Transcript',
      'Generate presentation -produced-> Sprint review',
      'Transcript -derived-from-> Planning sync',
    ]);
  });

  test('drops a declared relationship whose counterpart has not been projected', () => {
    // The run is ingested before the transcript and document it names.
    const state = [run, meeting, releasePlan].reduce(projectWorkEvent, empty());
    expect(relations(state)).toEqual(['Document change -edited-> Release plan', 'Transcript -derived-from-> Planning sync']);
    const orphanOutput = projectWorkEvent(empty(), deck);
    expect(relations(orphanOutput)).toEqual(['Document change -edited-> Sprint review']);
  });

  test('never links two entities that merely share an actor and a day', () => {
    const unrelated = event('document', {
      kind: 'document', lifecycle: 'revision-saved', documentId: 'doc-other', revisionId: 'rev-1', safeLabel: 'Other note',
    }, 'doc-other');
    const state = [meeting, unrelated].reduce(projectWorkEvent, empty());
    expect(relations(state)).toEqual(['Document change -edited-> Other note', 'Transcript -derived-from-> Planning sync']);
  });

  test('uses the source-supplied project label instead of the generic placeholder', () => {
    const labelled = projectWorkEvent(empty(), event('cloud-compute', {
      kind: 'cloud-compute', lifecycle: 'started', boxId: 'box-7',
      projectId: 'work-144', projectLabel: 'WORK-144 · Coverage', safeLabel: 'Cloud terminal',
    }, 'box-7'));
    expect(Object.values(labelled.nodes).find((node) => node.kind === 'project')?.title).toBe('WORK-144 · Coverage');
    const unlabelled = projectWorkEvent(empty(), event('cloud-compute', {
      kind: 'cloud-compute', lifecycle: 'started', boxId: 'box-8', projectId: 'work-145',
    }, 'box-8'));
    expect(Object.values(unlabelled.nodes).find((node) => node.kind === 'project')?.title).toBe('Project');
  });

  test('attaches a conversation only to the resource the contributor named', () => {
    const state = [releasePlan, event('conversation', {
      kind: 'conversation', lifecycle: 'contributed', conversationId: 'general', conversationKind: 'channel',
      explicitRelatedResource: { source: 'document', resourceId: 'doc-release' }, safeLabel: 'general',
    }, 'general')].reduce(projectWorkEvent, empty());
    expect(relations(state)).toContain('general -discussed-> Release plan');
  });
});
