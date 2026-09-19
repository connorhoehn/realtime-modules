"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClientWorkGraphState = createClientWorkGraphState;
exports.applyWorkGraphSnapshot = applyWorkGraphSnapshot;
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