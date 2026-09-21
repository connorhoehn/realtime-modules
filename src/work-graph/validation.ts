/**
 * Runtime boundary for work-graph wire data.
 *
 * These checks deliberately accept only JSON-shaped, exact contract objects.
 * They are for data received from another process or from a persisted stream;
 * they do not authenticate a producer or authorize a viewer.
 */
import {
  WORK_GRAPH_LIMITS,
  WORK_GRAPH_SCHEMA_VERSION,
  type AuthenticatedWorkEvent,
  type CollaborationCapability,
  type DisclosureLevel,
  type SharingAudience,
  type WorkGraphDeltaBatch,
  type WorkGraphDeltaOperation,
  type WorkGraphSnapshot,
  type WorkGraphSchemaVersion,
  type WorkHistoryGrant,
  type WorkReference,
  type WorkReferenceTarget,
  type WorkSharingGrant,
  type WorkSourceKind,
  type WorkSourceStatus,
  type ViewerWorkEdge,
  type ViewerWorkNode,
} from './contracts';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type JsonRecord = Record<string, unknown>;

const sourceKinds = new Set<WorkSourceKind>([
  'cloud-compute', 'local-compute', 'document', 'pipeline', 'conversation', 'meeting',
]);
const nodeKinds = new Set([
  'project', 'terminal', 'agent', 'run', 'document', 'change', 'conversation', 'meeting', 'transcript', 'task',
]);
const relations = new Set([
  'works-on', 'runs-in', 'operates-on', 'produced', 'edited', 'attended', 'discussed', 'derived-from',
]);
const statuses = new Set(['idle', 'running', 'waiting', 'completed', 'error', 'stopped', 'stale']);
const disclosures = new Set<DisclosureLevel>(['existence', 'summary', 'details']);
const capabilities = new Set<CollaborationCapability>([
  'message', 'view-document', 'edit-document', 'join-conversation', 'join-meeting',
  'observe-terminal', 'control-terminal', 'view-transcript', 'view-run', 'dispatch-run',
]);
const sourceHealth = new Set(['available', 'delayed', 'disconnected', 'authorization-unavailable']);
const grantStates = new Set(['active', 'paused', 'stopped', 'expired']);
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is JsonRecord {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === 'string' && allowed.has(key) && !dangerousKeys.has(key));
}

function stringWithin(value: unknown, max: number = WORK_GRAPH_LIMITS.idLength): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Opaque IDs remain opaque, but cannot contain control characters or whitespace. */
function isId(value: unknown): value is string {
  return stringWithin(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isCursor(value: unknown): value is string {
  return stringWithin(value, WORK_GRAPH_LIMITS.cursorLength)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((fractionText ?? '').padEnd(3, '0') || '0');
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > WORK_GRAPH_LIMITS.timezoneLength) return false;
  if (!(value === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(value))) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function hasUniqueIds(values: unknown, maximum: number): values is string[] {
  return Array.isArray(values) && values.length <= maximum && values.every(isId) && new Set(values).size === values.length;
}

function serializedBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function withinSerializedLimit(value: unknown, maximum: number): boolean {
  const bytes = serializedBytes(value);
  return bytes !== null && bytes <= maximum;
}

function isSchemaVersion(value: unknown): value is WorkGraphSchemaVersion {
  return value === WORK_GRAPH_SCHEMA_VERSION;
}

function isSourceAnchor(value: unknown): boolean {
  return hasExactKeys(value, ['kind', 'id'])
    && ['slide', 'page', 'block', 'transcript-segment'].includes(value.kind as string)
    && isId(value.id);
}

function isSourceRef(value: unknown, expectedSource?: WorkSourceKind): boolean {
  if (!hasExactKeys(value, ['source', 'resourceId'], ['resourceVersion', 'anchor'])) return false;
  return sourceKinds.has(value.source as WorkSourceKind)
    && (!expectedSource || value.source === expectedSource)
    && isId(value.resourceId)
    && (value.resourceVersion === undefined || isId(value.resourceVersion))
    && (value.anchor === undefined || isSourceAnchor(value.anchor));
}

function isEventPayload(value: unknown, source: WorkSourceKind): boolean {
  if (!isRecord(value) || value.kind !== source) return false;
  const label = (record: JsonRecord) => record.safeLabel === undefined || stringWithin(record.safeLabel, WORK_GRAPH_LIMITS.labelLength);
  switch (source) {
    case 'cloud-compute':
      return hasExactKeys(value, ['kind', 'lifecycle', 'boxId'], ['jobId', 'agentId', 'projectId', 'attempt', 'safeLabel', 'projectLabel'])
        && ['created', 'started', 'waiting', 'completed', 'stopped', 'failed', 'deleted'].includes(value.lifecycle as string)
        && isId(value.boxId) && (value.jobId === undefined || isId(value.jobId))
        && (value.agentId === undefined || isId(value.agentId)) && (value.projectId === undefined || isId(value.projectId))
        && (value.attempt === undefined || isNonNegativeInteger(value.attempt))
        && (value.projectLabel === undefined || stringWithin(value.projectLabel, WORK_GRAPH_LIMITS.labelLength)) && label(value);
    case 'local-compute':
      return hasExactKeys(value, ['kind', 'lifecycle', 'machineId'], ['sessionId', 'jobId', 'projectId', 'heartbeatAt', 'safeLabel'])
        && ['session-started', 'session-ended', 'job-started', 'job-finished', 'heartbeat', 'disconnected'].includes(value.lifecycle as string)
        && isId(value.machineId) && (value.sessionId === undefined || isId(value.sessionId))
        && (value.jobId === undefined || isId(value.jobId)) && (value.projectId === undefined || isId(value.projectId))
        && (value.heartbeatAt === undefined || isTimestamp(value.heartbeatAt)) && label(value);
    case 'document':
      return hasExactKeys(value, ['kind', 'lifecycle', 'documentId', 'revisionId'], ['attributedActorId', 'producedByRunId', 'safeLabel'])
        && ['revision-saved', 'deleted'].includes(value.lifecycle as string)
        && isId(value.documentId) && isId(value.revisionId)
        && (value.attributedActorId === undefined || isId(value.attributedActorId))
        && (value.producedByRunId === undefined || isId(value.producedByRunId)) && label(value);
    case 'pipeline':
      return hasExactKeys(value, ['kind', 'lifecycle', 'pipelineId', 'runId', 'attempt'], ['artifactIds', 'safeLabel', 'inputs'])
        && ['started', 'waiting', 'completed', 'failed', 'cancelled'].includes(value.lifecycle as string)
        && isId(value.pipelineId) && isId(value.runId) && isNonNegativeInteger(value.attempt)
        && (value.artifactIds === undefined || hasUniqueIds(value.artifactIds, WORK_GRAPH_LIMITS.snapshotNodes))
        && (value.inputs === undefined || (Array.isArray(value.inputs) && value.inputs.length <= WORK_GRAPH_LIMITS.snapshotNodes && value.inputs.every((ref) => isSourceRef(ref))))
        && label(value);
    case 'conversation':
      return hasExactKeys(value, ['kind', 'lifecycle', 'conversationId', 'conversationKind'], ['explicitRelatedResource', 'safeLabel'])
        && ['contributed', 'membership-added', 'membership-removed'].includes(value.lifecycle as string)
        && isId(value.conversationId) && ['dm', 'channel'].includes(value.conversationKind as string)
        && (value.explicitRelatedResource === undefined || isSourceRef(value.explicitRelatedResource)) && label(value);
    case 'meeting':
      return hasExactKeys(value, ['kind', 'lifecycle', 'meetingId'], ['recordingId', 'transcriptId', 'recordingOwnerId', 'safeLabel'])
        && ['attendance-started', 'attendance-ended', 'recording-started', 'recording-ready', 'recording-failed', 'recording-deleted', 'transcript-ready', 'transcript-failed', 'transcript-deleted'].includes(value.lifecycle as string)
        && isId(value.meetingId) && (value.recordingId === undefined || isId(value.recordingId))
        && (value.transcriptId === undefined || isId(value.transcriptId))
        && (value.recordingOwnerId === undefined || isId(value.recordingOwnerId)) && label(value);
  }
}

function isViewerNode(value: unknown): value is ViewerWorkNode {
  return hasExactKeys(value, ['id', 'kind', 'title', 'status', 'disclosure', 'updatedAt', 'capabilities'], ['description', 'startedAt', 'endedAt', 'locked'])
    && isId(value.id) && nodeKinds.has(value.kind as string)
    && stringWithin(value.title, WORK_GRAPH_LIMITS.labelLength)
    && (value.description === undefined || stringWithin(value.description, WORK_GRAPH_LIMITS.descriptionLength))
    && statuses.has(value.status as string) && disclosures.has(value.disclosure as DisclosureLevel)
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => capabilities.has(capability as CollaborationCapability))
    && new Set(value.capabilities).size === value.capabilities.length
    && (value.startedAt === undefined || isTimestamp(value.startedAt))
    && isTimestamp(value.updatedAt)
    && (value.endedAt === undefined || isTimestamp(value.endedAt))
    && (value.locked === undefined || typeof value.locked === 'boolean');
}

function isViewerEdge(value: unknown): value is ViewerWorkEdge {
  return hasExactKeys(value, ['id', 'fromId', 'toId', 'relation', 'status', 'disclosure', 'updatedAt', 'capabilities'], ['label', 'startedAt', 'endedAt'])
    && isId(value.id) && isId(value.fromId) && isId(value.toId) && value.fromId !== value.toId
    && relations.has(value.relation as string) && statuses.has(value.status as string)
    && disclosures.has(value.disclosure as DisclosureLevel)
    && (value.label === undefined || stringWithin(value.label, WORK_GRAPH_LIMITS.labelLength))
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => capabilities.has(capability as CollaborationCapability))
    && new Set(value.capabilities).size === value.capabilities.length
    && (value.startedAt === undefined || isTimestamp(value.startedAt))
    && isTimestamp(value.updatedAt)
    && (value.endedAt === undefined || isTimestamp(value.endedAt));
}

function isSourceStatus(value: unknown): value is WorkSourceStatus {
  return hasExactKeys(value, ['source', 'health', 'checkedAt'], ['message'])
    && sourceKinds.has(value.source as WorkSourceKind) && sourceHealth.has(value.health as string)
    && isTimestamp(value.checkedAt)
    && (value.message === undefined || stringWithin(value.message, WORK_GRAPH_LIMITS.descriptionLength));
}

function isReferenceTarget(value: unknown): value is WorkReferenceTarget {
  return hasExactKeys(value, ['kind', 'id']) && (value.kind === 'node' || value.kind === 'edge') && isId(value.id);
}

function result<T>(valid: boolean, value: unknown, name: string): ValidationResult<T> {
  return valid ? { ok: true, value: value as T } : { ok: false, errors: [`Invalid ${name}.`] };
}

export function validateAuthenticatedWorkEvent(value: unknown): ValidationResult<AuthenticatedWorkEvent> {
  const valid = hasExactKeys(value, ['schemaVersion', 'eventId', 'idempotencyKey', 'source', 'occurredAt', 'receivedAt', 'actor', 'producer', 'resource', 'payload'], ['sourceSequence'])
    && isSchemaVersion(value.schemaVersion) && isId(value.eventId) && isId(value.idempotencyKey)
    && sourceKinds.has(value.source as WorkSourceKind) && isTimestamp(value.occurredAt) && isTimestamp(value.receivedAt)
    && (value.sourceSequence === undefined || isId(value.sourceSequence))
    && hasExactKeys(value.actor, ['actorId', 'organizationId', 'sourceSubject'])
    && isId(value.actor.actorId) && isId(value.actor.organizationId) && isId(value.actor.sourceSubject)
    && hasExactKeys(value.producer, ['serviceId', 'organizationId', 'credentialId'])
    && isId(value.producer.serviceId) && isId(value.producer.organizationId) && isId(value.producer.credentialId)
    && value.actor.organizationId === value.producer.organizationId
    && isSourceRef(value.resource, value.source as WorkSourceKind)
    && isEventPayload(value.payload, value.source as WorkSourceKind)
    && withinSerializedLimit(value, WORK_GRAPH_LIMITS.sourceEventBytes);
  return result(valid, value, 'authenticated work event');
}

function isGrantBase(value: unknown, history: boolean): boolean {
  const optional = history ? ['dayFrom', 'dayThrough'] : ['historyGrantId'];
  if (!hasExactKeys(value, ['schemaVersion', 'id', 'organizationId', 'ownerId', 'audience', 'selection', 'state', 'createdAt', 'updatedAt', 'expiresAt', 'revision'], optional)) return false;
  if (!isSchemaVersion(value.schemaVersion) || !isId(value.id) || !isId(value.organizationId) || !isId(value.ownerId)
    || !grantStates.has(value.state as string) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt) || !isPositiveInteger(value.revision)) return false;
  const created = Date.parse(value.createdAt as string);
  const updated = Date.parse(value.updatedAt as string);
  const expires = Date.parse(value.expiresAt as string);
  if (updated < created || expires <= created) return false;
  const duration = expires - created;
  const maximum = history ? WORK_GRAPH_LIMITS.maximumHistorySharingMs : WORK_GRAPH_LIMITS.maximumSharingMs;
  if (duration < WORK_GRAPH_LIMITS.minimumSharingMs || duration > maximum) return false;
  if (!isSharingAudience(value.audience) || !isSharingSelection(value.selection)) return false;
  return history || value.historyGrantId === undefined || isId(value.historyGrantId);
}

function isSharingAudience(value: unknown): value is SharingAudience {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'organization') return hasExactKeys(value, ['kind']);
  if (value.kind === 'people') return hasExactKeys(value, ['kind', 'personIds']) && hasUniqueIds(value.personIds, WORK_GRAPH_LIMITS.pageNodes) && value.personIds.length > 0;
  return value.kind === 'conversation' && hasExactKeys(value, ['kind', 'conversationIds']) && hasUniqueIds(value.conversationIds, WORK_GRAPH_LIMITS.pageNodes) && value.conversationIds.length > 0;
}

function isSharingSelection(value: unknown): boolean {
  return hasExactKeys(value, ['nodeIds', 'edgeIds', 'disclosure'])
    && hasUniqueIds(value.nodeIds, WORK_GRAPH_LIMITS.snapshotNodes)
    && hasUniqueIds(value.edgeIds, WORK_GRAPH_LIMITS.snapshotEdges)
    && value.nodeIds.length + value.edgeIds.length > 0
    && disclosures.has(value.disclosure as DisclosureLevel);
}

export function validateWorkSharingGrant(value: unknown): ValidationResult<WorkSharingGrant> {
  return result(isGrantBase(value, false), value, 'work sharing grant');
}

export function validateWorkHistoryGrant(value: unknown): ValidationResult<WorkHistoryGrant> {
  const valid = hasExactKeys(value, ['schemaVersion', 'id', 'organizationId', 'ownerId', 'audience', 'selection', 'state', 'createdAt', 'updatedAt', 'expiresAt', 'revision', 'dayFrom', 'dayThrough'])
    && isGrantBase(value, true)
    && isCalendarDate(value.dayFrom) && isCalendarDate(value.dayThrough) && value.dayFrom <= value.dayThrough
    && Date.parse(`${value.dayThrough}T00:00:00.000Z`) - Date.parse(`${value.dayFrom}T00:00:00.000Z`) < WORK_GRAPH_LIMITS.maximumHistorySharingMs;
  return result(valid, value, 'work history grant');
}

export function validateWorkGraphSnapshot(value: unknown): ValidationResult<WorkGraphSnapshot> {
  let valid = hasExactKeys(value, ['schemaVersion', 'scope', 'revision', 'watermark', 'cursor', 'nodes', 'edges', 'sources', 'partial'], ['nextPageCursor'])
    && isSchemaVersion(value.schemaVersion) && isNonNegativeInteger(value.revision) && isNonNegativeInteger(value.watermark)
    && isCursor(value.cursor) && typeof value.partial === 'boolean'
    && hasExactKeys(value.scope, ['personId', 'day', 'timezone', 'policyRevision'])
    && isId(value.scope.personId) && isCalendarDate(value.scope.day) && isTimezone(value.scope.timezone) && isId(value.scope.policyRevision)
    && (value.nextPageCursor === undefined || isCursor(value.nextPageCursor))
    && Array.isArray(value.nodes) && value.nodes.length <= WORK_GRAPH_LIMITS.snapshotNodes && value.nodes.every(isViewerNode)
    && Array.isArray(value.edges) && value.edges.length <= WORK_GRAPH_LIMITS.snapshotEdges && value.edges.every(isViewerEdge)
    && Array.isArray(value.sources) && value.sources.length <= sourceKinds.size && value.sources.every(isSourceStatus);
  if (valid) {
    const snapshot = value as WorkGraphSnapshot;
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    valid = nodeIds.size === snapshot.nodes.length
      && new Set(snapshot.edges.map((edge) => edge.id)).size === snapshot.edges.length
      && new Set(snapshot.sources.map((source) => source.source)).size === snapshot.sources.length
      && snapshot.edges.every((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
  }
  return result(valid, value, 'work graph snapshot');
}

function isDeltaOperation(value: unknown): value is WorkGraphDeltaOperation {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'upsert-node': return hasExactKeys(value, ['kind', 'node']) && isViewerNode(value.node);
    case 'remove-node': return hasExactKeys(value, ['kind', 'nodeId']) && isId(value.nodeId);
    case 'upsert-edge': return hasExactKeys(value, ['kind', 'edge']) && isViewerEdge(value.edge);
    case 'remove-edge': return hasExactKeys(value, ['kind', 'edgeId']) && isId(value.edgeId);
    case 'source-health': return hasExactKeys(value, ['kind', 'source']) && isSourceStatus(value.source);
    default: return false;
  }
}

export function validateWorkGraphDeltaBatch(value: unknown): ValidationResult<WorkGraphDeltaBatch> {
  const valid = hasExactKeys(value, ['schemaVersion', 'subscriptionGeneration', 'previousWatermark', 'watermark', 'cursor', 'policyRevision', 'operations'])
    && isSchemaVersion(value.schemaVersion) && isId(value.subscriptionGeneration) && isNonNegativeInteger(value.previousWatermark)
    && isNonNegativeInteger(value.watermark) && value.watermark > value.previousWatermark
    && isCursor(value.cursor) && isId(value.policyRevision)
    && Array.isArray(value.operations) && value.operations.length <= WORK_GRAPH_LIMITS.deltaOperations
    && value.operations.every(isDeltaOperation) && withinSerializedLimit(value, WORK_GRAPH_LIMITS.deltaBytes);
  return result(valid, value, 'work graph delta batch');
}

export function validateWorkReference(value: unknown): ValidationResult<WorkReference> {
  const valid = hasExactKeys(value, ['version', 'personId', 'day', 'timezone', 'target'], ['sessionId', 'eventId', 'observedAt'])
    && isSchemaVersion(value.version) && isId(value.personId) && isCalendarDate(value.day) && isTimezone(value.timezone)
    && isReferenceTarget(value.target) && (value.sessionId === undefined || isId(value.sessionId))
    && (value.eventId === undefined || isId(value.eventId)) && (value.observedAt === undefined || isTimestamp(value.observedAt))
    && withinSerializedLimit(value, WORK_GRAPH_LIMITS.referenceBytes);
  return result(valid, value, 'work reference');
}

export const isAuthenticatedWorkEvent = (value: unknown): value is AuthenticatedWorkEvent => validateAuthenticatedWorkEvent(value).ok;
export const isWorkSharingGrant = (value: unknown): value is WorkSharingGrant => validateWorkSharingGrant(value).ok;
export const isWorkHistoryGrant = (value: unknown): value is WorkHistoryGrant => validateWorkHistoryGrant(value).ok;
export const isWorkGraphSnapshot = (value: unknown): value is WorkGraphSnapshot => validateWorkGraphSnapshot(value).ok;
export const isWorkGraphDeltaBatch = (value: unknown): value is WorkGraphDeltaBatch => validateWorkGraphDeltaBatch(value).ok;
export const isWorkReference = (value: unknown): value is WorkReference => validateWorkReference(value).ok;
