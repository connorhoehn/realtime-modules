/**
 * Dependency-free contracts for the Active now shared work graph.
 *
 * Source records are private service-to-service data. Viewer records are the
 * only shapes that may cross an HTTP or WebSocket boundary to a browser.
 * Hosts must obtain source authorization decisions before calling projection
 * helpers; this package never infers access from presence or source metadata.
 */

export const WORK_GRAPH_SCHEMA_VERSION = 1 as const;

export const WORK_GRAPH_LIMITS = {
  idLength: 128,
  /** Signed snapshot/replay cursors carry the bound query scope and HMAC. */
  cursorLength: 4_096,
  labelLength: 160,
  descriptionLength: 1_000,
  timezoneLength: 64,
  sourceEventBytes: 32 * 1024,
  referenceBytes: 2 * 1024,
  pageNodes: 100,
  pageEdges: 200,
  snapshotNodes: 250,
  snapshotEdges: 500,
  deltaOperations: 200,
  deltaBytes: 256 * 1024,
  replayBatches: 1_000,
  replayAgeMs: 15 * 60 * 1_000,
  heartbeatFreshMs: 45 * 1_000,
  heartbeatStaleMs: 5 * 60 * 1_000,
  eventRetentionDays: 30,
  minimumSharingMs: 5 * 60 * 1_000,
  maximumSharingMs: 24 * 60 * 60 * 1_000,
  maximumHistorySharingMs: 7 * 24 * 60 * 60 * 1_000,
  maximumCollaborationRequestMs: 24 * 60 * 60 * 1_000,
} as const;

export type WorkGraphSchemaVersion = typeof WORK_GRAPH_SCHEMA_VERSION;
export type OpaqueWorkId = string;
export type IsoTimestamp = string;
export type CalendarDate = string;
export type IanaTimezone = string;

export type WorkSourceKind =
  | 'cloud-compute'
  | 'local-compute'
  | 'document'
  | 'pipeline'
  | 'conversation'
  | 'meeting';

export type WorkNodeKind =
  | 'project'
  | 'terminal'
  | 'agent'
  | 'run'
  | 'document'
  | 'change'
  | 'conversation'
  | 'meeting'
  | 'transcript'
  | 'task';

export type WorkRelation =
  | 'works-on'
  | 'runs-in'
  | 'operates-on'
  | 'produced'
  | 'edited'
  | 'attended'
  | 'discussed'
  | 'derived-from';

/** Work state and sharing freshness are intentionally independent. */
export type WorkStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'stale';

export type WorkSourceHealth =
  | 'available'
  | 'delayed'
  | 'disconnected'
  | 'authorization-unavailable';

export type DisclosureLevel = 'existence' | 'summary' | 'details';
export type PolicyDecision = 'allow' | 'deny' | 'unavailable';

export type CollaborationCapability =
  | 'message'
  | 'view-document'
  | 'edit-document'
  | 'join-conversation'
  | 'join-meeting'
  | 'observe-terminal'
  | 'control-terminal'
  | 'view-transcript'
  | 'view-run'
  | 'dispatch-run';

export type CollaborationRequestState =
  | 'requested'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'revoked';

export interface WorkSourceRef {
  source: WorkSourceKind;
  /** Source-owner identifier. Never appears in a viewer DTO. */
  resourceId: string;
  resourceVersion?: string;
  /**
   * Optional precision inside the resource, named by the source itself. It
   * refines which part is meant; it never selects a different entity, and the
   * projection resolves nodes by source and resource alone.
   */
  anchor?: { kind: 'slide' | 'page' | 'block' | 'transcript-segment'; id: string };
}

export interface AuthenticatedWorkActor {
  /** Platform account established by a trusted server-side identity mapping. */
  actorId: string;
  organizationId: string;
  /** Authenticated subject in the producer's own identity system. */
  sourceSubject: string;
}

export interface AuthenticatedWorkProducer {
  serviceId: string;
  organizationId: string;
  /** Identifier of the verified service credential, not the secret itself. */
  credentialId: string;
}

export interface WorkEventBase {
  schemaVersion: WorkGraphSchemaVersion;
  eventId: string;
  idempotencyKey: string;
  source: WorkSourceKind;
  sourceSequence?: string;
  occurredAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
  actor: AuthenticatedWorkActor;
  producer: AuthenticatedWorkProducer;
  resource: WorkSourceRef;
}

export interface CloudComputePayload {
  kind: 'cloud-compute';
  lifecycle: 'created' | 'started' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'deleted';
  boxId: string;
  jobId?: string;
  agentId?: string;
  projectId?: string;
  attempt?: number;
  safeLabel?: string;
  /** Source-supplied project label. Absent means the generic placeholder. */
  projectLabel?: string;
  /**
   * The project's own context line, written by the source as
   * `"<where> · <what>"` (for example `"Gateway · Coverage checks"`). It
   * becomes the project node's description; nothing is parsed out of the
   * label itself.
   */
  projectContext?: string;
  /**
   * What the source says this session is currently doing, for example
   * `"Tests running"`. It is the box's own state line, not a status word
   * derived from its lifecycle.
   */
  sessionActivity?: string;
}

export interface LocalComputePayload {
  kind: 'local-compute';
  lifecycle: 'session-started' | 'session-ended' | 'job-started' | 'job-finished' | 'heartbeat' | 'disconnected';
  machineId: string;
  sessionId?: string;
  jobId?: string;
  projectId?: string;
  heartbeatAt?: IsoTimestamp;
  safeLabel?: string;
}

export interface DocumentPayload {
  kind: 'document';
  lifecycle: 'revision-saved' | 'deleted';
  documentId: string;
  revisionId: string;
  /** Present only when the authoritative save record attributes an actor. */
  attributedActorId?: string;
  producedByRunId?: string;
  safeLabel?: string;
}

export interface PipelinePayload {
  kind: 'pipeline';
  lifecycle: 'started' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  pipelineId: string;
  runId: string;
  attempt: number;
  artifactIds?: string[];
  safeLabel?: string;
  /** Source-declared inputs this run consumed. Never inferred by the reducer. */
  inputs?: WorkSourceRef[];
  /**
   * The process this run is executing in — a cloud workspace, a session — as
   * the source that opened it names it. It projects a `terminal` node and a
   * `runs-in` relationship, which is what lets a running run be reported as a
   * live operation rather than as a node carrying a status word. Several runs
   * or steps sharing one workspace share its node, because they really are in
   * the same place.
   */
  workspace?: { resourceId: string; safeLabel?: string };
  /**
   * What this run is producing, named by the source itself rather than
   * discovered. Like `inputs`, the relationship is dropped unless the named
   * resource has already been projected, so a run can never conjure the
   * artifact it claims to be writing.
   */
  produces?: WorkSourceRef[];
}

export interface ConversationPayload {
  kind: 'conversation';
  lifecycle: 'contributed' | 'membership-added' | 'membership-removed';
  conversationId: string;
  conversationKind: 'dm' | 'channel';
  explicitRelatedResource?: WorkSourceRef;
  safeLabel?: string;
}

export interface MeetingPayload {
  kind: 'meeting';
  lifecycle:
    /** The room exists and is expected; nobody has arrived yet. */
    | 'meeting-scheduled'
    | 'attendance-started'
    | 'attendance-ended'
    | 'recording-started'
    | 'recording-ready'
    | 'recording-failed'
    | 'recording-deleted'
    | 'transcript-ready'
    | 'transcript-failed'
    | 'transcript-deleted';
  meetingId: string;
  recordingId?: string;
  transcriptId?: string;
  recordingOwnerId?: string;
  safeLabel?: string;
}

export type WorkSourcePayload =
  | CloudComputePayload
  | LocalComputePayload
  | DocumentPayload
  | PipelinePayload
  | ConversationPayload
  | MeetingPayload;

export type AuthenticatedWorkEvent = WorkEventBase & { payload: WorkSourcePayload };

export interface InternalWorkSession {
  id: OpaqueWorkId;
  organizationId: string;
  actorId: string;
  source: WorkSourceKind;
  timezone: IanaTimezone;
  startedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt?: IsoTimestamp;
  revision: number;
}

export interface InternalWorkNode {
  id: OpaqueWorkId;
  organizationId: string;
  actorId: string;
  sessionId?: OpaqueWorkId;
  kind: WorkNodeKind;
  sourceRef: WorkSourceRef;
  policyRef: string;
  title: string;
  description?: string;
  status: WorkStatus;
  startedAt?: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt?: IsoTimestamp;
  sourceEventId: string;
  sourceSequence?: string;
  deletedAt?: IsoTimestamp;
  revision: number;
}

export interface InternalWorkEdge {
  id: OpaqueWorkId;
  organizationId: string;
  actorId: string;
  fromId: OpaqueWorkId;
  toId: OpaqueWorkId;
  relation: WorkRelation;
  policyRef: string;
  label?: string;
  status: WorkStatus;
  startedAt?: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt?: IsoTimestamp;
  sourceEventId: string;
  sourceSequence?: string;
  provenance: 'source-event' | 'user-confirmed';
  deletedAt?: IsoTimestamp;
  revision: number;
}

export interface WorkProjectionState {
  schemaVersion: WorkGraphSchemaVersion;
  organizationId: string;
  actorId: string;
  revision: number;
  sessions: Record<OpaqueWorkId, InternalWorkSession>;
  nodes: Record<OpaqueWorkId, InternalWorkNode>;
  edges: Record<OpaqueWorkId, InternalWorkEdge>;
  sourceCheckpoints: Partial<Record<WorkSourceKind, string>>;
  appliedEventIds: string[];
}

export type SharingAudience =
  | { kind: 'people'; personIds: string[] }
  | { kind: 'conversation'; conversationIds: string[] }
  | { kind: 'organization' };

export interface SharingSelection {
  nodeIds: OpaqueWorkId[];
  edgeIds: OpaqueWorkId[];
  disclosure: DisclosureLevel;
}

export type SharingGrantState = 'active' | 'paused' | 'stopped' | 'expired';

export interface WorkSharingGrant {
  schemaVersion: WorkGraphSchemaVersion;
  id: OpaqueWorkId;
  organizationId: string;
  ownerId: string;
  audience: SharingAudience;
  selection: SharingSelection;
  state: SharingGrantState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  revision: number;
  /** Separate, explicit grant. Stopping this grant never creates one. */
  historyGrantId?: OpaqueWorkId;
}

export interface WorkHistoryGrant extends Omit<WorkSharingGrant, 'historyGrantId'> {
  dayFrom: CalendarDate;
  dayThrough: CalendarDate;
}

export interface ViewerWorkNode {
  id: OpaqueWorkId;
  kind: WorkNodeKind;
  title: string;
  description?: string;
  status: WorkStatus;
  disclosure: DisclosureLevel;
  startedAt?: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt?: IsoTimestamp;
  capabilities: CollaborationCapability[];
  locked?: boolean;
}

export interface ViewerWorkEdge {
  id: OpaqueWorkId;
  fromId: OpaqueWorkId;
  toId: OpaqueWorkId;
  relation: WorkRelation;
  label?: string;
  status: WorkStatus;
  disclosure: DisclosureLevel;
  startedAt?: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt?: IsoTimestamp;
  capabilities: CollaborationCapability[];
}

export interface WorkSourceStatus {
  source: WorkSourceKind;
  health: WorkSourceHealth;
  checkedAt: IsoTimestamp;
  message?: string;
}

export interface WorkGraphQueryScope {
  organizationId: string;
  viewerId: string;
  personId: string;
  day: CalendarDate;
  timezone: IanaTimezone;
  policyRevision: string;
}

/** Opaque encoded cursors carry these server-verified claims. */
export interface WorkGraphCursorClaims extends WorkGraphQueryScope {
  schemaVersion: WorkGraphSchemaVersion;
  watermark: number;
  pageOffset?: string;
  subscriptionGeneration: string;
  issuedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
}

export interface WorkGraphSnapshot {
  schemaVersion: WorkGraphSchemaVersion;
  scope: Omit<WorkGraphQueryScope, 'organizationId' | 'viewerId'>;
  revision: number;
  watermark: number;
  cursor: string;
  nodes: ViewerWorkNode[];
  edges: ViewerWorkEdge[];
  sources: WorkSourceStatus[];
  nextPageCursor?: string;
  partial: boolean;
}

export type WorkGraphDeltaOperation =
  | { kind: 'upsert-node'; node: ViewerWorkNode }
  | { kind: 'remove-node'; nodeId: OpaqueWorkId }
  | { kind: 'upsert-edge'; edge: ViewerWorkEdge }
  | { kind: 'remove-edge'; edgeId: OpaqueWorkId }
  | { kind: 'source-health'; source: WorkSourceStatus };

export interface WorkGraphDeltaBatch {
  schemaVersion: WorkGraphSchemaVersion;
  subscriptionGeneration: string;
  previousWatermark: number;
  watermark: number;
  cursor: string;
  policyRevision: string;
  operations: WorkGraphDeltaOperation[];
}

export type WorkGraphStreamMessage =
  | { kind: 'delta'; batch: WorkGraphDeltaBatch }
  | { kind: 'invalidate'; subscriptionGeneration: string; reason: 'policy-changed' | 'sharing-paused' | 'sharing-stopped' | 'sharing-expired' | 'cursor-expired' | 'source-authorization-unavailable' }
  | { kind: 'reset-required'; subscriptionGeneration: string; reason: 'gap' | 'replay-unavailable' | 'scope-changed' };

export type WorkReferenceTarget =
  | { kind: 'node'; id: OpaqueWorkId }
  | { kind: 'edge'; id: OpaqueWorkId };

export interface WorkReference {
  version: WorkGraphSchemaVersion;
  personId: string;
  day: CalendarDate;
  timezone: IanaTimezone;
  sessionId?: OpaqueWorkId;
  target: WorkReferenceTarget;
  eventId?: string;
  observedAt?: IsoTimestamp;
}

export interface WorkReferenceResolution {
  reference: WorkReference;
  state: 'available' | 'unavailable';
  node?: ViewerWorkNode;
  edge?: ViewerWorkEdge;
}

export interface CollaborationRequest {
  schemaVersion: WorkGraphSchemaVersion;
  id: OpaqueWorkId;
  organizationId: string;
  requesterId: string;
  ownerId: string;
  target: WorkReferenceTarget;
  capability: CollaborationCapability;
  state: CollaborationRequestState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  revision: number;
}

export interface DisclosureDecision {
  targetId: OpaqueWorkId;
  decision: PolicyDecision;
  maximumDisclosure?: DisclosureLevel;
  capabilities?: CollaborationCapability[];
  /** Optional sanitized placeholder. It must not contain a source/private ID. */
  existenceLabel?: string;
  policyRevision: string;
}

export interface WorkGraphPolicyInput {
  scope: WorkGraphQueryScope;
  grant: WorkSharingGrant | WorkHistoryGrant;
  nodeDecisions: ReadonlyMap<OpaqueWorkId, DisclosureDecision>;
  edgeDecisions: ReadonlyMap<OpaqueWorkId, DisclosureDecision>;
}

export interface WorkGraphRepository {
  loadProjection(organizationId: string, actorId: string, day: CalendarDate): Promise<WorkProjectionState | null>;
  /** Atomically commits graph mutations, source checkpoint, and event dedupe. */
  commitEvent(event: AuthenticatedWorkEvent, expectedRevision: number): Promise<WorkProjectionState>;
  eraseActorDay(organizationId: string, actorId: string, day: CalendarDate, expectedRevision: number): Promise<void>;
}

export interface WorkSharingRepository {
  getGrant(organizationId: string, grantId: OpaqueWorkId, now: IsoTimestamp): Promise<WorkSharingGrant | WorkHistoryGrant | null>;
  listEffectiveGrants(
    organizationId: string,
    ownerId: string,
    viewer: WorkSharingViewerContext,
    now: IsoTimestamp,
  ): Promise<Array<WorkSharingGrant | WorkHistoryGrant>>;
  putGrant(
    grant: WorkSharingGrant | WorkHistoryGrant,
    expectedRevision: number | null,
  ): Promise<WorkSharingGrant | WorkHistoryGrant>;
}

/** Server-resolved audience memberships; browsers cannot assert these IDs. */
export interface WorkSharingViewerContext {
  viewerId: string;
  conversationIds: string[];
}

export interface WorkSourceAuthorizationAdapter {
  readonly source: WorkSourceKind;
  authorizeDisclosure(scope: WorkGraphQueryScope, refs: WorkSourceRef[]): Promise<Map<string, DisclosureDecision>>;
  authorizeCapability(scope: WorkGraphQueryScope, ref: WorkSourceRef, capability: CollaborationCapability): Promise<PolicyDecision>;
}

export interface WorkSourceAdapter<TRecord = unknown> {
  readonly source: WorkSourceKind;
  map(record: TRecord, producer: AuthenticatedWorkProducer, receivedAt: IsoTimestamp): AuthenticatedWorkEvent | { unsupported: true; reason: string };
}

export interface WorkGraphPeopleSummary {
  personId: string;
  sharing: 'active' | 'historical';
  fresh: boolean;
  updatedAt: IsoTimestamp;
  /** Counts are deliberately absent: hidden activity must not affect the rail. */
}

export interface WorkGraphUnavailable {
  error: 'WORK_GRAPH_UNAVAILABLE';
  /** Same response for missing, denied, deleted, stopped, and revoked targets. */
  message: 'This work item is unavailable.';
}

export interface CreateSharingGrantRequest {
  audience: SharingAudience;
  selection: SharingSelection;
  expiresAt: IsoTimestamp;
  history?: { dayFrom: CalendarDate; dayThrough: CalendarDate; expiresAt: IsoTimestamp };
}

export interface UpdateSharingGrantRequest {
  expectedRevision: number;
  action?: 'pause' | 'resume' | 'stop';
  audience?: SharingAudience;
  selection?: SharingSelection;
  expiresAt?: IsoTimestamp;
}

export interface CreateCollaborationRequest {
  target: WorkReferenceTarget;
  capability: CollaborationCapability;
  expiresAt: IsoTimestamp;
}

export interface ResolveReferencesRequest {
  references: WorkReference[];
}

export interface WorkGraphSubscriptionRequest {
  personId: string;
  day: CalendarDate;
  timezone: IanaTimezone;
  cursor: string;
}
