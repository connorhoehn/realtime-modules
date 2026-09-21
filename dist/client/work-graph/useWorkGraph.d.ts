import { type ClientWorkGraphScope, type ClientWorkGraphState } from './reduceSnapshot';
/**
 * Viewer is part of the client boundary even though it is intentionally absent
 * from the viewer-safe snapshot body. Changing it creates a new subscription
 * generation and cannot reuse data from the preceding viewer.
 */
export interface WorkGraphClientScope extends ClientWorkGraphScope {
    viewerId: string;
}
/** Additive request fields. A v1 caller sends exactly the same body as before. */
export interface WorkGraphActivityRequest {
    schemaVersion: 2;
    windowStart: string;
    windowEnd: string;
    mode: 'live' | 'as-of';
}
export interface WorkGraphSnapshotRequest {
    scope: WorkGraphClientScope;
    signal: AbortSignal;
    /** Present only when the caller opted into schemaVersion 2. */
    activity?: WorkGraphActivityRequest;
}
export interface WorkGraphSocketRequest {
    scope: WorkGraphClientScope;
    cursor: string;
    subscriptionGeneration: string;
    /** Present only when the caller opted into schemaVersion 2. */
    activity?: WorkGraphActivityRequest;
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
export type WorkGraphClientError = 'snapshot-unavailable' | 'invalid-snapshot' | 'invalid-query' | 'stream-unavailable';
export interface UseWorkGraphOptions {
    scope: WorkGraphClientScope;
    transport: WorkGraphClientTransport;
    enabled?: boolean;
    reconnectDelayMs?: number;
    /** Intended for deterministic tests and hosts with their own ID generator. */
    createSubscriptionGeneration?: () => string;
    /**
     * Opt-in reader version. Omitted or 1 keeps the existing v1 request and
     * response exactly; 2 requests the activity layer and validates it strictly.
     */
    schemaVersion?: 1 | 2;
    /** Required with schemaVersion 2: the selected interval inside the local day. */
    window?: {
        start: string;
        end: string;
        mode?: 'live' | 'as-of';
    };
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
export declare function useWorkGraph({ scope, transport, enabled, reconnectDelayMs, createSubscriptionGeneration, schemaVersion, window, }: UseWorkGraphOptions): UseWorkGraphResult;
//# sourceMappingURL=useWorkGraph.d.ts.map