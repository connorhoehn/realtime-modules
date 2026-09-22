"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workGraphEventDeclarations = exports.workGraphProjectionChangedDeclaration = exports.workGraphHeartbeatDeclaration = exports.workGraphLifecycleDeclarations = void 0;
exports.workGraphProducersFor = workGraphProducersFor;
exports.isWithinWorkGraphEventLimit = isWithinWorkGraphEventLimit;
const contracts_1 = require("./contracts");
const identifier = { type: 'string', minLength: 1, maxLength: contracts_1.WORK_GRAPH_LIMITS.idLength };
const label = { type: 'string', minLength: 1, maxLength: contracts_1.WORK_GRAPH_LIMITS.labelLength };
const timestamp = { type: 'string', format: 'date-time', maxLength: 40 };
/**
 * A resource another source owns, named explicitly. It is the wire shape of
 * `WorkSourceRef`, and it is shared by every payload that declares a
 * relationship rather than leaving one to be inferred.
 */
const sourceRef = {
    type: 'object', additionalProperties: false, required: ['source', 'resourceId'],
    properties: {
        source: { enum: ['cloud-compute', 'local-compute', 'document', 'pipeline', 'conversation', 'meeting'] },
        resourceId: identifier,
        resourceVersion: identifier,
    },
};
const sourceRefs = { type: 'array', maxItems: 100, items: sourceRef };
const payloadSchemas = {
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
        properties: { kind: { const: 'pipeline' }, lifecycle: { enum: ['started', 'waiting', 'completed', 'failed', 'cancelled'] }, pipelineId: identifier, runId: identifier, attempt: { type: 'integer', minimum: 1, maximum: 10_000 }, artifactIds: { type: 'array', maxItems: 100, uniqueItems: true, items: identifier }, safeLabel: label, inputs: sourceRefs, produces: sourceRefs, workspace: { type: 'object', additionalProperties: false, required: ['resourceId'], properties: { resourceId: identifier, safeLabel: label } } },
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
const producerBySource = {
    'cloud-compute': 'aws-agentcore',
    'local-compute': 'aws-agentcore',
    document: 'websocket-gateway',
    pipeline: 'platform-api',
    conversation: 'websocket-gateway',
    meeting: 'platform-api',
};
/**
 * Services other than the primary writer that may publish a source.
 *
 * A generated presentation is a document whose row platform-api writes, so it
 * is the document's real producer; the gateway never sees one. Admitting it
 * here keeps that node identical to the one the gateway would have projected,
 * which is what an artifact card and "Open presentation" depend on. It is an
 * allowlist of SERVICES, not a licence over content: a consumer still checks
 * that the publisher owns the document it is describing.
 */
const alsoProducedBySource = {
    document: ['platform-api'],
};
/** Every service allowed to publish a source's lifecycle event. */
function workGraphProducersFor(source) {
    return [producerBySource[source], ...(alsoProducedBySource[source] ?? [])];
}
function sourceEventSchema(source, heartbeatOnly = false) {
    const schema = payloadSchemas[source];
    const lifecycle = heartbeatOnly
        ? { const: 'heartbeat' }
        : source === 'local-compute'
            ? { enum: ['session-started', 'session-ended', 'job-started', 'job-finished', 'disconnected'] }
            : undefined;
    const payload = lifecycle
        ? { ...schema, properties: { ...schema.properties, lifecycle } }
        : schema;
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'eventId', 'idempotencyKey', 'source', 'occurredAt', 'receivedAt', 'actor', 'producer', 'resource', 'payload'],
        properties: {
            schemaVersion: { const: 1 }, eventId: identifier, idempotencyKey: identifier,
            source: { const: source }, sourceSequence: identifier, occurredAt: timestamp, receivedAt: timestamp,
            actor: { type: 'object', additionalProperties: false, required: ['actorId', 'organizationId', 'sourceSubject'], properties: { actorId: identifier, organizationId: identifier, sourceSubject: identifier } },
            producer: { type: 'object', additionalProperties: false, required: ['serviceId', 'organizationId', 'credentialId'], properties: { serviceId: { enum: [...workGraphProducersFor(source)] }, organizationId: identifier, credentialId: identifier } },
            resource: { type: 'object', additionalProperties: false, required: ['source', 'resourceId'], properties: { source: { const: source }, resourceId: identifier, resourceVersion: identifier } },
            payload,
        },
    };
}
const durableSources = ['cloud-compute', 'local-compute', 'document', 'pipeline', 'conversation', 'meeting'];
exports.workGraphLifecycleDeclarations = durableSources.map((source) => ({
    name: `work-graph.${source}.lifecycle.v1`, namespace: 'work-graph', schema: sourceEventSchema(source),
    transport: 'durable', producer: producerBySource[source], producers: workGraphProducersFor(source),
    description: `Authenticated ${source} lifecycle input for the private work graph projection.`,
    tags: ['privacy:private', 'schema:v1', `source:${source}`, `max-bytes:${contracts_1.WORK_GRAPH_LIMITS.sourceEventBytes}`],
    version: 1, compatibilityMode: 'backward', queue: 'work-graph-projection-v1', retention: contracts_1.WORK_GRAPH_LIMITS.eventRetentionDays * 24 * 60 * 60, dlqAfterAttempts: 5,
}));
exports.workGraphHeartbeatDeclaration = {
    name: 'work-graph.local-compute.heartbeat.v1', namespace: 'work-graph', schema: sourceEventSchema('local-compute', true),
    transport: 'signal', producer: 'aws-agentcore', producers: ['aws-agentcore'],
    description: 'Transient authenticated machine freshness signal; never human presence.',
    tags: ['privacy:private', 'schema:v1', 'source:local-compute', 'transient', `max-bytes:${contracts_1.WORK_GRAPH_LIMITS.sourceEventBytes}`],
    version: 1, compatibilityMode: 'backward',
};
exports.workGraphProjectionChangedDeclaration = {
    name: 'work-graph.projection.changed.v1',
    namespace: 'work-graph',
    transport: 'durable',
    producer: 'platform-api',
    producers: ['platform-api'],
    description: 'A private work-graph projection revision is ready for authorized gateway replay.',
    tags: ['privacy:private', 'schema:v1', 'projection', `max-bytes:${contracts_1.WORK_GRAPH_LIMITS.sourceEventBytes}`],
    version: 1,
    compatibilityMode: 'backward',
    queue: 'work-graph-projection-changed-v1',
    retention: contracts_1.WORK_GRAPH_LIMITS.eventRetentionDays * 24 * 60 * 60,
    dlqAfterAttempts: 5,
    schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        required: ['organizationId', 'actorId', 'day', 'revision', 'sourceEventId'],
        properties: {
            organizationId: identifier,
            actorId: identifier,
            day: { type: 'string', format: 'date' },
            revision: { type: 'integer', minimum: 1 },
            sourceEventId: identifier,
        },
    },
};
exports.workGraphEventDeclarations = [
    ...exports.workGraphLifecycleDeclarations,
    exports.workGraphHeartbeatDeclaration,
    exports.workGraphProjectionChangedDeclaration,
];
/** Event-catalog JSON Schema cannot enforce UTF-8 envelope byte length. */
function isWithinWorkGraphEventLimit(value) {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength <= contracts_1.WORK_GRAPH_LIMITS.sourceEventBytes;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=eventDeclarations.js.map