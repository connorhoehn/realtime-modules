/** A single chat message returned by GET /channels/:channelId/chat/history. */
export interface ChatMessage {
    messageId: string;
    channelId: string;
    userId: string;
    content: string;
    timestamp: number;
    [k: string]: unknown;
}
/** Query parameters for the chat history endpoint. */
export interface ChatHistoryQuery {
    before?: number;
    limit?: number;
}
/** A presence entry returned by GET /channels/:channelId/presence. */
export interface PresenceEntry {
    userId: string;
    status: PresenceStatus;
    joinedAt: number;
    metadata?: Record<string, unknown>;
    [k: string]: unknown;
}
/** Possible presence status values. */
export type PresenceStatus = 'online' | 'away' | 'offline' | string;
/** An activity-feed event returned by GET /channels/:channelId/activity/history. */
export interface ActivityEvent {
    eventId: string;
    channelId: string;
    userId: string;
    type: string;
    payload?: Record<string, unknown>;
    timestamp: number;
    [k: string]: unknown;
}
/** Options accepted by the GatewayProxyClient constructor. */
export interface ProxyClientOptions {
    /**
     * Base URL of the gateway, e.g. `https://ws-gateway.example.com`.
     * Trailing slashes are tolerated and stripped at construction time.
     */
    gatewayUrl: string;
    /**
     * Optional bearer token added as `Authorization: Bearer <token>` on every
     * outbound request. When omitted, the client sends no auth header — the
     * gateway is responsible for rejecting unauthenticated traffic upstream
     * (e.g. via a managed ingress, service-auth HMAC envelope, etc.).
     */
    authToken?: string;
    /**
     * HMAC secret for automatic X-Service-Auth signing. Must be paired with
     * `serviceAuthClientId`. When both are provided, every request receives a
     * freshly-computed HMAC envelope matching the v1 wire-format used by
     * @connorhoehn/service-runtime's signEnvelope.
     *
     * Tip: load from `process.env.SERVICE_AUTH_SECRET` and never hard-code.
     */
    serviceAuthSecret?: string;
    /**
     * Identifier of the calling service, embedded in the X-Service-Auth
     * envelope. Must match the name listed in the gateway's
     * SERVICE_AUTH_ALLOWED_SERVICES. Required when `serviceAuthSecret` is set.
     *
     * Example: `'orgiq-middleware'`
     */
    serviceAuthClientId?: string;
    /**
     * Injectable fetch implementation. Defaults to `globalThis.fetch` (Node 18+
     * and all evergreen browsers ship one). Use this hook in tests, or to wire
     * a tracing/retry-wrapped fetch in production.
     */
    fetch?: typeof fetch;
    /**
     * Per-request timeout in ms. Default: 5000. When the timeout fires the
     * client throws ProxyClientTimeoutError so callers can distinguish it from
     * network failures and HTTP errors.
     */
    timeout?: number;
}
/**
 * Base class for all proxy-client errors. Callers can `instanceof` against
 * this OR against one of the more specific subclasses (network / HTTP /
 * timeout). The `cause` field on network errors is the original Error from
 * fetch; the `status` + `body` fields on HTTP errors carry the response.
 */
export declare class ProxyClientError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
/** Thrown when the network call itself fails (DNS, refused, mid-flight reset). */
export declare class ProxyClientNetworkError extends ProxyClientError {
    constructor(message: string, cause?: unknown);
}
/** Thrown when the gateway returns a non-2xx HTTP status. */
export declare class ProxyClientHttpError extends ProxyClientError {
    readonly status: number;
    readonly body?: string | undefined;
    constructor(message: string, status: number, body?: string | undefined);
}
/** Thrown when the per-request timeout fires before the response arrives. */
export declare class ProxyClientTimeoutError extends ProxyClientError {
    readonly timeoutMs: number;
    constructor(message: string, timeoutMs: number);
}
/**
 * `GET /health` response. Mirrors the makeHealthHandler envelope: top-level
 * service / version / status, with per-check details. Field set is
 * permissive (Record) because the gateway's checks array evolves over time
 * (currently: redis, cluster-membership, pipeline, dynamodb).
 */
export interface GatewayHealthResponse {
    service?: string;
    version?: string;
    status?: 'ok' | 'degraded' | 'error' | string;
    checks?: Record<string, {
        ok: boolean;
        details?: Record<string, unknown>;
    }>;
    [k: string]: unknown;
}
/** `GET /cluster` response. */
export interface GatewayClusterInfo {
    nodes: Array<Record<string, unknown>>;
    totalNodes: number;
    totalConnections: number;
    [k: string]: unknown;
}
/** `GET /stats` response. */
export interface GatewayStatsResponse {
    node: Record<string, unknown>;
    services: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
}
/** `GET /metrics` response (JSON variant, NOT the Prometheus text). */
export interface GatewayMetricsResponse {
    connections: {
        current: number;
        peak: number;
    };
    messages: {
        received: number;
        sent: number;
        errors: number;
    };
    crdt: {
        activeDocuments: number;
        totalYDocMemoryMB: number;
    };
    redis: {
        status: 'connected' | 'disconnected' | string;
    };
    uptime: number;
    [k: string]: unknown;
}
/** `POST /hooks/pipeline/:path` success response. */
export interface PipelineWebhookResponse {
    accepted: boolean;
    path: string;
    runId?: string;
    [k: string]: unknown;
}
/** Options for triggerPipelineWebhook. */
export interface TriggerPipelineWebhookOptions {
    /**
     * Optional HMAC-SHA256 signature for `x-webhook-signature`. Format:
     * `sha256=<hex>` over the raw JSON-encoded body. The caller is
     * responsible for computing this when the gateway has
     * PIPELINE_WEBHOOK_SECRET set; in dev (no secret) it can be omitted.
     */
    signature?: string;
}
//# sourceMappingURL=types.d.ts.map