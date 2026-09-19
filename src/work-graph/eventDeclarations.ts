import { WORK_GRAPH_LIMITS, type WorkSourceKind } from './contracts';

export interface WorkGraphEventDeclaration {
  name: string;
  namespace: 'work-graph';
  schema: Record<string, unknown>;
  transport: 'durable' | 'signal';
  producer: string;
  description: string;
  tags: string[];
  version: 1;
  compatibilityMode: 'backward';
  queue?: string;
  retention?: number;
  dlqAfterAttempts?: number;
}

const identifier = { type: 'string', minLength: 1, maxLength: WORK_GRAPH_LIMITS.idLength } as const;
const label = { type: 'string', minLength: 1, maxLength: WORK_GRAPH_LIMITS.labelLength } as const;
const timestamp = { type: 'string', format: 'date-time', maxLength: 40 } as const;

const payloadSchemas: Record<WorkSourceKind, Record<string, unknown>> = {
  'cloud-compute': {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'boxId'],
    properties: { kind: { const: 'cloud-compute' }, lifecycle: { enum: ['created', 'started', 'waiting', 'completed', 'stopped', 'failed', 'deleted'] }, boxId: identifier, jobId: identifier, agentId: identifier, projectId: identifier, attempt: { type: 'integer', minimum: 1, maximum: 10_000 }, safeLabel: label },
  },
  'local-compute': {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'machineId'],
    properties: { kind: { const: 'local-compute' }, lifecycle: { enum: ['session-started', 'session-ended', 'job-started', 'job-finished', 'heartbeat', 'disconnected'] }, machineId: identifier, sessionId: identifier, jobId: identifier, projectId: identifier, heartbeatAt: timestamp, safeLabel: label },
  },
  document: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'documentId', 'revisionId'],
    properties: { kind: { const: 'document' }, lifecycle: { enum: ['revision-saved', 'deleted'] }, documentId: identifier, revisionId: identifier, attributedActorId: identifier, producedByRunId: identifier, safeLabel: label },
  },
  pipeline: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'pipelineId', 'runId', 'attempt'],
    properties: { kind: { const: 'pipeline' }, lifecycle: { enum: ['started', 'waiting', 'completed', 'failed', 'cancelled'] }, pipelineId: identifier, runId: identifier, attempt: { type: 'integer', minimum: 1, maximum: 10_000 }, artifactIds: { type: 'array', maxItems: 100, uniqueItems: true, items: identifier }, safeLabel: label },
  },
  conversation: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'conversationId', 'conversationKind'],
    properties: { kind: { const: 'conversation' }, lifecycle: { enum: ['contributed', 'membership-added', 'membership-removed'] }, conversationId: identifier, conversationKind: { enum: ['dm', 'channel'] }, explicitRelatedResource: { type: 'object', additionalProperties: false, required: ['source', 'resourceId'], properties: { source: { enum: ['cloud-compute', 'local-compute', 'document', 'pipeline', 'meeting'] }, resourceId: identifier, resourceVersion: identifier } }, safeLabel: label },
  },
  meeting: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'lifecycle', 'meetingId'],
    properties: { kind: { const: 'meeting' }, lifecycle: { enum: ['attendance-started', 'attendance-ended', 'recording-started', 'recording-ready', 'recording-failed', 'recording-deleted', 'transcript-ready', 'transcript-failed', 'transcript-deleted'] }, meetingId: identifier, recordingId: identifier, transcriptId: identifier, recordingOwnerId: identifier, safeLabel: label },
  },
};

const producerBySource: Record<WorkSourceKind, string> = {
  'cloud-compute': 'aws-agentcore',
  'local-compute': 'aws-agentcore',
  document: 'websocket-gateway',
  pipeline: 'platform-api',
  conversation: 'websocket-gateway',
  meeting: 'platform-api',
};

function sourceEventSchema(source: WorkSourceKind, heartbeatOnly = false): Record<string, unknown> {
  const schema = payloadSchemas[source];
  const lifecycle = heartbeatOnly
    ? { const: 'heartbeat' }
    : source === 'local-compute'
      ? { enum: ['session-started', 'session-ended', 'job-started', 'job-finished', 'disconnected'] }
      : undefined;
  const payload = lifecycle
    ? { ...schema, properties: { ...(schema.properties as Record<string, unknown>), lifecycle } }
    : schema;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'eventId', 'idempotencyKey', 'source', 'occurredAt', 'receivedAt', 'actor', 'producer', 'resource', 'payload'],
    properties: {
      schemaVersion: { const: 1 }, eventId: identifier, idempotencyKey: identifier,
      source: { const: source }, sourceSequence: identifier, occurredAt: timestamp, receivedAt: timestamp,
      actor: { type: 'object', additionalProperties: false, required: ['actorId', 'organizationId', 'sourceSubject'], properties: { actorId: identifier, organizationId: identifier, sourceSubject: identifier } },
      producer: { type: 'object', additionalProperties: false, required: ['serviceId', 'organizationId', 'credentialId'], properties: { serviceId: { const: producerBySource[source] }, organizationId: identifier, credentialId: identifier } },
      resource: { type: 'object', additionalProperties: false, required: ['source', 'resourceId'], properties: { source: { const: source }, resourceId: identifier, resourceVersion: identifier } },
      payload,
    },
  };
}

const durableSources: WorkSourceKind[] = ['cloud-compute', 'local-compute', 'document', 'pipeline', 'conversation', 'meeting'];
export const workGraphLifecycleDeclarations: WorkGraphEventDeclaration[] = durableSources.map((source) => ({
  name: `work-graph.${source}.lifecycle.v1`, namespace: 'work-graph', schema: sourceEventSchema(source),
  transport: 'durable', producer: producerBySource[source], description: `Authenticated ${source} lifecycle input for the private work graph projection.`,
  tags: ['privacy:private', 'schema:v1', `source:${source}`, `max-bytes:${WORK_GRAPH_LIMITS.sourceEventBytes}`],
  version: 1, compatibilityMode: 'backward', queue: 'work-graph-projection-v1', retention: WORK_GRAPH_LIMITS.eventRetentionDays * 24 * 60 * 60, dlqAfterAttempts: 5,
}));

export const workGraphHeartbeatDeclaration: WorkGraphEventDeclaration = {
  name: 'work-graph.local-compute.heartbeat.v1', namespace: 'work-graph', schema: sourceEventSchema('local-compute', true),
  transport: 'signal', producer: 'aws-agentcore', description: 'Transient authenticated machine freshness signal; never human presence.',
  tags: ['privacy:private', 'schema:v1', 'source:local-compute', 'transient', `max-bytes:${WORK_GRAPH_LIMITS.sourceEventBytes}`],
  version: 1, compatibilityMode: 'backward',
};

export const workGraphEventDeclarations = [...workGraphLifecycleDeclarations, workGraphHeartbeatDeclaration] as const;

/** Event-catalog JSON Schema cannot enforce UTF-8 envelope byte length. */
export function isWithinWorkGraphEventLimit(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= WORK_GRAPH_LIMITS.sourceEventBytes;
  } catch {
    return false;
  }
}
