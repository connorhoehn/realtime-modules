"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClientWorkGraphState = createClientWorkGraphState;
exports.applyWorkGraphSnapshot = applyWorkGraphSnapshot;
exports.applyWorkGraphSnapshotV2 = applyWorkGraphSnapshotV2;
exports.applyWorkGraphActivity = applyWorkGraphActivity;
exports.reduceWorkGraphStream = reduceWorkGraphStream;
function createClientWorkGraphState(scope, subscriptionGeneration) {
    return {
        scope,
        subscriptionGeneration,
        nodes: {},
        edges: {},
        sources: {},
        status: 'loading',
    };
}
function sameScope(left, right) {
    return left.personId === right.personId && left.day === right.day && left.timezone === right.timezone;
}
/** Apply an HTTP snapshot only to the request generation and scope that started it. */
function applyWorkGraphSnapshot(state, snapshot, request) {
    if (request.subscriptionGeneration !== state.subscriptionGeneration || !sameScope(request.scope, state.scope))
        return state;
    if (!sameScope(snapshot.scope, state.scope))
        return state;
    return {
        ...state,
        policyRevision: snapshot.scope.policyRevision,
        watermark: snapshot.watermark,
        cursor: snapshot.cursor,
        nodes: Object.fromEntries(snapshot.nodes.map((node) => [node.id, node])),
        edges: Object.fromEntries(snapshot.edges.map((edge) => [edge.id, edge])),
        sources: Object.fromEntries(snapshot.sources.map((source) => [source.source, source])),
        status: snapshot.partial ? 'partial' : 'ready',
        resetReason: undefined,
    };
}
/**
 * Applies an opt-in v2 snapshot. The graph half reuses the v1 reducer so both
 * versions converge on one node/edge state; only the activity layer is added.
 */
function applyWorkGraphSnapshotV2(state, snapshot, request) {
    const { query, temporal, efforts, details, operations, eventBuckets, ...base } = snapshot;
    const next = applyWorkGraphSnapshot(state, { ...base, schemaVersion: 1 }, request);
    if (next === state)
        return state;
    return { ...next, activity: { query, temporal, efforts, details, operations, eventBuckets } };
}
/**
 * Replaces the activity layer without touching authorized node/edge state.
 * A refresh from another policy revision or generation is dropped, so a stale
 * effort/detail set can never be shown beside newer authorization.
 */
function applyWorkGraphActivity(state, activity, request) {
    if (request.subscriptionGeneration !== state.subscriptionGeneration)
        return state;
    if (state.activity === undefined)
        return state;
    if (request.policyRevision !== undefined && request.policyRevision !== state.policyRevision)
        return state;
    if (activity.query.personId !== state.scope.personId
        || activity.query.day !== state.scope.day
        || activity.query.timezone !== state.scope.timezone)
        return state;
    return { ...state, activity };
}
function requireRefetch(state, reason) {
    return { ...state, status: 'refetch-required', resetReason: reason };
}
function applyDelta(state, batch) {
    if (batch.subscriptionGeneration !== state.subscriptionGeneration)
        return state;
    if (state.status === 'invalidated')
        return state;
    if (state.policyRevision !== undefined && batch.policyRevision !== state.policyRevision) {
        return {
            ...state,
            policyRevision: batch.policyRevision,
            nodes: {}, edges: {}, sources: {}, cursor: undefined, watermark: undefined,
            status: 'invalidated', resetReason: 'policy-changed',
        };
    }
    if (state.watermark === undefined)
        return requireRefetch(state, 'snapshot-required');
    if (batch.watermark <= state.watermark)
        return state;
    if (batch.previousWatermark !== state.watermark)
        return requireRefetch(state, 'gap');
    const nodes = { ...state.nodes };
    const edges = { ...state.edges };
    const sources = { ...state.sources };
    // Node removals/upserts happen before relationships so one batch is atomic
    // even when its serialized operation order puts an edge first.
    for (const operation of batch.operations) {
        if (operation.kind === 'upsert-node')
            nodes[operation.node.id] = operation.node;
        if (operation.kind === 'remove-node') {
            delete nodes[operation.nodeId];
            for (const edge of Object.values(edges)) {
                if (edge.fromId === operation.nodeId || edge.toId === operation.nodeId)
                    delete edges[edge.id];
            }
        }
    }
    for (const operation of batch.operations) {
        if (operation.kind === 'upsert-edge') {
            if (!nodes[operation.edge.fromId] || !nodes[operation.edge.toId])
                return requireRefetch(state, 'dangling-edge');
            edges[operation.edge.id] = operation.edge;
        }
        else if (operation.kind === 'remove-edge') {
            delete edges[operation.edgeId];
        }
        else if (operation.kind === 'source-health') {
            sources[operation.source.source] = operation.source;
        }
    }
    return {
        ...state,
        nodes, edges, sources,
        watermark: batch.watermark,
        cursor: batch.cursor,
        status: Object.values(sources).some((source) => source.health !== 'available') ? 'partial' : 'ready',
        resetReason: undefined,
    };
}
function reduceWorkGraphStream(state, message) {
    const generation = message.kind === 'delta' ? message.batch.subscriptionGeneration : message.subscriptionGeneration;
    if (generation !== state.subscriptionGeneration)
        return state;
    if (message.kind === 'delta')
        return applyDelta(state, message.batch);
    if (message.kind === 'reset-required')
        return requireRefetch(state, message.reason);
    return {
        ...state,
        nodes: {}, edges: {}, sources: {}, cursor: undefined, watermark: undefined,
        status: 'invalidated', resetReason: message.reason,
    };
}
//# sourceMappingURL=reduceSnapshot.js.map