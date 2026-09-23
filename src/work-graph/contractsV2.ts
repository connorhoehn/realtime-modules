import type { WorkGraphQueryScope, WorkGraphSnapshot, WorkReference, WorkReferenceTarget } from './contracts';

/** Opt-in readers precede v2 producers. Existing v1 contracts remain exact. */
export const WORK_GRAPH_SCHEMA_VERSION_V2 = 2 as const;
export const WORK_GRAPH_V2_LIMITS = { efforts: 50, revisions: 100, anchors: 200, tools: 16, eventBuckets: 1500, detailLines: 4, links: 16, participants: 12, transcriptSegments: 500, snapshotBytes: 1024 * 1024 } as const;

export interface WorkGraphQueryV2 {
  schemaVersion: 2;
  personId: string;
  day: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  mode: 'live' | 'as-of';
}

export interface ViewerWorkEffort {
  id: string;
  /** Authorized anchor, never a hidden source's title or identifier. */
  anchorNodeId: string;
  title: string;
  /** Authorized state line. Derived from disclosed members, never a source label. */
  subtitle?: string;
  nodeIds: string[];
  edgeIds: string[];
  contextNodeIds: string[];
}

export interface WorkArtifactAnchor {
  kind: 'slide' | 'page' | 'block' | 'transcript-segment';
  id: string;
}

/**
 * A pointer to another node in the same snapshot. It carries no source id and
 * no URL: an unauthorized neighbour is removed rather than described.
 */
export interface ViewerWorkNodeLink {
  nodeId: string;
  label: string;
  meta?: string;
}

/** A person the viewer is already allowed to see on this entity. */
export interface ViewerWorkParticipant {
  id: string;
  label: string;
  avatarUrl?: string;
}

/** Disclosed only at `details`; a summary-level transcript has no content. */
export interface ViewerTranscriptSegment {
  id: string;
  at: string;
  speaker: string;
  text: string;
}

export interface ViewerArtifactRevision {
  id: string;
  label: string;
  createdAt: string;
  /** Opaque action handle. No source URL, storage key, or bearer credential. */
  previewHandle?: string;
  anchors?: Array<WorkArtifactAnchor & { label: string; index?: number }>;
}

export interface ViewerWorkActivityDetail {
  nodeId: string;
  /** One authorized state line for the node body. */
  summary?: string;
  /** Additional authorized body lines, already filtered for this viewer. */
  lines?: string[];
  /** A short state pill, for example `Ready` or `Tests running`. */
  badge?: string;
  /** A quoted line taken verbatim from the entity's own content. */
  excerpt?: string;
  /** The card's bottom line, for example `First draft · 09:27` and `Shared`. */
  footer?: { label: string; note?: string };
  /** Attendees the viewer may already see. Never a count of hidden people. */
  participants?: ViewerWorkParticipant[];
  /** Authorized upstream evidence a process consumed. */
  inputs?: ViewerWorkNodeLink[];
  /** Authorized provenance behind an artifact revision set. */
  sources?: ViewerWorkNodeLink[];
  /** The authorized work item a session or terminal is attached to. */
  workItem?: ViewerWorkNodeLink;
  /** `askEnabled` reflects a held capability, never a UI preference. */
  transcript?: { segments: ViewerTranscriptSegment[]; askEnabled: boolean };
  /** A source lease does not change the process lifecycle or human presence. */
  freshness?: { observedAt: string; expiresAt: string };
  tools?: string[];
  attention?: { kind: 'reviewing'; observedAt: string; expiresAt: string; revisionId?: string };
  artifact?: {
    mediaKind: 'presentation' | 'document' | 'image';
    /** Total addressable units in the newest available revision. */
    pageCount?: number;
    /**
     * The newest revision's own heading (a deck's title slide), sent only
     * when it differs from the node's title — "Titled “Audit E2E”" under a
     * document named `audit-e2e-1790150600`. Plain text, ≤ labelLength.
     */
    heading?: string;
    revisions: ViewerArtifactRevision[];
    /** `message` is a sanitized source failure summary, never a stack or path. */
    pending?: { revisionId: string; attemptId: string; label: string; status: 'generating' | 'failed'; startedAt: string; updatedAt: string; message?: string };
  };
  /** Count only messages visible to this viewer at the query cutoff. */
  feedback?: { count: number; through: string };
  /**
   * Why a `waiting` run is waiting (NFR #126): an approval gate or a
   * breakpoint. `step` is the step's display label (the breakpoint's step, or
   * the approval step), never an internal key the viewer could not read
   * elsewhere. Only on a run/agent node whose status is `waiting`; a run that
   * resumed carries none.
   */
  pause?: WorkRunPause;
}

export type WorkRunPauseReason = 'awaiting_approval' | 'paused_at_breakpoint';

export interface WorkRunPause {
  reason: WorkRunPauseReason;
  step?: string;
}

export interface ViewerWorkOperation {
  edgeId: string;
  processNodeId: string;
  attemptId: string;
  observedAt: string;
  expiresAt: string;
}

export interface WorkGraphSnapshotV2 extends Omit<WorkGraphSnapshot, 'schemaVersion'> {
  schemaVersion: 2;
  query: WorkGraphQueryV2;
  temporal: {
    /** `recent` is the honest fallback when exact reconstruction is unavailable. */
    mode: 'live' | 'as-of' | 'recent';
    observedAt: string;
    coverage: { from: string; through: string; complete: boolean };
  };
  efforts: ViewerWorkEffort[];
  details: ViewerWorkActivityDetail[];
  operations: ViewerWorkOperation[];
  eventBuckets: Array<{ at: string; count: number }>;
  /**
   * NFR #85: present only when the request asked `viewBase=1`. Names this
   * snapshot's view (query, temporal, efforts, details, operations,
   * eventBuckets) for the gateway, which patches the stream's first frame
   * against it once it has proven it. Opaque to the reader.
   */
  viewHash?: string;
}

/** Server-private claims, signed and bound to the complete authorized query. */
export interface WorkGraphCursorClaimsV2 extends WorkGraphQueryScope {
  schemaVersion: 2;
  query: WorkGraphQueryV2;
  partitions: Array<{ utcDay: string; watermark: number }>;
  observationWatermark: number;
  pageOffset?: string;
  subscriptionGeneration: string;
  issuedAt: string;
  expiresAt: string;
}

export type WorkReferenceTargetV2 =
  | Extract<WorkReferenceTarget, { kind: 'edge' }>
  | { kind: 'node'; id: string; revisionId?: string; anchor?: WorkArtifactAnchor };

export interface WorkReferenceV2 extends Omit<WorkReference, 'version' | 'target'> {
  version: 2;
  target: WorkReferenceTargetV2;
}

export type AnyWorkReference = WorkReference | WorkReferenceV2;
