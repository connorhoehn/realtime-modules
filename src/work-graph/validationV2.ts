import { WORK_GRAPH_LIMITS } from './contracts';
import { WORK_GRAPH_V2_LIMITS, type WorkGraphQueryV2, type WorkGraphSnapshotV2, type WorkReferenceV2, type ViewerWorkActivityDetail } from './contractsV2';
import { workDayWindow } from './dayWindow';
import { validateWorkGraphSnapshot, validateWorkReference, type ValidationResult } from './validation';

type RecordValue = Record<string, unknown>;
function exact(value: unknown, required: string[], optional: string[] = []): value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key));
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= WORK_GRAPH_LIMITS.idLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= WORK_GRAPH_LIMITS.labelLength;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ids = (value: unknown, maximum: number): value is string[] => Array.isArray(value) && value.length <= maximum && value.every(id) && new Set(value).size === value.length;
const result = <T>(valid: boolean, value: unknown, name: string): ValidationResult<T> => valid ? { ok: true, value: value as T } : { ok: false, errors: [`Invalid ${name}.`] };
function bytes(value: unknown, maximum: number): boolean { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum; } catch { return false; } }
function lease(value: unknown): boolean { return exact(value, ['observedAt', 'expiresAt']) && time(value.observedAt) && time(value.expiresAt) && value.observedAt < value.expiresAt; }
function anchor(value: unknown, withLabel = false): boolean { return exact(value, ['kind', 'id', ...(withLabel ? ['label'] : [])], withLabel ? ['index'] : []) && ['slide', 'page', 'block', 'transcript-segment'].includes(String(value.kind)) && id(value.id) && (!withLabel || (label(value.label) && (value.index === undefined || integer(value.index)))); }
function link(value: unknown): boolean { return exact(value, ['nodeId', 'label'], ['meta']) && id(value.nodeId) && label(value.label) && (value.meta === undefined || label(value.meta)); }
function links(value: unknown): boolean { return Array.isArray(value) && value.length <= WORK_GRAPH_V2_LIMITS.links && value.every(link) && new Set(value.map((item: RecordValue) => item.nodeId)).size === value.length; }
function participant(value: unknown): boolean {
  return exact(value, ['id', 'label'], ['avatarUrl'])
    && id(value.id) && label(value.label)
    // A relative, same-origin path only: no scheme, no host, no credential.
    && (value.avatarUrl === undefined || (typeof value.avatarUrl === 'string' && value.avatarUrl.length <= 512 && /^\/[^/\\]/.test(value.avatarUrl)));
}
function segment(value: unknown): boolean { return exact(value, ['id', 'at', 'speaker', 'text']) && id(value.id) && time(value.at) && label(value.speaker) && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= WORK_GRAPH_LIMITS.descriptionLength; }

export function validateWorkGraphQueryV2(value: unknown): ValidationResult<WorkGraphQueryV2> {
  let valid = exact(value, ['schemaVersion', 'personId', 'day', 'timezone', 'windowStart', 'windowEnd', 'mode']) && value.schemaVersion === 2 && id(value.personId) && typeof value.day === 'string' && typeof value.timezone === 'string' && value.timezone.length <= WORK_GRAPH_LIMITS.timezoneLength && time(value.windowStart) && time(value.windowEnd) && ['live', 'as-of'].includes(String(value.mode));
  if (valid) {
    const query = value as WorkGraphQueryV2;
    try {
      const day = workDayWindow(query.day, query.timezone);
      valid = query.windowStart < query.windowEnd && query.windowStart >= day.start && query.windowEnd <= day.end;
    } catch { valid = false; }
  }
  return result(valid, value, 'v2 work graph query');
}

function detail(value: unknown): value is ViewerWorkActivityDetail {
  if (!exact(value, ['nodeId'], ['summary', 'lines', 'badge', 'excerpt', 'footer', 'participants', 'inputs', 'sources', 'workItem', 'transcript', 'freshness', 'tools', 'attention', 'artifact', 'feedback', 'pause']) || !id(value.nodeId)) return false;
  if (value.badge !== undefined && !label(value.badge)) return false;
  if (value.excerpt !== undefined && !label(value.excerpt)) return false;
  if (value.footer !== undefined && (!exact(value.footer, ['label'], ['note']) || !label(value.footer.label) || (value.footer.note !== undefined && !label(value.footer.note)))) return false;
  if (value.participants !== undefined && (!Array.isArray(value.participants) || value.participants.length > WORK_GRAPH_V2_LIMITS.participants || !value.participants.every(participant) || new Set(value.participants.map((item: RecordValue) => item.id)).size !== value.participants.length)) return false;
  if (value.inputs !== undefined && !links(value.inputs)) return false;
  if (value.sources !== undefined && !links(value.sources)) return false;
  if (value.workItem !== undefined && !link(value.workItem)) return false;
  if (value.transcript !== undefined) {
    const transcript = value.transcript;
    if (!exact(transcript, ['segments', 'askEnabled']) || typeof transcript.askEnabled !== 'boolean'
      || !Array.isArray(transcript.segments) || transcript.segments.length > WORK_GRAPH_V2_LIMITS.transcriptSegments
      || !transcript.segments.every(segment)
      || new Set(transcript.segments.map((item: RecordValue) => item.id)).size !== transcript.segments.length) return false;
    // A transcript may not be presented out of order; order carries meaning.
    for (let index = 1; index < transcript.segments.length; index += 1) {
      if (transcript.segments[index].at < transcript.segments[index - 1].at) return false;
    }
  }
  if (value.summary !== undefined && !label(value.summary)) return false;
  if (value.lines !== undefined && (!Array.isArray(value.lines) || value.lines.length > WORK_GRAPH_V2_LIMITS.detailLines || !value.lines.every(label))) return false;
  if (value.freshness !== undefined && !lease(value.freshness)) return false;
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > WORK_GRAPH_V2_LIMITS.tools || !value.tools.every(label) || new Set(value.tools).size !== value.tools.length)) return false;
  if (value.attention !== undefined) {
    if (!exact(value.attention, ['kind', 'observedAt', 'expiresAt'], ['revisionId']) || value.attention.kind !== 'reviewing' || !lease({ observedAt: value.attention.observedAt, expiresAt: value.attention.expiresAt }) || (value.attention.revisionId !== undefined && !id(value.attention.revisionId))) return false;
  }
  if (value.pause !== undefined && (!exact(value.pause, ['reason'], ['step']) || !['awaiting_approval', 'paused_at_breakpoint'].includes(String(value.pause.reason)) || (value.pause.step !== undefined && !label(value.pause.step)))) return false;
  if (value.feedback !== undefined && (!exact(value.feedback, ['count', 'through']) || !integer(value.feedback.count) || !time(value.feedback.through))) return false;
  if (value.artifact !== undefined) {
    const artifact = value.artifact;
    if (!exact(artifact, ['mediaKind', 'revisions'], ['pending', 'pageCount', 'heading'])
      || (artifact.heading !== undefined && !label(artifact.heading))
      || (artifact.pageCount !== undefined && (!integer(artifact.pageCount) || artifact.pageCount === 0)) || !['presentation', 'document', 'image'].includes(String(artifact.mediaKind)) || !Array.isArray(artifact.revisions) || artifact.revisions.length > WORK_GRAPH_V2_LIMITS.revisions) return false;
    let lastCreation = '';
    const revisionIds = new Set<string>();
    for (const revision of artifact.revisions) {
      if (!exact(revision, ['id', 'label', 'createdAt'], ['previewHandle', 'anchors']) || !id(revision.id) || !label(revision.label) || !time(revision.createdAt) || revision.createdAt < lastCreation || revisionIds.has(revision.id) || (revision.previewHandle !== undefined && !id(revision.previewHandle))) return false;
      if (revision.anchors !== undefined && (!Array.isArray(revision.anchors) || revision.anchors.length > WORK_GRAPH_V2_LIMITS.anchors || !revision.anchors.every((item) => anchor(item, true)) || new Set(revision.anchors.map((item: RecordValue) => `${item.kind}:${item.id}`)).size !== revision.anchors.length)) return false;
      revisionIds.add(revision.id); lastCreation = revision.createdAt;
    }
    if (artifact.pending !== undefined) {
      const pending = artifact.pending;
      if (!exact(pending, ['revisionId', 'attemptId', 'label', 'status', 'startedAt', 'updatedAt'], ['message'])
        || (pending.message !== undefined && !label(pending.message)) || !id(pending.revisionId) || !id(pending.attemptId) || !label(pending.label) || !['generating', 'failed'].includes(String(pending.status)) || !time(pending.startedAt) || !time(pending.updatedAt) || pending.updatedAt < pending.startedAt || revisionIds.has(pending.revisionId)) return false;
    }
    if (value.attention && typeof value.attention === 'object' && 'revisionId' in value.attention && value.attention.revisionId !== undefined && !revisionIds.has(String(value.attention.revisionId))) return false;
  }
  if (value.attention && typeof value.attention === 'object' && 'revisionId' in value.attention && value.attention.revisionId !== undefined && value.artifact === undefined) return false;
  return true;
}

export function validateWorkGraphSnapshotV2(value: unknown): ValidationResult<WorkGraphSnapshotV2> {
  if (!exact(value, ['schemaVersion', 'scope', 'revision', 'watermark', 'cursor', 'nodes', 'edges', 'sources', 'partial', 'query', 'temporal', 'efforts', 'details', 'operations', 'eventBuckets'], ['nextPageCursor', 'viewHash']) || value.schemaVersion !== 2 || (value.viewHash !== undefined && (typeof value.viewHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.viewHash))) || !bytes(value, WORK_GRAPH_V2_LIMITS.snapshotBytes)) return result(false, value, 'v2 work graph snapshot');
  const { query, temporal, efforts, details, operations, eventBuckets, viewHash: _viewHash, ...base } = value;
  if (!validateWorkGraphSnapshot({ ...base, schemaVersion: 1 }).ok || !validateWorkGraphQueryV2(query).ok || !exact(temporal, ['mode', 'observedAt', 'coverage']) || !['live', 'as-of', 'recent'].includes(String(temporal.mode)) || !time(temporal.observedAt) || !exact(temporal.coverage, ['from', 'through', 'complete']) || !time(temporal.coverage.from) || !time(temporal.coverage.through) || temporal.coverage.from > temporal.coverage.through || typeof temporal.coverage.complete !== 'boolean') return result(false, value, 'v2 work graph snapshot');
  if (!Array.isArray(efforts) || efforts.length > WORK_GRAPH_V2_LIMITS.efforts || !Array.isArray(details) || details.length > WORK_GRAPH_LIMITS.snapshotNodes || !details.every(detail) || !Array.isArray(operations) || operations.length > WORK_GRAPH_LIMITS.snapshotEdges || !Array.isArray(eventBuckets) || eventBuckets.length > WORK_GRAPH_V2_LIMITS.eventBuckets) return result(false, value, 'v2 work graph snapshot');
  const snapshot = value as unknown as WorkGraphSnapshotV2;
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  let valid = snapshot.query.personId === snapshot.scope.personId && snapshot.query.day === snapshot.scope.day && snapshot.query.timezone === snapshot.scope.timezone && (snapshot.temporal.mode === 'recent' || snapshot.temporal.mode === snapshot.query.mode);
  const effortIds = new Set<string>();
  for (const effort of efforts) {
    if (!exact(effort, ['id', 'anchorNodeId', 'title', 'nodeIds', 'edgeIds', 'contextNodeIds'], ['subtitle']) || !id(effort.id) || effortIds.has(effort.id) || !id(effort.anchorNodeId) || !label(effort.title) || (effort.subtitle !== undefined && !label(effort.subtitle)) || !ids(effort.nodeIds, WORK_GRAPH_LIMITS.snapshotNodes) || !ids(effort.edgeIds, WORK_GRAPH_LIMITS.snapshotEdges) || !ids(effort.contextNodeIds, WORK_GRAPH_LIMITS.snapshotNodes)) { valid = false; break; }
    effortIds.add(effort.id);
    const members = new Set(effort.nodeIds);
    if (!members.has(effort.anchorNodeId) || !nodeById.has(effort.anchorNodeId) || !effort.nodeIds.every((key) => nodeById.has(key)) || !effort.contextNodeIds.every((key) => members.has(key)) || !effort.edgeIds.every((key) => { const edge = edgeById.get(key); return edge && members.has(edge.fromId) && members.has(edge.toId); })) valid = false;
  }
  if (new Set(snapshot.details.map((item) => item.nodeId)).size !== details.length) valid = false;
  if (snapshot.query.windowEnd > snapshot.temporal.observedAt || snapshot.temporal.coverage.through > snapshot.temporal.observedAt) valid = false;
  if (snapshot.temporal.mode === 'as-of' && snapshot.temporal.coverage.complete && (snapshot.temporal.coverage.from > snapshot.query.windowStart || snapshot.temporal.coverage.through < snapshot.query.windowEnd)) valid = false;
  // v1 entities accept ISO timestamps with or without milliseconds. Compare
  // instants, otherwise `...00Z` sorts after the equivalent `...00.000Z`.
  const cutoff = Date.parse(snapshot.query.windowEnd);
  if (snapshot.temporal.mode === 'as-of' && [...snapshot.nodes, ...snapshot.edges].some((entity) => [entity.updatedAt, entity.startedAt, entity.endedAt].some((at) => at !== undefined && Date.parse(at) > cutoff))) valid = false;
  const readable = (candidate: string | undefined): boolean => {
    const node = candidate === undefined ? undefined : nodeById.get(candidate);
    return !!node && !node.locked && node.disclosure !== 'existence';
  };
  for (const item of snapshot.details) {
    const node = nodeById.get(item.nodeId);
    if (!node || node.locked || node.disclosure === 'existence') valid = false;
    // A link may only name a node this same snapshot already disclosed. A
    // withheld neighbour is absent, never described by a label or a count.
    if ([...(item.inputs ?? []), ...(item.sources ?? []), ...(item.workItem ? [item.workItem] : [])]
      .some((entry) => entry.nodeId === item.nodeId || !readable(entry.nodeId))) valid = false;
    // Transcript content and tool lists are full-disclosure evidence.
    if (item.transcript && item.transcript.segments.length > 0 && node?.disclosure !== 'details') valid = false;
    if (item.transcript?.askEnabled && !node?.capabilities.includes('view-transcript')) valid = false;
    // A pause reason explains a waiting run; on anything else it would claim
    // a state the node's own status contradicts.
    if (item.pause && (!node || !['run', 'agent'].includes(node.kind) || node.status !== 'waiting')) valid = false;
    if (snapshot.temporal.mode === 'as-of'
      && item.transcript?.segments.some((entry) => entry.at > snapshot.query.windowEnd)) valid = false;
    if (snapshot.temporal.mode === 'as-of') {
      const end = snapshot.query.windowEnd;
      if (item.artifact?.revisions.some((revision) => revision.createdAt > end) || (item.artifact?.pending && item.artifact.pending.updatedAt > end) || (item.feedback && item.feedback.through > end) || (item.attention && item.attention.observedAt > end) || (item.freshness && item.freshness.observedAt > end)) valid = false;
    }
  }
  const operationIds = new Set<string>();
  for (const operation of snapshot.operations) {
    if (!exact(operation, ['edgeId', 'processNodeId', 'attemptId', 'observedAt', 'expiresAt']) || !id(operation.edgeId) || !id(operation.processNodeId) || !id(operation.attemptId) || !lease({ observedAt: operation.observedAt, expiresAt: operation.expiresAt })) { valid = false; break; }
    const process = nodeById.get(operation.processNodeId);
    const edge = edgeById.get(operation.edgeId);
    if (operationIds.has(operation.edgeId)) valid = false;
    operationIds.add(operation.edgeId);
    if (!process || process.locked || process.disclosure === 'existence' || !['run', 'agent', 'terminal'].includes(process.kind) || !edge || edge.disclosure === 'existence' || ![edge.fromId, edge.toId].includes(process.id) || (snapshot.temporal.mode === 'as-of' && operation.observedAt > snapshot.query.windowEnd)) valid = false;
  }
  const bucketTimes = new Set<string>();
  const day = workDayWindow(snapshot.query.day, snapshot.query.timezone);
  for (const bucket of eventBuckets) {
    if (!exact(bucket, ['at', 'count']) || !time(bucket.at) || !integer(bucket.count) || bucket.count === 0 || bucketTimes.has(bucket.at) || bucket.at < day.start || bucket.at >= day.end || bucket.at > snapshot.temporal.observedAt || (snapshot.temporal.mode === 'as-of' && bucket.at > snapshot.query.windowEnd)) { valid = false; break; }
    bucketTimes.add(bucket.at);
  }
  return result(valid, value, 'v2 work graph snapshot');
}

export function validateWorkReferenceV2(value: unknown): ValidationResult<WorkReferenceV2> {
  if (!exact(value, ['version', 'personId', 'day', 'timezone', 'target'], ['sessionId', 'eventId', 'observedAt']) || value.version !== 2 || !exact(value.target, ['kind', 'id'], ['revisionId', 'anchor']) || !bytes(value, WORK_GRAPH_LIMITS.referenceBytes)) return result(false, value, 'v2 work reference');
  const target = value.target;
  const valid = validateWorkReference({ ...value, version: 1, target: { kind: target.kind, id: target.id } }).ok
    && (target.kind === 'node' || (target.revisionId === undefined && target.anchor === undefined))
    && (target.revisionId === undefined || id(target.revisionId))
    && (target.anchor === undefined || (id(target.revisionId) && anchor(target.anchor)));
  return result(valid, value, 'v2 work reference');
}
