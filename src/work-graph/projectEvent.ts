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

function opaqueId(prefix: 'node' | 'edge', ...parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join('\u001f')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wg_${prefix}_${hash.toString(16).padStart(8, '0')}`;
}

function nodeId(kind: WorkNodeKind, ref: WorkSourceRef): string {
  return opaqueId('node', kind, ref.source, ref.resourceId);
}

function eventOrder(event: AuthenticatedWorkEvent): [number, string] {
  const source = event.sourceSequence;
  const numeric = source !== undefined && /^\d+$/.test(source) ? Number(source) : Number.NaN;
  return [Number.isSafeInteger(numeric) ? numeric : Date.parse(event.occurredAt), event.eventId];
}

function nodeOrder(node: InternalWorkNode): [number, string] {
  const source = node.sourceSequence;
  const numeric = source !== undefined && /^\d+$/.test(source) ? Number(source) : Number.NaN;
  return [Number.isSafeInteger(numeric) ? numeric : Date.parse(node.updatedAt), node.sourceEventId];
}

function isNewer(event: AuthenticatedWorkEvent, node: InternalWorkNode): boolean {
  const incoming = eventOrder(event);
  const existing = nodeOrder(node);
  return incoming[0] > existing[0] || (incoming[0] === existing[0] && incoming[1] > existing[1]);
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
  episode?: boolean;
}

interface EdgeInput {
  from: NodeInput;
  to: NodeInput;
  relation: WorkRelation;
}

function sourceRef(event: AuthenticatedWorkEvent, resourceId: string): WorkSourceRef {
  return { source: event.source, resourceId };
}

function inputsFor(event: AuthenticatedWorkEvent): { nodes: NodeInput[]; edges: EdgeInput[]; deleting: boolean } {
  const status = statusFor(event);
  const safe = (fallback: string) => event.payload.safeLabel?.trim() || fallback;
  switch (event.payload.kind) {
    case 'cloud-compute': {
      const terminal: NodeInput = { kind: 'terminal', resourceId: event.payload.boxId, title: safe('Cloud terminal'), status };
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
      return { nodes, edges, deleting: event.payload.lifecycle === 'deleted' };
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
      return { nodes, edges, deleting: false };
    }
    case 'document': {
      const document: NodeInput = { kind: 'document', resourceId: event.payload.documentId, title: safe('Document'), status };
      const change: NodeInput = { kind: 'change', resourceId: `${event.payload.documentId}:${event.payload.revisionId}`, title: 'Document change', status, episode: true };
      return { nodes: [document, change], edges: [{ from: change, to: document, relation: 'edited' }], deleting: event.payload.lifecycle === 'deleted' };
    }
    case 'pipeline': {
      return { nodes: [{ kind: 'run', resourceId: event.payload.runId, title: safe('Pipeline run'), status }], edges: [], deleting: false };
    }
    case 'conversation': {
      return { nodes: [{ kind: 'conversation', resourceId: event.payload.conversationId, title: safe(event.payload.conversationKind === 'dm' ? 'Direct conversation' : 'Conversation'), status }], edges: [], deleting: event.payload.lifecycle === 'membership-removed' };
    }
    case 'meeting': {
      const meeting: NodeInput = { kind: 'meeting', resourceId: event.payload.meetingId, title: safe('Meeting'), status };
      const nodes: NodeInput[] = [meeting]; const edges: EdgeInput[] = [];
      if (event.payload.transcriptId) {
        const transcript: NodeInput = { kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', status };
        nodes.push(transcript); edges.push({ from: transcript, to: meeting, relation: 'derived-from' });
      }
      return { nodes, edges, deleting: event.payload.lifecycle.endsWith('-deleted') };
    }
  }
}

function upsertNode(state: WorkProjectionState, event: AuthenticatedWorkEvent, input: NodeInput, deleting: boolean): InternalWorkNode {
  const ref = sourceRef(event, input.resourceId);
  const id = nodeId(input.kind, ref);
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
    ...(deleting ? { endedAt: event.occurredAt, deletedAt: event.occurredAt } : {}),
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
  if (current.appliedEventIds.includes(event.eventId)) return current;

  const next: WorkProjectionState = {
    ...current,
    revision: current.revision + 1,
    nodes: { ...current.nodes },
    edges: { ...current.edges },
    sourceCheckpoints: { ...current.sourceCheckpoints, ...(event.sourceSequence ? { [event.source]: event.sourceSequence } : {}) },
    appliedEventIds: [...current.appliedEventIds, event.eventId],
  };
  const inputs = inputsFor(event);
  for (const input of inputs.nodes) {
    const node = upsertNode(next, event, input, inputs.deleting && !input.episode);
    next.nodes[node.id] = node;
  }
  for (const input of inputs.edges) {
    const fromId = nodeId(input.from.kind, sourceRef(event, input.from.resourceId));
    const toId = nodeId(input.to.kind, sourceRef(event, input.to.resourceId));
    if (!next.nodes[fromId] || !next.nodes[toId]) continue;
    const id = opaqueId('edge', fromId, toId, input.relation);
    const existing = next.edges[id];
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
      ...(inputs.deleting ? { endedAt: event.occurredAt, deletedAt: event.occurredAt } : {}),
      sourceEventId: event.eventId,
      provenance: 'source-event',
      revision: (existing?.revision ?? 0) + 1,
    };
    next.edges[id] = edge;
  }
  return next;
}
