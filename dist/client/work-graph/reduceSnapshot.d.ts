import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphSnapshot, WorkGraphStreamMessage, WorkSourceStatus } from '../../work-graph/contracts';
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
}
export declare function createClientWorkGraphState(scope: ClientWorkGraphScope, subscriptionGeneration: string): ClientWorkGraphState;
/** Apply an HTTP snapshot only to the request generation and scope that started it. */
export declare function applyWorkGraphSnapshot(state: ClientWorkGraphState, snapshot: WorkGraphSnapshot, request: {
    scope: ClientWorkGraphScope;
    subscriptionGeneration: string;
}): ClientWorkGraphState;
export declare function reduceWorkGraphStream(state: ClientWorkGraphState, message: WorkGraphStreamMessage): ClientWorkGraphState;
//# sourceMappingURL=reduceSnapshot.d.ts.map