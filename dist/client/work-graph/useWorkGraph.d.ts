import { type ClientWorkGraphScope, type ClientWorkGraphState } from './reduceSnapshot';
/**
 * Viewer is part of the client boundary even though it is intentionally absent
 * from the viewer-safe snapshot body. Changing it creates a new subscription
 * generation and cannot reuse data from the preceding viewer.
 */
export interface WorkGraphClientScope extends ClientWorkGraphScope {
    viewerId: string;
}
export interface WorkGraphSnapshotRequest {
    scope: WorkGraphClientScope;
    signal: AbortSignal;
}
export interface WorkGraphSocketRequest {
    scope: WorkGraphClientScope;
    cursor: string;
    subscriptionGeneration: string;
    onMessage(message: unknown): void;
    onClose(): void;
    onError(): void;
}
export interface WorkGraphSocket {
    close(): void;
}
/**
 * The adapter owns authentication (for example, same-origin cookies or a
 * WebSocket subprotocol). Credentials and URLs are deliberately not accepted
 * here, so they cannot be copied into query strings, React state, or errors.
 */
export interface WorkGraphClientTransport {
    fetchSnapshot(request: WorkGraphSnapshotRequest): Promise<unknown>;
    openWebSocket(request: WorkGraphSocketRequest): WorkGraphSocket;
}
export type WorkGraphClientError = 'snapshot-unavailable' | 'invalid-snapshot' | 'stream-unavailable';
export interface UseWorkGraphOptions {
    scope: WorkGraphClientScope;
    transport: WorkGraphClientTransport;
    enabled?: boolean;
    reconnectDelayMs?: number;
    /** Intended for deterministic tests and hosts with their own ID generator. */
    createSubscriptionGeneration?: () => string;
}
export interface UseWorkGraphResult {
    graph: ClientWorkGraphState;
    status: ClientWorkGraphState['status'] | 'idle' | 'error';
    error: WorkGraphClientError | null;
    retry(): void;
}
/**
 * Owns exactly one viewer-scoped work-graph snapshot/stream handshake.
 * Recovery always obtains a fresh authorized snapshot before accepting more
 * deltas, and every async callback is fenced by both scope and generation.
 */
export declare function useWorkGraph({ scope, transport, enabled, reconnectDelayMs, createSubscriptionGeneration, }: UseWorkGraphOptions): UseWorkGraphResult;
//# sourceMappingURL=useWorkGraph.d.ts.map