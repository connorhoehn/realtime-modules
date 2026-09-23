import type { WorkGraphSnapshotV2 } from './contractsV2';
/**
 * The activity view a v2 stream frame carries beside its graph operations.
 * Every one of these fields is the viewer-scoped, already-authorized output
 * of the platform; a patch only restates which of them moved.
 */
export type WorkGraphStreamViewV2 = Pick<WorkGraphSnapshotV2, 'query' | 'temporal' | 'efforts' | 'details' | 'operations' | 'eventBuckets'>;
/** A keyed-list change: new or changed entries, removed ids, and the order when it moved. */
export interface WorkGraphListPatch<T> {
    upsert: T[];
    remove: string[];
    /**
     * Present only when applying upsert/remove would leave the entries in a
     * different order: position i of the result is entry `order[i]` of the list
     * upsert/remove produced. Indices, not ids — an edited detail moving to the
     * top reorders ~60 entries, and 60 ids are ~4.5 KB where 60 indices are ~0.2 KB.
     */
    order?: number[];
}
/**
 * NFR #66. A delta frame used to carry the whole view (~70 KB on a busy day)
 * although an ordinary change moves one or two details. The gateway sends
 * this instead to a client that declared `viewPatch: 1` on subscribe, once it
 * has sent that subscription a full view to patch against.
 *
 * `baseWatermark` is the watermark of the stream frame whose view this patch
 * applies to. A reader holding any other view must resync from a snapshot,
 * never guess. The small fields (query, temporal window, leases) travel
 * whole.
 */
export interface WorkGraphViewPatchV2 {
    baseWatermark: number;
    query: WorkGraphStreamViewV2['query'];
    temporal: WorkGraphStreamViewV2['temporal'];
    operations: WorkGraphStreamViewV2['operations'];
    /** Keyed by `at`: an ordinary change bumps one bucket's count. */
    eventBuckets?: WorkGraphListPatch<WorkGraphStreamViewV2['eventBuckets'][number]>;
    efforts?: WorkGraphListPatch<WorkGraphStreamViewV2['efforts'][number]>;
    details?: WorkGraphListPatch<WorkGraphStreamViewV2['details'][number]>;
}
/** The smallest keyed patch that turns `base` into `next`. */
export declare function diffWorkGraphViewV2(base: WorkGraphStreamViewV2, next: WorkGraphStreamViewV2, baseWatermark: number): WorkGraphViewPatchV2;
/**
 * Rebuilds the full view, or null when the patch does not fit `base` (wrong
 * shape, an order that is not a permutation of the result). The caller then
 * resyncs from a snapshot; the result still goes through the same validator
 * a full view does.
 */
export declare function applyWorkGraphViewPatchV2(base: WorkGraphStreamViewV2, patch: WorkGraphViewPatchV2): WorkGraphStreamViewV2 | null;
//# sourceMappingURL=viewPatch.d.ts.map