// realtime-modules/src/proxy-client/types.ts
//
// Public type surface for the HTTP-shim client.
//
// Re-exports the wire shapes from sibling subpaths so Lambda-native consumers
// (OrgIQ, future App #3) don't have to thread a second import path for every
// payload they touch. Only the types that today's REAL gateway HTTP surface
// (GET /health, /cluster, /stats, /metrics + POST /hooks/pipeline/:path) plus
// the once-they-ship presence/chat/activity REST endpoints will return are
// re-exported here — anything else stays in its native subpath.

export type { ChatMessage, ChatHistoryQuery } from '../chat/types';
export type { PresenceEntry, PresenceStatus } from '../presence/types';
export type { ActivityEvent } from '../activity/types';

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
export class ProxyClientError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'ProxyClientError';
    }
}

/** Thrown when the network call itself fails (DNS, refused, mid-flight reset). */
export class ProxyClientNetworkError extends ProxyClientError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'ProxyClientNetworkError';
    }
}

/** Thrown when the gateway returns a non-2xx HTTP status. */
export class ProxyClientHttpError extends ProxyClientError {
    constructor(
        message: string,
        public readonly status: number,
        public readonly body?: string,
    ) {
        super(message);
        this.name = 'ProxyClientHttpError';
    }
}

/** Thrown when the per-request timeout fires before the response arrives. */
export class ProxyClientTimeoutError extends ProxyClientError {
    constructor(message: string, public readonly timeoutMs: number) {
        super(message);
        this.name = 'ProxyClientTimeoutError';
    }
}

// ---- Response shapes for gateway endpoints that EXIST today --------------

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
    checks?: Record<string, { ok: boolean; details?: Record<string, unknown> }>;
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
    connections: { current: number; peak: number };
    messages: { received: number; sent: number; errors: number };
    crdt: { activeDocuments: number; totalYDocMemoryMB: number };
    redis: { status: 'connected' | 'disconnected' | string };
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
