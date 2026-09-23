import type { WorkGraphSnapshotV2 } from './contractsV2';

/**
 * The activity view a v2 stream frame carries beside its graph operations.
 * Every one of these fields is the viewer-scoped, already-authorized output
 * of the platform; a patch only restates which of them moved.
 */
export type WorkGraphStreamViewV2 = Pick<
  WorkGraphSnapshotV2,
  'query' | 'temporal' | 'efforts' | 'details' | 'operations' | 'eventBuckets'
>;

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

const effortKey = (entry: { id: string }) => entry.id;
const detailKey = (entry: { nodeId: string }) => entry.nodeId;
const bucketKey = (entry: { at: string }) => entry.at;

function applyList<T>(base: readonly T[], patch: WorkGraphListPatch<T> | undefined, key: (entry: T) => string): T[] | null {
  if (!patch) return [...base];
  if (!Array.isArray(patch.upsert) || !Array.isArray(patch.remove)) return null;
  const removed = new Set(patch.remove);
  const result = base.filter((entry) => !removed.has(key(entry)));
  const index = new Map(result.map((entry, position) => [key(entry), position]));
  for (const entry of patch.upsert) {
    if (entry === null || typeof entry !== 'object') return null;
    const id = key(entry);
    if (typeof id !== 'string') return null;
    const position = index.get(id);
    if (position === undefined) {
      index.set(id, result.length);
      result.push(entry);
    } else {
      result[position] = entry;
    }
  }
  if (patch.order === undefined) return result;
  if (!Array.isArray(patch.order) || patch.order.length !== result.length) return null;
  const used = new Set<number>();
  const ordered: T[] = [];
  for (const position of patch.order) {
    if (!Number.isInteger(position) || position < 0 || position >= result.length || used.has(position)) return null;
    used.add(position);
    ordered.push(result[position]!);
  }
  return ordered;
}

function diffList<T>(base: readonly T[], next: readonly T[], key: (entry: T) => string): WorkGraphListPatch<T> | undefined {
  const before = new Map(base.map((entry) => [key(entry), JSON.stringify(entry)]));
  const nextIds = new Set(next.map(key));
  const remove = [...before.keys()].filter((id) => !nextIds.has(id));
  const upsert = next.filter((entry) => before.get(key(entry)) !== JSON.stringify(entry));
  if (remove.length === 0 && upsert.length === 0 && base.every((entry, i) => key(entry) === key(next[i]!))) {
    return undefined;
  }
  const patch: WorkGraphListPatch<T> = { upsert, remove };
  const applied = applyList(base, patch, key) ?? [];
  if (applied.length !== next.length || applied.some((entry, i) => key(entry) !== key(next[i]!))) {
    const position = new Map(applied.map((entry, i) => [key(entry), i]));
    patch.order = next.map((entry) => position.get(key(entry))!);
  }
  return patch;
}

/** The smallest keyed patch that turns `base` into `next`. */
export function diffWorkGraphViewV2(
  base: WorkGraphStreamViewV2,
  next: WorkGraphStreamViewV2,
  baseWatermark: number,
): WorkGraphViewPatchV2 {
  const efforts = diffList(base.efforts, next.efforts, effortKey);
  const details = diffList(base.details, next.details, detailKey);
  const eventBuckets = diffList(base.eventBuckets, next.eventBuckets, bucketKey);
  return {
    baseWatermark,
    query: next.query,
    temporal: next.temporal,
    operations: next.operations,
    ...(eventBuckets ? { eventBuckets } : {}),
    ...(efforts ? { efforts } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * Rebuilds the full view, or null when the patch does not fit `base` (wrong
 * shape, an order that is not a permutation of the result). The caller then
 * resyncs from a snapshot; the result still goes through the same validator
 * a full view does.
 */
export function applyWorkGraphViewPatchV2(
  base: WorkGraphStreamViewV2,
  patch: WorkGraphViewPatchV2,
): WorkGraphStreamViewV2 | null {
  if (patch === null || typeof patch !== 'object') return null;
  const efforts = applyList(base.efforts, patch.efforts, effortKey);
  const details = applyList(base.details, patch.details, detailKey);
  const eventBuckets = applyList(base.eventBuckets, patch.eventBuckets, bucketKey);
  if (!efforts || !details || !eventBuckets) return null;
  return {
    query: patch.query,
    temporal: patch.temporal,
    efforts,
    details,
    operations: patch.operations,
    eventBuckets,
  };
}
