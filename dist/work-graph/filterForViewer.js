"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterForViewer = filterForViewer;
const opaqueId_1 = require("./opaqueId");
const capabilities = new Set([
    'message',
    'view-document',
    'edit-document',
    'join-conversation',
    'join-meeting',
    'observe-terminal',
    'control-terminal',
    'view-transcript',
    'view-run',
    'dispatch-run',
]);
// Viewer DTOs require a timestamp even for a placeholder. This sentinel says
// that no source timestamp was disclosed; it is not derived from the work item.
const EXISTENCE_PLACEHOLDER_UPDATED_AT = '1970-01-01T00:00:00.000Z';
function allowedDecision(decisions, id, policyRevision) {
    const decision = decisions.get(id);
    if (!decision
        || decision.targetId !== id
        || decision.decision !== 'allow'
        || decision.policyRevision !== policyRevision
        || !decision.maximumDisclosure) {
        return undefined;
    }
    return decision;
}
function safeCapabilities(decision) {
    return (decision.capabilities ?? []).filter((capability) => capabilities.has(capability));
}
function existenceNode(decision, publicId) {
    const label = decision.existenceLabel?.trim();
    if (!label)
        return undefined;
    // This deliberately does not read a field from InternalWorkNode. `id` is a
    // viewer-local opaque value assigned by the projection loop, so neither an
    // internal identifier nor the sanitized label is repeated in the id field.
    return {
        id: publicId,
        kind: 'task',
        title: label,
        status: 'idle',
        disclosure: 'existence',
        updatedAt: EXISTENCE_PLACEHOLDER_UPDATED_AT,
        capabilities: [],
        locked: true,
    };
}
function viewerNode(node, decision, existencePublicId) {
    const disclosure = decision.maximumDisclosure;
    if (disclosure === 'existence')
        return existenceNode(decision, existencePublicId);
    if (disclosure !== 'summary' && disclosure !== 'details')
        return undefined;
    const base = {
        id: node.id,
        kind: node.kind,
        title: node.title,
        status: node.status,
        disclosure,
        updatedAt: node.updatedAt,
        capabilities: safeCapabilities(decision),
    };
    if (disclosure === 'details') {
        return {
            ...base,
            ...(node.description ? { description: node.description } : {}),
            ...(node.startedAt ? { startedAt: node.startedAt } : {}),
            ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
            ...(node.endedAt ? { endedAt: node.endedAt } : {}),
        };
    }
    return base;
}
function viewerEdge(edge, decision, nodes) {
    // ViewerWorkEdge requires a relation. A generic relation would be fabricated,
    // while the real one can disclose provenance, so existence-only edges are
    // intentionally omitted rather than represented unsafely.
    const disclosure = decision.maximumDisclosure;
    if (disclosure === 'existence')
        return undefined;
    if (disclosure !== 'summary' && disclosure !== 'details')
        return undefined;
    const from = nodes.get(edge.fromId);
    const to = nodes.get(edge.toId);
    if (!from || !to)
        return undefined;
    const base = {
        id: edge.id,
        fromId: from.id,
        toId: to.id,
        relation: edge.relation,
        status: edge.status,
        disclosure,
        updatedAt: edge.updatedAt,
        capabilities: safeCapabilities(decision),
    };
    if (disclosure === 'details') {
        return {
            ...base,
            ...(edge.label ? { label: edge.label } : {}),
            ...(edge.startedAt ? { startedAt: edge.startedAt } : {}),
            ...(edge.updatedAt ? { updatedAt: edge.updatedAt } : {}),
            ...(edge.endedAt ? { endedAt: edge.endedAt } : {}),
        };
    }
    return base;
}
/**
 * Projects an internal graph into browser-safe DTOs from precomputed policy
 * decisions. It performs no source lookups or authorization I/O: callers must
 * intersect grant, audience, source, selection, lifecycle, and resource rules
 * before providing the two decision maps.
 */
function filterForViewer(state, policy) {
    // A decision set cannot be replayed against another owner or organization.
    // This is deliberately a fail-closed consistency check, not authorization.
    if (state.organizationId !== policy.scope.organizationId
        || state.actorId !== policy.scope.personId
        || policy.grant.organizationId !== state.organizationId
        || policy.grant.ownerId !== state.actorId) {
        return { nodes: [], edges: [] };
    }
    const visibleNodes = new Map();
    const publicIds = new Set();
    for (const node of Object.values(state.nodes)) {
        if (node.deletedAt || node.organizationId !== state.organizationId || node.actorId !== state.actorId)
            continue;
        const decision = allowedDecision(policy.nodeDecisions, node.id, policy.scope.policyRevision);
        if (!decision)
            continue;
        // Stable within this viewer/query/policy, even when neighboring nodes are
        // removed or reordered. A new policy or viewer cannot reuse its identity.
        const existencePublicId = decision.maximumDisclosure === 'existence'
            ? (0, opaqueId_1.opaqueWorkId)('placeholder', policy.scope.organizationId, policy.scope.viewerId, policy.scope.personId, policy.scope.day, policy.scope.timezone, policy.scope.policyRevision, node.id)
            : 'work_placeholder_unused';
        const projected = viewerNode(node, decision, existencePublicId);
        if (!projected || publicIds.has(projected.id))
            continue;
        publicIds.add(projected.id);
        visibleNodes.set(node.id, projected);
    }
    const visibleEdges = [];
    for (const edge of Object.values(state.edges)) {
        if (edge.deletedAt || edge.organizationId !== state.organizationId || edge.actorId !== state.actorId)
            continue;
        const decision = allowedDecision(policy.edgeDecisions, edge.id, policy.scope.policyRevision);
        if (!decision)
            continue;
        const projected = viewerEdge(edge, decision, visibleNodes);
        if (projected)
            visibleEdges.push(projected);
    }
    return { nodes: [...visibleNodes.values()], edges: visibleEdges };
}
//# sourceMappingURL=filterForViewer.js.map