import type {
  ViewerWorkEdge,
  ViewerWorkNode,
  WorkGraphSnapshot,
  WorkNodeKind,
} from './contracts';
import type {
  ViewerWorkActivityDetail,
  ViewerWorkEffort,
  ViewerWorkOperation,
  WorkGraphQueryV2,
  WorkGraphSnapshotV2,
} from './contractsV2';
import { WORK_GRAPH_V2_LIMITS } from './contractsV2';
import { workDayWindow } from './dayWindow';
import { validateWorkGraphSnapshotV2 } from './validationV2';
import type { ValidationResult } from './validation';

/**
 * The reader-side v2 additions to a v1 snapshot. Hosts assemble this from
 * already-authorized data; nothing here re-derives an access decision.
 */
export type WorkGraphActivityV2 = Pick<
  WorkGraphSnapshotV2,
  'temporal' | 'efforts' | 'details' | 'operations' | 'eventBuckets'
>;

/** Anchors are real work containers, never "the same person on the same day". */
export const WORK_EFFORT_ANCHOR_KINDS: readonly WorkNodeKind[] = ['project', 'task', 'meeting'];

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

function effortId(anchorNodeId: string): string {
  return `effort.${anchorNodeId}`;
}

function instant(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Groups an authorized graph into efforts by walking the relationships the
 * sources actually declared, starting from anchor nodes. Nodes reachable from
 * no anchor are deliberately left ungrouped rather than merged on a heuristic,
 * and each node belongs to at most one effort so membership stays unambiguous.
 */
export function deriveWorkEfforts(input: DeriveWorkEffortsInput): ViewerWorkEffort[] {
  const anchorKinds = new Set(input.anchorKinds ?? WORK_EFFORT_ANCHOR_KINDS);
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const edges = input.edges.filter((edge) => nodeById.has(edge.fromId) && nodeById.has(edge.toId));

  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    neighbours.set(edge.fromId, [...(neighbours.get(edge.fromId) ?? []), edge.toId]);
    neighbours.set(edge.toId, [...(neighbours.get(edge.toId) ?? []), edge.fromId]);
  }

  // Newest anchor first, with the id as a deterministic tie-break, so effort
  // order is stable across polls that do not change the underlying graph.
  const anchors = input.nodes
    .filter((node) => anchorKinds.has(node.kind))
    .sort((left, right) => instant(right.updatedAt) - instant(left.updatedAt) || left.id.localeCompare(right.id));

  const claimed = new Set<string>();
  const efforts: ViewerWorkEffort[] = [];
  for (const anchor of anchors) {
    if (claimed.has(anchor.id) || efforts.length >= WORK_GRAPH_V2_LIMITS.efforts) continue;
    const members: string[] = [];
    const queue = [anchor.id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (claimed.has(current)) continue;
      claimed.add(current);
      members.push(current);
      for (const next of neighbours.get(current) ?? []) {
        if (!claimed.has(next)) queue.push(next);
      }
    }
    const memberSet = new Set(members);
    const edgeIds = edges
      .filter((edge) => memberSet.has(edge.fromId) && memberSet.has(edge.toId))
      .map((edge) => edge.id);

    // The effort is named by the newest outcome the viewer may actually see,
    // falling back to the anchor. A withheld member can never supply a title.
    const outcome = members
      .map((id) => nodeById.get(id) as ViewerWorkNode)
      .filter((node) => node.kind === 'document' && node.disclosure !== 'existence' && !node.locked)
      .sort((left, right) => instant(right.updatedAt) - instant(left.updatedAt) || left.id.localeCompare(right.id))[0];
    const title = (outcome ?? anchor).title;

    const contextNodeIds = input.contextBefore === undefined
      ? []
      : members.filter((id) => id !== anchor.id
        && instant(nodeById.get(id)?.updatedAt) < instant(input.contextBefore));

    const effort: Omit<ViewerWorkEffort, 'subtitle'> = {
      id: effortId(anchor.id),
      anchorNodeId: anchor.id,
      title,
      nodeIds: members,
      edgeIds: [...new Set(edgeIds)],
      contextNodeIds,
    };
    const subtitle = input.subtitleFor?.(effort)?.trim();
    efforts.push(subtitle ? { ...effort, subtitle } : effort);
  }
  return efforts;
}

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
export function buildWorkGraphSnapshotV2(
  input: BuildWorkGraphSnapshotV2Input,
): ValidationResult<WorkGraphSnapshotV2> {
  const { schemaVersion: _ignored, ...base } = input.snapshot;
  const candidate = {
    ...base,
    schemaVersion: 2,
    query: input.query,
    temporal: input.activity.temporal,
    efforts: input.activity.efforts,
    details: input.activity.details,
    operations: input.activity.operations,
    eventBuckets: input.activity.eventBuckets,
  };
  return validateWorkGraphSnapshotV2(candidate);
}

export interface WorkEventBucketInput {
  at: string;
  count?: number;
}

/**
 * Buckets observation instants across the query's real local day. Bounds come
 * from the IANA calendar day, so a DST transition shortens or lengthens the
 * day instead of silently dropping or duplicating an hour.
 */
export function bucketWorkEvents(
  query: Pick<WorkGraphQueryV2, 'day' | 'timezone'>,
  observations: readonly WorkEventBucketInput[],
  options: { bucketMs?: number; observedAt?: string } = {},
): Array<{ at: string; count: number }> {
  const bucketMs = options.bucketMs ?? 60_000;
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) throw new RangeError('bucketMs must be a positive integer');
  const day = workDayWindow(query.day, query.timezone);
  const start = Date.parse(day.start);
  const end = Date.parse(day.end);
  const ceiling = options.observedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.observedAt);

  const counts = new Map<number, number>();
  for (const observation of observations) {
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at) || at < start || at >= end || at > ceiling) continue;
    const count = observation.count ?? 1;
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    // Bucket boundaries are anchored to the local day start, not to the epoch,
    // so an offset that is not a whole number of buckets still lines up.
    const slot = start + Math.floor((at - start) / bucketMs) * bucketMs;
    counts.set(slot, (counts.get(slot) ?? 0) + count);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .slice(0, WORK_GRAPH_V2_LIMITS.eventBuckets)
    .map(([slot, count]) => ({ at: new Date(slot).toISOString(), count }));
}

/**
 * Keeps only operations whose lease is still open at `now`. A lease is source
 * evidence that a process was observed running; it is not a lifecycle flag and
 * never outlives its own expiry.
 */
export function freshWorkOperations(
  operations: readonly ViewerWorkOperation[],
  now: string,
): ViewerWorkOperation[] {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new RangeError('now must be a valid ISO timestamp');
  return operations.filter((operation) => Date.parse(operation.expiresAt) > at);
}

/** Details may only describe nodes the viewer sees at full `details` disclosure. */
export function detailsForDisclosedNodes(
  nodes: readonly ViewerWorkNode[],
  details: readonly ViewerWorkActivityDetail[],
): ViewerWorkActivityDetail[] {
  const disclosed = new Set(nodes
    .filter((node) => node.disclosure === 'details' && !node.locked)
    .map((node) => node.id));
  const seen = new Set<string>();
  return details.filter((detail) => {
    if (!disclosed.has(detail.nodeId) || seen.has(detail.nodeId)) return false;
    seen.add(detail.nodeId);
    return true;
  });
}
