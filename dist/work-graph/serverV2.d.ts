import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphSnapshot, WorkNodeKind } from './contracts';
import type { ViewerWorkActivityDetail, ViewerWorkEffort, ViewerWorkOperation, WorkGraphQueryV2, WorkGraphSnapshotV2 } from './contractsV2';
import type { ValidationResult } from './validation';
/**
 * The reader-side v2 additions to a v1 snapshot. Hosts assemble this from
 * already-authorized data; nothing here re-derives an access decision.
 */
export type WorkGraphActivityV2 = Pick<WorkGraphSnapshotV2, 'temporal' | 'efforts' | 'details' | 'operations' | 'eventBuckets'>;
/** Anchors are real work containers, never "the same person on the same day". */
export declare const WORK_EFFORT_ANCHOR_KINDS: readonly WorkNodeKind[];
export interface DeriveWorkEffortsInput {
    nodes: readonly ViewerWorkNode[];
    edges: readonly ViewerWorkEdge[];
    /** Overrides the default anchor kinds; order does not affect the result. */
    anchorKinds?: readonly WorkNodeKind[];
    /** Members last updated before this instant are reported as folded context. */
    contextBefore?: string;
    /** Stable per-effort presentation line, computed by the host from its own authorized detail. */
    subtitleFor?: (effort: Omit<ViewerWorkEffort, 'subtitle'>) => string | undefined;
}
/**
 * Groups an authorized graph into efforts by walking the relationships the
 * sources actually declared, starting from anchor nodes. Nodes reachable from
 * no anchor are deliberately left ungrouped rather than merged on a heuristic,
 * and each node belongs to at most one effort so membership stays unambiguous.
 */
export declare function deriveWorkEfforts(input: DeriveWorkEffortsInput): ViewerWorkEffort[];
export interface BuildWorkGraphSnapshotV2Input {
    /** An already-authorized v1 snapshot for the same scope. */
    snapshot: WorkGraphSnapshot;
    query: WorkGraphQueryV2;
    activity: WorkGraphActivityV2;
}
/**
 * Assembles and strictly validates a v2 snapshot. A host that cannot satisfy
 * the v2 invariants gets an error instead of a snapshot: the reader contract
 * is never relaxed to let partially derived activity through.
 */
export declare function buildWorkGraphSnapshotV2(input: BuildWorkGraphSnapshotV2Input): ValidationResult<WorkGraphSnapshotV2>;
export interface WorkEventBucketInput {
    at: string;
    count?: number;
}
/**
 * Buckets observation instants across the query's real local day. Bounds come
 * from the IANA calendar day, so a DST transition shortens or lengthens the
 * day instead of silently dropping or duplicating an hour.
 */
export declare function bucketWorkEvents(query: Pick<WorkGraphQueryV2, 'day' | 'timezone'>, observations: readonly WorkEventBucketInput[], options?: {
    bucketMs?: number;
    observedAt?: string;
}): Array<{
    at: string;
    count: number;
}>;
/**
 * Keeps only operations whose lease is still open at `now`. A lease is source
 * evidence that a process was observed running; it is not a lifecycle flag and
 * never outlives its own expiry.
 */
export declare function freshWorkOperations(operations: readonly ViewerWorkOperation[], now: string): ViewerWorkOperation[];
/** Details may only describe nodes the viewer sees at full `details` disclosure. */
export declare function detailsForDisclosedNodes(nodes: readonly ViewerWorkNode[], details: readonly ViewerWorkActivityDetail[]): ViewerWorkActivityDetail[];
//# sourceMappingURL=serverV2.d.ts.map