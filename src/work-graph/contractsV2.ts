import type { WorkGraphQueryScope, WorkGraphSnapshot, WorkReference, WorkReferenceTarget } from './contracts';

/** Opt-in readers precede v2 producers. Existing v1 contracts remain exact. */
export const WORK_GRAPH_SCHEMA_VERSION_V2 = 2 as const;
export const WORK_GRAPH_V2_LIMITS = { efforts: 50, revisions: 100, anchors: 200, tools: 16, eventBuckets: 1500, detailLines: 4, snapshotBytes: 1024 * 1024 } as const;

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

export interface ViewerArtifactRevision {
  id: string;
  label: string;
  createdAt: string;
  /** Opaque action handle. No source URL, storage key, or bearer credential. */
  previewHandle?: string;
  anchors?: Array<WorkArtifactAnchor & { label: string }>;
}

export interface ViewerWorkActivityDetail {
  nodeId: string;
  /** One authorized state line for the node body. */
  summary?: string;
  /** Additional authorized body lines, already filtered for this viewer. */
  lines?: string[];
  /** A source lease does not change the process lifecycle or human presence. */
  freshness?: { observedAt: string; expiresAt: string };
  tools?: string[];
  attention?: { kind: 'reviewing'; observedAt: string; expiresAt: string; revisionId?: string };
  artifact?: {
    mediaKind: 'presentation' | 'document' | 'image';
    revisions: ViewerArtifactRevision[];
    pending?: { revisionId: string; attemptId: string; label: string; status: 'generating' | 'failed'; startedAt: string; updatedAt: string };
  };
  /** Count only messages visible to this viewer at the query cutoff. */
  feedback?: { count: number; through: string };
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
