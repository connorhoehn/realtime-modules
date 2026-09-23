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
    /**
     * NFR #85 (0.86): ask the platform to name the snapshot's view (`viewHash`)
     * so the stream's first frame can be a patch against it. A transport
     * forwards it as `viewBase=1`; a platform that does not know it answers as
     * before and the first frame stays whole.
     */
    viewBase?: 1;
}
export interface WorkGraphSnapshotRequest {
    scope: WorkGraphClientScope;
    signal: AbortSignal;
    /** Present only when the caller opted into schemaVersion 2. */
    activity?: WorkGraphActivityRequest;
}
export interface WorkGraphSocketRequest {
    scope: WorkGraphClientScope;
    /** Absent only with `awaitAccess: 1`: there is no snapshot to continue from. */
    cursor?: string;
    subscriptionGeneration: string;
    /**
     * The snapshot was refused (NFR #109). The transport forwards this on the
     * subscribe frame without a cursor; the gateway keeps a content-free
     * placeholder for this socket and answers `reset-required` /
     * `access-restored` once the platform's access signal re-authorizes the
     * viewer. Nothing is polled, and no data rides this socket: the hook
     * fetches a fresh snapshot on the hint.
     */
    awaitAccess?: 1;
    /** Present only when the caller opted into schemaVersion 2. */
    activity?: WorkGraphActivityRequest;
    /**
     * Set with schemaVersion 2: this reader applies `viewPatch` frames (NFR #66),
     * so the transport should forward it on the subscribe frame. A gateway that
     * never sees it keeps sending the whole view.
     */
    viewPatch?: 1;
    /**
     * The `viewHash` of the snapshot this stream starts from (NFR #85). The
     * transport forwards it on the subscribe frame; a gateway that can prove
     * that view patches the first frame against it, anything else sends it whole.
     */
    baseViewHash?: string;
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
    /** Ceiling for the backoff between recovery attempts after transient failures. */
    retryMaxDelayMs?: number;
    /**
     * How long transient failures (5xx, refused connections, a dropped socket)
     * are retried silently before the hook reports an error. It keeps retrying
     * after that; only a refusal (401/403/404 and other 4xx) stops it.
     */
    outageGraceMs?: number;
    /** Jitter source, injectable for tests. */
    random?: () => number;
    /** A snapshot request that has not answered by then is abandoned and retried. */
    snapshotTimeoutMs?: number;
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
export declare function useWorkGraph({ scope, transport, enabled, reconnectDelayMs, createSubscriptionGeneration, schemaVersion, window, retryMaxDelayMs, outageGraceMs, random, snapshotTimeoutMs, }: UseWorkGraphOptions): UseWorkGraphResult;
//# sourceMappingURL=useWorkGraph.d.ts.map