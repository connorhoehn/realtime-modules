import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphPolicyInput, WorkProjectionState } from './contracts';
/** The only shape this module may hand to a browser-facing route. */
export interface FilteredWorkGraph {
    nodes: ViewerWorkNode[];
    edges: ViewerWorkEdge[];
}
/**
 * Projects an internal graph into browser-safe DTOs from precomputed policy
 * decisions. It performs no source lookups or authorization I/O: callers must
 * intersect grant, audience, source, selection, lifecycle, and resource rules
 * before providing the two decision maps.
 */
export declare function filterForViewer(state: WorkProjectionState, policy: WorkGraphPolicyInput): FilteredWorkGraph;
//# sourceMappingURL=filterForViewer.d.ts.map