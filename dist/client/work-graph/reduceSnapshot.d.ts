import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphSnapshot, WorkGraphStreamMessage, WorkSourceStatus } from '../../work-graph/contracts';
import type { WorkGraphQueryV2, WorkGraphSnapshotV2 } from '../../work-graph/contractsV2';
import type { WorkGraphActivityV2 } from '../../work-graph/serverV2';
/** Present only for a schemaVersion 2 request. v1 state is byte-for-byte unchanged. */
export interface ClientWorkGraphActivity extends WorkGraphActivityV2 {
    query: WorkGraphQueryV2;
}
export interface ClientWorkGraphScope {
    personId: string;
    day: string;
    timezone: string;
}
export interface ClientWorkGraphState {
    scope: ClientWorkGraphScope;
    subscriptionGeneration: string;
    policyRevision?: string;
    watermark?: number;
    cursor?: string;
    nodes: Record<string, ViewerWorkNode>;
    edges: Record<string, ViewerWorkEdge>;
    sources: Record<string, WorkSourceStatus>;
    status: 'loading' | 'ready' | 'partial' | 'invalidated' | 'refetch-required';
    resetReason?: string;
    /** Opt-in v2 activity layer. Absent for every v1 request. */
    activity?: ClientWorkGraphActivity;
}
export declare function createClientWorkGraphState(scope: ClientWorkGraphScope, subscriptionGeneration: string): ClientWorkGraphState;
/** Apply an HTTP snapshot only to the request generation and scope that started it. */
export declare function applyWorkGraphSnapshot(state: ClientWorkGraphState, snapshot: WorkGraphSnapshot, request: {
    scope: ClientWorkGraphScope;
    subscriptionGeneration: string;
}): ClientWorkGraphState;
/**
 * Applies an opt-in v2 snapshot. The graph half reuses the v1 reducer so both
 * versions converge on one node/edge state; only the activity layer is added.
 */
export declare function applyWorkGraphSnapshotV2(state: ClientWorkGraphState, snapshot: WorkGraphSnapshotV2, request: {
    scope: ClientWorkGraphScope;
    subscriptionGeneration: string;
}): ClientWorkGraphState;
/**
 * Replaces the activity layer without touching authorized node/edge state.
 * A refresh from another policy revision or generation is dropped, so a stale
 * effort/detail set can never be shown beside newer authorization.
 */
export declare function applyWorkGraphActivity(state: ClientWorkGraphState, activity: ClientWorkGraphActivity, request: {
    subscriptionGeneration: string;
    policyRevision?: string;
}): ClientWorkGraphState;
export declare function reduceWorkGraphStream(state: ClientWorkGraphState, message: WorkGraphStreamMessage): ClientWorkGraphState;
//# sourceMappingURL=reduceSnapshot.d.ts.map