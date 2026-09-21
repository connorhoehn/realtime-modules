"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORK_EFFORT_ANCHOR_KINDS = void 0;
exports.deriveWorkEfforts = deriveWorkEfforts;
exports.buildWorkGraphSnapshotV2 = buildWorkGraphSnapshotV2;
exports.bucketWorkEvents = bucketWorkEvents;
exports.freshWorkOperations = freshWorkOperations;
exports.detailsForDisclosedNodes = detailsForDisclosedNodes;
const contractsV2_1 = require("./contractsV2");
const dayWindow_1 = require("./dayWindow");
const validationV2_1 = require("./validationV2");
/** Anchors are real work containers, never "the same person on the same day". */
exports.WORK_EFFORT_ANCHOR_KINDS = ['project', 'task', 'meeting'];
function effortId(anchorNodeId) {
    return `effort.${anchorNodeId}`;
}
function instant(value) {
    const parsed = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * Groups an authorized graph into efforts by walking the relationships the
 * sources actually declared, starting from anchor nodes. Nodes reachable from
 * no anchor are deliberately left ungrouped rather than merged on a heuristic,
 * and each node belongs to at most one effort so membership stays unambiguous.
 */
function deriveWorkEfforts(input) {
    const anchorKinds = new Set(input.anchorKinds ?? exports.WORK_EFFORT_ANCHOR_KINDS);
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const edges = input.edges.filter((edge) => nodeById.has(edge.fromId) && nodeById.has(edge.toId));
    const neighbours = new Map();
    for (const edge of edges) {
        neighbours.set(edge.fromId, [...(neighbours.get(edge.fromId) ?? []), edge.toId]);
        neighbours.set(edge.toId, [...(neighbours.get(edge.toId) ?? []), edge.fromId]);
    }
    // Newest anchor first, with the id as a deterministic tie-break, so effort
    // order is stable across polls that do not change the underlying graph.
    const anchors = input.nodes
        .filter((node) => anchorKinds.has(node.kind))
        .sort((left, right) => instant(right.updatedAt) - instant(left.updatedAt) || left.id.localeCompare(right.id));
    const claimed = new Set();
    const efforts = [];
    for (const anchor of anchors) {
        if (claimed.has(anchor.id) || efforts.length >= contractsV2_1.WORK_GRAPH_V2_LIMITS.efforts)
            continue;
        const members = [];
        const queue = [anchor.id];
        while (queue.length > 0) {
            const current = queue.shift();
            if (claimed.has(current))
                continue;
            claimed.add(current);
            members.push(current);
            for (const next of neighbours.get(current) ?? []) {
                if (!claimed.has(next))
                    queue.push(next);
            }
        }
        const memberSet = new Set(members);
        const edgeIds = edges
            .filter((edge) => memberSet.has(edge.fromId) && memberSet.has(edge.toId))
            .map((edge) => edge.id);
        // The effort is named by the newest outcome the viewer may actually see,
        // falling back to the anchor. A withheld member can never supply a title.
        const outcome = members
            .map((id) => nodeById.get(id))
            .filter((node) => node.kind === 'document' && node.disclosure !== 'existence' && !node.locked)
            .sort((left, right) => instant(right.updatedAt) - instant(left.updatedAt) || left.id.localeCompare(right.id))[0];
        const title = (outcome ?? anchor).title;
        const contextNodeIds = input.contextBefore === undefined
            ? []
            : members.filter((id) => id !== anchor.id
                && instant(nodeById.get(id)?.updatedAt) < instant(input.contextBefore));
        const effort = {
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
/**
 * Assembles and strictly validates a v2 snapshot. A host that cannot satisfy
 * the v2 invariants gets an error instead of a snapshot: the reader contract
 * is never relaxed to let partially derived activity through.
 */
function buildWorkGraphSnapshotV2(input) {
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
    return (0, validationV2_1.validateWorkGraphSnapshotV2)(candidate);
}
/**
 * Buckets observation instants across the query's real local day. Bounds come
 * from the IANA calendar day, so a DST transition shortens or lengthens the
 * day instead of silently dropping or duplicating an hour.
 */
function bucketWorkEvents(query, observations, options = {}) {
    const bucketMs = options.bucketMs ?? 60_000;
    if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0)
        throw new RangeError('bucketMs must be a positive integer');
    const day = (0, dayWindow_1.workDayWindow)(query.day, query.timezone);
    const start = Date.parse(day.start);
    const end = Date.parse(day.end);
    const ceiling = options.observedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.observedAt);
    const counts = new Map();
    for (const observation of observations) {
        const at = Date.parse(observation.at);
        if (!Number.isFinite(at) || at < start || at >= end || at > ceiling)
            continue;
        const count = observation.count ?? 1;
        if (!Number.isSafeInteger(count) || count <= 0)
            continue;
        // Bucket boundaries are anchored to the local day start, not to the epoch,
        // so an offset that is not a whole number of buckets still lines up.
        const slot = start + Math.floor((at - start) / bucketMs) * bucketMs;
        counts.set(slot, (counts.get(slot) ?? 0) + count);
    }
    return [...counts.entries()]
        .sort((left, right) => left[0] - right[0])
        .slice(0, contractsV2_1.WORK_GRAPH_V2_LIMITS.eventBuckets)
        .map(([slot, count]) => ({ at: new Date(slot).toISOString(), count }));
}
/**
 * Keeps only operations whose lease is still open at `now`. A lease is source
 * evidence that a process was observed running; it is not a lifecycle flag and
 * never outlives its own expiry.
 */
function freshWorkOperations(operations, now) {
    const at = Date.parse(now);
    if (!Number.isFinite(at))
        throw new RangeError('now must be a valid ISO timestamp');
    return operations.filter((operation) => Date.parse(operation.expiresAt) > at);
}
/**
 * Reduces details to what this viewer's own node disclosures already allow.
 * An existence-only or locked node keeps no detail at all, and every link,
 * transcript segment and tool list that names a withheld node is removed
 * rather than replaced with a placeholder or a count.
 */
function detailsForDisclosedNodes(nodes, details) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const readable = (id) => {
        const node = byId.get(id);
        return !!node && !node.locked && node.disclosure !== 'existence';
    };
    const disclosed = new Set(nodes
        .filter((node) => node.disclosure === 'details' && !node.locked)
        .map((node) => node.id));
    const seen = new Set();
    const filtered = [];
    for (const detail of details) {
        if (!disclosed.has(detail.nodeId) || seen.has(detail.nodeId))
            continue;
        seen.add(detail.nodeId);
        const node = byId.get(detail.nodeId);
        const keep = (link) => link.nodeId !== detail.nodeId && readable(link.nodeId);
        const inputs = detail.inputs?.filter(keep);
        const sources = detail.sources?.filter(keep);
        const workItem = detail.workItem && keep(detail.workItem) ? detail.workItem : undefined;
        const next = { ...detail };
        if (inputs === undefined || inputs.length === 0)
            delete next.inputs;
        else
            next.inputs = inputs;
        if (sources === undefined || sources.length === 0)
            delete next.sources;
        else
            next.sources = sources;
        if (workItem)
            next.workItem = workItem;
        else
            delete next.workItem;
        if (detail.transcript) {
            // `askEnabled` is only ever true when the source granted the capability.
            next.transcript = {
                segments: detail.transcript.segments,
                askEnabled: detail.transcript.askEnabled && node.capabilities.includes('view-transcript'),
            };
        }
        filtered.push(next);
    }
    return filtered;
}
//# sourceMappingURL=serverV2.js.map