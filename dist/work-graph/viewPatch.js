"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffWorkGraphViewV2 = diffWorkGraphViewV2;
exports.applyWorkGraphViewPatchV2 = applyWorkGraphViewPatchV2;
const effortKey = (entry) => entry.id;
const detailKey = (entry) => entry.nodeId;
const bucketKey = (entry) => entry.at;
function applyList(base, patch, key) {
    if (!patch)
        return [...base];
    if (!Array.isArray(patch.upsert) || !Array.isArray(patch.remove))
        return null;
    const removed = new Set(patch.remove);
    const result = base.filter((entry) => !removed.has(key(entry)));
    const index = new Map(result.map((entry, position) => [key(entry), position]));
    for (const entry of patch.upsert) {
        if (entry === null || typeof entry !== 'object')
            return null;
        const id = key(entry);
        if (typeof id !== 'string')
            return null;
        const position = index.get(id);
        if (position === undefined) {
            index.set(id, result.length);
            result.push(entry);
        }
        else {
            result[position] = entry;
        }
    }
    if (patch.order === undefined)
        return result;
    if (!Array.isArray(patch.order) || patch.order.length !== result.length)
        return null;
    const used = new Set();
    const ordered = [];
    for (const position of patch.order) {
        if (!Number.isInteger(position) || position < 0 || position >= result.length || used.has(position))
            return null;
        used.add(position);
        ordered.push(result[position]);
    }
    return ordered;
}
function diffList(base, next, key) {
    const before = new Map(base.map((entry) => [key(entry), JSON.stringify(entry)]));
    const nextIds = new Set(next.map(key));
    const remove = [...before.keys()].filter((id) => !nextIds.has(id));
    const upsert = next.filter((entry) => before.get(key(entry)) !== JSON.stringify(entry));
    if (remove.length === 0 && upsert.length === 0 && base.every((entry, i) => key(entry) === key(next[i]))) {
        return undefined;
    }
    const patch = { upsert, remove };
    const applied = applyList(base, patch, key) ?? [];
    if (applied.length !== next.length || applied.some((entry, i) => key(entry) !== key(next[i]))) {
        const position = new Map(applied.map((entry, i) => [key(entry), i]));
        patch.order = next.map((entry) => position.get(key(entry)));
    }
    return patch;
}
/** The smallest keyed patch that turns `base` into `next`. */
function diffWorkGraphViewV2(base, next, baseWatermark) {
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
function applyWorkGraphViewPatchV2(base, patch) {
    if (patch === null || typeof patch !== 'object')
        return null;
    const efforts = applyList(base.efforts, patch.efforts, effortKey);
    const details = applyList(base.details, patch.details, detailKey);
    const eventBuckets = applyList(base.eventBuckets, patch.eventBuckets, bucketKey);
    if (!efforts || !details || !eventBuckets)
        return null;
    return {
        query: patch.query,
        temporal: patch.temporal,
        efforts,
        details,
        operations: patch.operations,
        eventBuckets,
    };
}
//# sourceMappingURL=viewPatch.js.map