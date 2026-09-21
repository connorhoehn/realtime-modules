import type {
  AuthenticatedWorkEvent,
  InternalWorkEdge,
  InternalWorkNode,
  WorkNodeKind,
  WorkProjectionState,
  WorkRelation,
  WorkSourceRef,
  WorkStatus,
} from './contracts';
import { opaqueWorkId } from './opaqueId';

function nodeId(state: WorkProjectionState, kind: WorkNodeKind, ref: WorkSourceRef): string {
  return opaqueWorkId('node', state.organizationId, state.actorId, kind, ref.source, ref.resourceId);
}

function numericSequence(value: string | undefined): bigint | undefined {
  return value !== undefined && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function isNewer(event: AuthenticatedWorkEvent, entity: Pick<InternalWorkNode, 'sourceSequence' | 'updatedAt' | 'sourceEventId'>): boolean {
  const incomingSequence = numericSequence(event.sourceSequence);
  const existingSequence = numericSequence(entity.sourceSequence);
  // Compare like units only: an event without a source sequence must not have
  // its epoch milliseconds compared with another event's sequence counter.
  const incoming = incomingSequence !== undefined && existingSequence !== undefined
    ? incomingSequence : Date.parse(event.occurredAt);
  const existing = incomingSequence !== undefined && existingSequence !== undefined
    ? existingSequence : Date.parse(entity.updatedAt);
  return incoming > existing || (incoming === existing && event.eventId > entity.sourceEventId);
}

function statusFor(event: AuthenticatedWorkEvent): WorkStatus {
  switch (event.payload.kind) {
    case 'cloud-compute':
      return ({ created: 'idle', started: 'running', waiting: 'waiting', completed: 'completed', stopped: 'stopped', failed: 'error', deleted: 'stopped' } as const)[event.payload.lifecycle];
    case 'local-compute':
      return ({ 'session-started': 'running', 'session-ended': 'stopped', 'job-started': 'running', 'job-finished': 'completed', heartbeat: 'idle', disconnected: 'stale' } as const)[event.payload.lifecycle];
    case 'document':
      return event.payload.lifecycle === 'deleted' ? 'stopped' : 'completed';
    case 'pipeline':
      return ({ started: 'running', waiting: 'waiting', completed: 'completed', failed: 'error', cancelled: 'stopped' } as const)[event.payload.lifecycle];
    case 'conversation':
      return event.payload.lifecycle === 'membership-removed' ? 'stopped' : 'completed';
    case 'meeting':
      if (event.payload.lifecycle.endsWith('-failed')) return 'error';
      if (event.payload.lifecycle.endsWith('-deleted') || event.payload.lifecycle === 'attendance-ended') return 'stopped';
      if (event.payload.lifecycle.endsWith('-started')) return 'running';
      return 'completed';
  }
}

interface NodeInput {
  kind: WorkNodeKind;
  resourceId: string;
  title: string;
  /** Source-written context line. Never derived from another field. */
  description?: string;
  /**
   * The title is this reducer's placeholder, not a label the source supplied.
   * A generic title never replaces one a source already gave, so a later
   * lifecycle event that omits `safeLabel` cannot blank out a real name.
   */
  generic?: boolean;
  status?: WorkStatus;
  deleting?: boolean;
}

interface EdgeInput {
  from: NodeInput;
  to: NodeInput;
  relation: WorkRelation;
}

/**
 * A relationship to an entity this event does not itself describe. The source
 * has to name the other resource explicitly; the reducer never links two
 * entities because they share an actor, a day, a project, or a machine. The
 * edge is dropped when the named resource has not been projected yet, so a
 * late or unauthorized counterpart can never conjure a node.
 */
interface CrossSourceEdgeInput {
  from: NodeInput | { existing: WorkSourceRef; kinds?: WorkNodeKind[] };
  to: NodeInput | { existing: WorkSourceRef; kinds?: WorkNodeKind[] };
  relation: WorkRelation;
}

function sourceRef(event: AuthenticatedWorkEvent, resourceId: string): WorkSourceRef {
  return { source: event.source, resourceId };
}

function inputsFor(event: AuthenticatedWorkEvent): { nodes: NodeInput[]; edges: EdgeInput[]; crossEdges?: CrossSourceEdgeInput[] } {
  const status = statusFor(event);
  const label = event.payload.safeLabel?.trim();
  const safe = (fallback: string) => label || fallback;
  const generic = label ? undefined : true;
  switch (event.payload.kind) {
    case 'cloud-compute': {
      const terminal: NodeInput = { kind: 'terminal', resourceId: event.payload.boxId, title: safe('Cloud terminal'), generic, status };
      if (event.payload.lifecycle === 'deleted') return { nodes: [{ ...terminal, deleting: true }], edges: [] };
      const nodes: NodeInput[] = [terminal];
      const edges: EdgeInput[] = [];
      if (event.payload.projectId) {
        const projectLabel = event.payload.projectLabel?.trim();
        const projectContext = event.payload.projectContext?.trim();
        const project: NodeInput = {
          kind: 'project',
          resourceId: event.payload.projectId,
          title: projectLabel || 'Project',
          ...(projectContext ? { description: projectContext } : {}),
          ...(projectLabel ? {} : { generic: true }),
          status: 'idle',
        };
        nodes.push(project); edges.push({ from: terminal, to: project, relation: 'works-on' });
      }
      if (event.payload.jobId) {
        const run: NodeInput = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), generic, status };
        nodes.push(run); edges.push({ from: run, to: terminal, relation: 'runs-in' });
        if (event.payload.agentId) {
          const agent: NodeInput = { kind: 'agent', resourceId: event.payload.agentId, title: 'Agent', generic: true, status };
          nodes.push(agent); edges.push({ from: agent, to: run, relation: 'operates-on' });
        }
      }
      return { nodes, edges };
    }
    case 'local-compute': {
      const terminal: NodeInput = { kind: 'terminal', resourceId: event.payload.machineId, title: safe('Local terminal'), generic, status };
      const nodes: NodeInput[] = [terminal]; const edges: EdgeInput[] = [];
      if (event.payload.projectId) {
        const project: NodeInput = { kind: 'project', resourceId: event.payload.projectId, title: 'Project', generic: true, status: 'idle' };
        nodes.push(project); edges.push({ from: terminal, to: project, relation: 'works-on' });
      }
      if (event.payload.jobId) {
        const run: NodeInput = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), generic, status };
        nodes.push(run); edges.push({ from: run, to: terminal, relation: 'runs-in' });
      }
      return { nodes, edges };
    }
    case 'document': {
      const document: NodeInput = { kind: 'document', resourceId: event.payload.documentId, title: safe('Document'), generic, status };
      if (event.payload.lifecycle === 'deleted') return { nodes: [{ ...document, deleting: true }], edges: [] };
      // A revision reads as the document it changed, so the card is not a row
      // of identical "Document change" entries once several revisions exist.
      const change: NodeInput = {
        kind: 'change',
        resourceId: `${event.payload.documentId}:${event.payload.revisionId}`,
        title: label ? `${label} · revision`.slice(0, 160) : 'Document change',
        ...(label ? {} : { generic: true }),
        status,
      };
      const producedBy = event.payload.producedByRunId;
      return {
        nodes: [document, change],
        edges: [{ from: change, to: document, relation: 'edited' }],
        // The save record itself attributes the revision to a run. Only a run
        // node already projected by its own source can be named here.
        ...(producedBy
          ? {
            crossEdges: [{
              from: { existing: { source: 'pipeline', resourceId: producedBy }, kinds: ['run'] },
              to: document,
              relation: 'produced' as WorkRelation,
            }],
          }
          : {}),
      };
    }
    case 'pipeline': {
      const run: NodeInput = { kind: 'run', resourceId: event.payload.runId, title: safe('Pipeline run'), generic, status };
      const declared = event.payload.inputs ?? [];
      return {
        nodes: [run],
        edges: [],
        // `derived-from` points at the evidence the run consumed. Direction is
        // run -> input, matching the transcript -> meeting convention above.
        crossEdges: declared.map((ref) => ({ from: run, to: { existing: ref }, relation: 'derived-from' as WorkRelation })),
      };
    }
    case 'conversation': {
      const conversation: NodeInput = { kind: 'conversation', resourceId: event.payload.conversationId, title: safe(event.payload.conversationKind === 'dm' ? 'Direct conversation' : 'Conversation'), generic, status, deleting: event.payload.lifecycle === 'membership-removed' };
      const related = event.payload.explicitRelatedResource;
      return {
        nodes: [conversation],
        edges: [],
        ...(related && event.payload.lifecycle === 'contributed'
          ? { crossEdges: [{ from: conversation, to: { existing: related }, relation: 'discussed' as WorkRelation }] }
          : {}),
      };
    }
    case 'meeting': {
      const meeting: NodeInput = { kind: 'meeting', resourceId: event.payload.meetingId, title: safe('Meeting'), generic, status };
      // Recording lifecycle does not delete the meeting itself. Recordings do
      // not have a graph node; a transcript deletion targets only its node.
      if (event.payload.lifecycle === 'recording-deleted') return { nodes: [], edges: [] };
      if (event.payload.lifecycle === 'transcript-deleted') {
        return {
          nodes: event.payload.transcriptId
            ? [{ kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', generic: true, status, deleting: true }]
            : [],
          edges: [],
        };
      }
      const nodes: NodeInput[] = [meeting]; const edges: EdgeInput[] = [];
      if (event.payload.transcriptId) {
        const transcript: NodeInput = { kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', generic: true, status };
        nodes.push(transcript); edges.push({ from: transcript, to: meeting, relation: 'derived-from' });
      }
      return { nodes, edges };
    }
  }
}

function upsertNode(state: WorkProjectionState, event: AuthenticatedWorkEvent, input: NodeInput): InternalWorkNode {
  const ref = sourceRef(event, input.resourceId);
  const id = nodeId(state, input.kind, ref);
  const existing = state.nodes[id];
  if (existing && !isNewer(event, existing)) return existing;
  return {
    id,
    organizationId: event.actor.organizationId,
    actorId: event.actor.actorId,
    kind: input.kind,
    sourceRef: ref,
    policyRef: `${event.source}:${input.kind}`,
    // A placeholder never overwrites a name a source already supplied. The
    // platform's own republished lifecycle events omit `safeLabel`, and that
    // used to reset a real title back to "Pipeline run".
    title: input.generic && existing && !existing.deletedAt ? existing.title : input.title,
    // A source that stops sending its context keeps the last one it sent,
    // for the same reason a placeholder never overwrites a real label.
    ...(input.description ?? existing?.description ? { description: input.description ?? existing?.description } : {}),
    status: input.status ?? statusFor(event),
    startedAt: existing?.startedAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
    ...(input.deleting ? { endedAt: event.occurredAt, deletedAt: event.occurredAt } : {}),
    sourceEventId: event.eventId,
    ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
    revision: (existing?.revision ?? 0) + 1,
  };
}

/**
 * Resolves a cross-source endpoint to an existing projected node. Lookup is by
 * the resource the source named, never by actor or time proximity, and a
 * deleted or absent counterpart simply drops the relationship.
 */
function resolveEndpoint(
  state: WorkProjectionState,
  event: AuthenticatedWorkEvent,
  endpoint: CrossSourceEdgeInput['from'],
): string | undefined {
  if (!('existing' in endpoint)) return nodeId(state, endpoint.kind, sourceRef(event, endpoint.resourceId));
  const { source, resourceId } = endpoint.existing;
  const matches = Object.values(state.nodes).filter((node) => !node.deletedAt
    && node.sourceRef.source === source
    && node.sourceRef.resourceId === resourceId
    && (!endpoint.kinds || endpoint.kinds.includes(node.kind)));
  // A resource that resolves to more than one node is ambiguous provenance.
  return matches.length === 1 ? matches[0].id : undefined;
}

/** Pure, idempotent projection over an already validated source event. */
export function projectWorkEvent(current: WorkProjectionState, event: AuthenticatedWorkEvent): WorkProjectionState {
  if (current.organizationId !== event.actor.organizationId || current.actorId !== event.actor.actorId) {
    throw new RangeError('event actor is outside the projection scope');
  }
  // IDs are unique within a source, matching the durable repository's event
  // marker. Different producers may legitimately use the same event ID.
  const eventKey = `${event.source}:${event.eventId}`;
  if (current.appliedEventIds.includes(eventKey)) return current;

  const previousSequence = numericSequence(current.sourceCheckpoints[event.source]);
  const incomingSequence = numericSequence(event.sourceSequence);
  const advanceCheckpoint = event.sourceSequence !== undefined
    && !(previousSequence !== undefined && incomingSequence !== undefined && incomingSequence < previousSequence);

  const next: WorkProjectionState = {
    ...current,
    revision: current.revision + 1,
    nodes: { ...current.nodes },
    edges: { ...current.edges },
    sourceCheckpoints: { ...current.sourceCheckpoints, ...(advanceCheckpoint ? { [event.source]: event.sourceSequence } : {}) },
    appliedEventIds: [...current.appliedEventIds, eventKey],
  };
  const inputs = inputsFor(event);
  const deletedNodeIds = new Set<string>();
  for (const input of inputs.nodes) {
    const node = upsertNode(next, event, input);
    next.nodes[node.id] = node;
    if (node.deletedAt && node.sourceEventId === event.eventId) deletedNodeIds.add(node.id);
  }
  const link = (fromId: string | undefined, toId: string | undefined, relation: WorkRelation): void => {
    if (!fromId || !toId || fromId === toId) return;
    if (!next.nodes[fromId] || !next.nodes[toId] || next.nodes[fromId].deletedAt || next.nodes[toId].deletedAt) return;
    const id = opaqueWorkId('edge', fromId, toId, relation);
    const existing = next.edges[id];
    if (existing && !isNewer(event, existing)) return;
    const edge: InternalWorkEdge = {
      id,
      organizationId: event.actor.organizationId,
      actorId: event.actor.actorId,
      fromId,
      toId,
      relation,
      policyRef: `${event.source}:relation:${relation}`,
      status: statusFor(event),
      startedAt: existing?.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventId: event.eventId,
      ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
      provenance: 'source-event',
      revision: (existing?.revision ?? 0) + 1,
    };
    next.edges[id] = edge;
  };

  for (const input of inputs.edges) {
    link(
      nodeId(next, input.from.kind, sourceRef(event, input.from.resourceId)),
      nodeId(next, input.to.kind, sourceRef(event, input.to.resourceId)),
      input.relation,
    );
  }
  for (const input of inputs.crossEdges ?? []) {
    link(resolveEndpoint(next, event, input.from), resolveEndpoint(next, event, input.to), input.relation);
  }
  // Delete all incident relationships, including ones absent from the delete
  // payload. Keep the other endpoints and their unrelated relationships.
  for (const edge of Object.values(next.edges)) {
    if ((!deletedNodeIds.has(edge.fromId) && !deletedNodeIds.has(edge.toId)) || !isNewer(event, edge)) continue;
    next.edges[edge.id] = {
      ...edge, status: 'stopped', updatedAt: event.occurredAt,
      endedAt: event.occurredAt, deletedAt: event.occurredAt,
      sourceEventId: event.eventId, sourceSequence: event.sourceSequence,
      revision: edge.revision + 1,
    };
  }
  return next;
}
