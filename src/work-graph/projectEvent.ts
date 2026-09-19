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
  status?: WorkStatus;
  deleting?: boolean;
}

interface EdgeInput {
  from: NodeInput;
  to: NodeInput;
  relation: WorkRelation;
}

function sourceRef(event: AuthenticatedWorkEvent, resourceId: string): WorkSourceRef {
  return { source: event.source, resourceId };
}

function inputsFor(event: AuthenticatedWorkEvent): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const status = statusFor(event);
  const safe = (fallback: string) => event.payload.safeLabel?.trim() || fallback;
  switch (event.payload.kind) {
    case 'cloud-compute': {
      const terminal: NodeInput = { kind: 'terminal', resourceId: event.payload.boxId, title: safe('Cloud terminal'), status };
      if (event.payload.lifecycle === 'deleted') return { nodes: [{ ...terminal, deleting: true }], edges: [] };
      const nodes: NodeInput[] = [terminal];
      const edges: EdgeInput[] = [];
      if (event.payload.projectId) {
        const project: NodeInput = { kind: 'project', resourceId: event.payload.projectId, title: 'Project', status: 'idle' };
        nodes.push(project); edges.push({ from: terminal, to: project, relation: 'works-on' });
      }
      if (event.payload.jobId) {
        const run: NodeInput = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), status };
        nodes.push(run); edges.push({ from: run, to: terminal, relation: 'runs-in' });
        if (event.payload.agentId) {
          const agent: NodeInput = { kind: 'agent', resourceId: event.payload.agentId, title: 'Agent', status };
          nodes.push(agent); edges.push({ from: agent, to: run, relation: 'operates-on' });
        }
      }
      return { nodes, edges };
    }
    case 'local-compute': {
      const terminal: NodeInput = { kind: 'terminal', resourceId: event.payload.machineId, title: safe('Local terminal'), status };
      const nodes: NodeInput[] = [terminal]; const edges: EdgeInput[] = [];
      if (event.payload.projectId) {
        const project: NodeInput = { kind: 'project', resourceId: event.payload.projectId, title: 'Project', status: 'idle' };
        nodes.push(project); edges.push({ from: terminal, to: project, relation: 'works-on' });
      }
      if (event.payload.jobId) {
        const run: NodeInput = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), status };
        nodes.push(run); edges.push({ from: run, to: terminal, relation: 'runs-in' });
      }
      return { nodes, edges };
    }
    case 'document': {
      const document: NodeInput = { kind: 'document', resourceId: event.payload.documentId, title: safe('Document'), status };
      if (event.payload.lifecycle === 'deleted') return { nodes: [{ ...document, deleting: true }], edges: [] };
      const change: NodeInput = { kind: 'change', resourceId: `${event.payload.documentId}:${event.payload.revisionId}`, title: 'Document change', status };
      return { nodes: [document, change], edges: [{ from: change, to: document, relation: 'edited' }] };
    }
    case 'pipeline': {
      return { nodes: [{ kind: 'run', resourceId: event.payload.runId, title: safe('Pipeline run'), status }], edges: [] };
    }
    case 'conversation': {
      return { nodes: [{ kind: 'conversation', resourceId: event.payload.conversationId, title: safe(event.payload.conversationKind === 'dm' ? 'Direct conversation' : 'Conversation'), status, deleting: event.payload.lifecycle === 'membership-removed' }], edges: [] };
    }
    case 'meeting': {
      const meeting: NodeInput = { kind: 'meeting', resourceId: event.payload.meetingId, title: safe('Meeting'), status };
      // Recording lifecycle does not delete the meeting itself. Recordings do
      // not have a graph node; a transcript deletion targets only its node.
      if (event.payload.lifecycle === 'recording-deleted') return { nodes: [], edges: [] };
      if (event.payload.lifecycle === 'transcript-deleted') {
        return {
          nodes: event.payload.transcriptId
            ? [{ kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', status, deleting: true }]
            : [],
          edges: [],
        };
      }
      const nodes: NodeInput[] = [meeting]; const edges: EdgeInput[] = [];
      if (event.payload.transcriptId) {
        const transcript: NodeInput = { kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', status };
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
    title: input.title,
    status: input.status ?? statusFor(event),
    startedAt: existing?.startedAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
    ...(input.deleting ? { endedAt: event.occurredAt, deletedAt: event.occurredAt } : {}),
    sourceEventId: event.eventId,
    ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
    revision: (existing?.revision ?? 0) + 1,
  };
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
  for (const input of inputs.edges) {
    const fromId = nodeId(next, input.from.kind, sourceRef(event, input.from.resourceId));
    const toId = nodeId(next, input.to.kind, sourceRef(event, input.to.resourceId));
    if (!next.nodes[fromId] || !next.nodes[toId] || next.nodes[fromId].deletedAt || next.nodes[toId].deletedAt) continue;
    const id = opaqueWorkId('edge', fromId, toId, input.relation);
    const existing = next.edges[id];
    if (existing && !isNewer(event, existing)) continue;
    const edge: InternalWorkEdge = {
      id,
      organizationId: event.actor.organizationId,
      actorId: event.actor.actorId,
      fromId,
      toId,
      relation: input.relation,
      policyRef: `${event.source}:relation:${input.relation}`,
      status: statusFor(event),
      startedAt: existing?.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      sourceEventId: event.eventId,
      ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
      provenance: 'source-event',
      revision: (existing?.revision ?? 0) + 1,
    };
    next.edges[id] = edge;
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
