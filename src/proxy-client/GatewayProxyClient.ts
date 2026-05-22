// realtime-modules/src/proxy-client/GatewayProxyClient.ts
//
// HTTP-shim client for Lambda-native (and any other non-WS) consumers of
// the gateway. Wraps the REST endpoints the gateway exposes today.
//
// REALITY CHECK — current gateway HTTP surface (src/server.ts):
//   GET  /health
//   GET  /cluster
//   GET  /stats
//   GET  /metrics                       (JSON)
//   GET  /internal/metrics              (Prometheus text — NOT wrapped here)
//   GET  /internal/postmortem           (service-auth gated — NOT wrapped here)
//   POST /hooks/pipeline/:path          (webhook trigger)
//   POST /api/channels/:id/messages     (Wave 6 — service-auth HMAC gated)
//   GET  /api/presence/:channel         (Wave 6 — service-auth HMAC gated)
//   GET  /api/chat/:channel/history     (Wave 6 — service-auth HMAC gated)
//   GET  /api/activity/:channel/history (Wave 6 — service-auth HMAC gated)
//   GET  /*                             (static file serving)
//
// STATUS — the strategic "Lambda apps USE gateway-hosted features over REST"
// story is now live. Gateway routes for channel publish, presence query,
// chat history, and activity history shipped in websocket-gateway commit
// `a62195c` (Wave 6). The four wrappers below
// (publishToChannel / getPresence / getChatHistory / getActivityHistory)
// target those routes and work end-to-end the moment the operator wires
// `SERVICE_AUTH_SECRET` in the gateway helm chart.
//
// HMAC SIGNING — when `serviceAuthSecret` + `serviceAuthClientId` are
// provided, the client computes the X-Service-Auth header automatically on
// every request, using the same v1 envelope as @connorhoehn/service-runtime.
// The algorithm is inlined here (uses Node built-in `crypto`) so the
// proxy-client subpath has zero extra runtime dependencies. Callers that
// want the canonical implementation can list @connorhoehn/service-runtime as
// an optional peer dep and use signEnvelope directly — the wire format is
// identical. Pipeline status query remains a future addition.

import { createHmac } from 'crypto';
import {
    ProxyClientOptions,
    ProxyClientNetworkError,
    ProxyClientHttpError,
    ProxyClientTimeoutError,
    GatewayHealthResponse,
    GatewayClusterInfo,
    GatewayStatsResponse,
    GatewayMetricsResponse,
    PipelineWebhookResponse,
    TriggerPipelineWebhookOptions,
    ChatMessage,
    PresenceEntry,
    ActivityEvent,
} from './types';

// ---------------------------------------------------------------------------
// Inline HMAC signing — wire-format compatible with @connorhoehn/service-runtime
// signEnvelope. Format: v1.<serviceId>.<unixTsSec>.<base64url(HMAC-SHA256)>
// Payload is canonicalised (sorted-keys JSON for objects, raw string otherwise).
// ---------------------------------------------------------------------------

function _canonicalise(payload: string | object): string {
    if (typeof payload === 'string') return payload;
    return _stableStringify(payload);
}

function _stableStringify(value: unknown, seen: Set<object> = new Set()): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) throw new Error('signEnvelope: circular reference in payload');
    seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            return '[' + obj.map((v) => _stableStringify(v, seen)).join(',') + ']';
        }
        const keys = Object.keys(obj).sort();
        const parts = keys
            .filter((k) => obj[k] !== undefined)
            .map((k) => JSON.stringify(k) + ':' + _stableStringify(obj[k], seen));
        return '{' + parts.join(',') + '}';
    } finally {
        seen.delete(obj);
    }
}

function _base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an X-Service-Auth header value. Wire-format identical to
 * @connorhoehn/service-runtime's signEnvelope (v1 envelope).
 * Used internally by GatewayProxyClient when serviceAuthSecret is configured.
 */
function _buildServiceAuthHeader(
    payload: string | object,
    secret: string,
    serviceId: string,
): string {
    const tsSec = Math.floor(Date.now() / 1000);
    const payloadStr = _canonicalise(payload);
    const mac = createHmac('sha256', secret);
    mac.update(`${serviceId}.${tsSec}.${payloadStr}`);
    return `v1.${serviceId}.${tsSec}.${_base64url(mac.digest())}`;
}

/** Header name for the HMAC service-auth envelope. */
const SERVICE_AUTH_HEADER = 'X-Service-Auth';

const DEFAULT_TIMEOUT_MS = 5_000;

interface RequestOptions {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
}

export class GatewayProxyClient {
    private readonly baseUrl: string;
    private readonly authToken?: string;
    private readonly serviceAuthSecret?: string;
    private readonly serviceAuthClientId?: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(opts: ProxyClientOptions) {
        if (!opts || typeof opts.gatewayUrl !== 'string' || opts.gatewayUrl.length === 0) {
            throw new TypeError('GatewayProxyClient: gatewayUrl is required');
        }
        // Strip trailing slash so URL composition stays a clean `${base}/path`.
        this.baseUrl = opts.gatewayUrl.replace(/\/+$/, '');
        this.authToken = opts.authToken;

        if (opts.serviceAuthSecret && !opts.serviceAuthClientId) {
            throw new TypeError(
                'GatewayProxyClient: serviceAuthClientId is required when serviceAuthSecret is set',
            );
        }
        if (opts.serviceAuthClientId && !opts.serviceAuthSecret) {
            throw new TypeError(
                'GatewayProxyClient: serviceAuthSecret is required when serviceAuthClientId is set',
            );
        }
        this.serviceAuthSecret = opts.serviceAuthSecret;
        this.serviceAuthClientId = opts.serviceAuthClientId;

        const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
        if (typeof f !== 'function') {
            throw new TypeError(
                'GatewayProxyClient: no fetch implementation available. Pass `fetch` in options or run on Node 18+.',
            );
        }
        this.fetchImpl = f;
        this.timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    }

    // ---- Endpoints that EXIST on the gateway today ----------------------

    /** `GET /health` — gateway health probe (Redis / cluster / pipeline / DDB). */
    async getHealth(): Promise<GatewayHealthResponse> {
        return this.request<GatewayHealthResponse>({ method: 'GET', path: '/health' });
    }

    /** `GET /cluster` — cluster membership / node info. */
    async getClusterInfo(): Promise<GatewayClusterInfo> {
        return this.request<GatewayClusterInfo>({ method: 'GET', path: '/cluster' });
    }

    /** `GET /stats` — per-service stats. */
    async getStats(): Promise<GatewayStatsResponse> {
        return this.request<GatewayStatsResponse>({ method: 'GET', path: '/stats' });
    }

    /** `GET /metrics` — JSON metrics (connections / messages / crdt / redis / uptime). */
    async getMetrics(): Promise<GatewayMetricsResponse> {
        return this.request<GatewayMetricsResponse>({ method: 'GET', path: '/metrics' });
    }

    /**
     * `POST /hooks/pipeline/:path` — trigger a pipeline run via the existing
     * webhook endpoint. When the gateway has PIPELINE_WEBHOOK_SECRET set the
     * caller must compute the HMAC-SHA256 signature and pass it via
     * `opts.signature` (format: `sha256=<hex>` over the JSON-encoded body).
     */
    async triggerPipelineWebhook(
        webhookPath: string,
        payload: unknown,
        opts: TriggerPipelineWebhookOptions = {},
    ): Promise<PipelineWebhookResponse> {
        if (!webhookPath || typeof webhookPath !== 'string') {
            throw new TypeError('triggerPipelineWebhook: webhookPath is required');
        }
        const cleaned = webhookPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        if (opts.signature) headers['x-webhook-signature'] = opts.signature;
        return this.request<PipelineWebhookResponse>({
            method: 'POST',
            path: `/hooks/pipeline/${cleaned}`,
            body: payload,
            headers,
        });
    }

    // ---- Channel / presence / chat / activity surface -------------------
    //
    // Gateway HTTP routes for these methods shipped in websocket-gateway
    // commit `a62195c` (Wave 6). They are gated by service-auth HMAC, so
    // they require `SERVICE_AUTH_SECRET` to be wired in the gateway helm
    // chart and a matching signature on the caller side — without that
    // the gateway will reject with 401. Unit tests exercise them against
    // a mock fetch; integration against a real gateway requires the
    // helm-side secret.

    /**
     * `POST /api/channels/:id/messages` — publishes a payload to all WS
     * subscribers of `channel` via the gateway's message router. Returns
     * the number of subscribers the gateway fanned out to. Requires
     * `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    async publishToChannel(
        channel: string,
        payload: unknown,
    ): Promise<{ delivered: number }> {
        if (!channel) throw new TypeError('publishToChannel: channel is required');
        return this.request<{ delivered: number }>({
            method: 'POST',
            path: `/api/channels/${encodeURIComponent(channel)}/messages`,
            body: { payload },
        });
    }

    /**
     * `GET /api/presence/:channel` — returns the current presence roster
     * for `channel`. Requires `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    async getPresence(channel: string): Promise<{ users: PresenceEntry[] }> {
        if (!channel) throw new TypeError('getPresence: channel is required');
        return this.request<{ users: PresenceEntry[] }>({
            method: 'GET',
            path: `/api/presence/${encodeURIComponent(channel)}`,
        });
    }

    /**
     * `GET /api/chat/:channel/history` — returns chat history for
     * `channel`, optionally bounded by `limit` and pagination cursor
     * `before` (a message id). Requires `SERVICE_AUTH_SECRET` wired in
     * gateway helm.
     */
    async getChatHistory(
        channel: string,
        opts: { limit?: number; before?: string } = {},
    ): Promise<ChatMessage[]> {
        if (!channel) throw new TypeError('getChatHistory: channel is required');
        return this.request<ChatMessage[]>({
            method: 'GET',
            path: `/api/chat/${encodeURIComponent(channel)}/history`,
            query: { limit: opts.limit, before: opts.before },
        });
    }

    /**
     * `GET /api/activity/:channel/history` — returns activity events for
     * `channel`. Requires `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    async getActivityHistory(
        channel: string,
        opts: { limit?: number } = {},
    ): Promise<ActivityEvent[]> {
        if (!channel) throw new TypeError('getActivityHistory: channel is required');
        return this.request<ActivityEvent[]>({
            method: 'GET',
            path: `/api/activity/${encodeURIComponent(channel)}/history`,
            query: { limit: opts.limit },
        });
    }

    // ---- Internal -------------------------------------------------------

    private async request<T>(opts: RequestOptions): Promise<T> {
        const url = this.buildUrl(opts.path, opts.query);
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...(opts.headers ?? {}),
        };
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

        // Compute HMAC envelope when signing is configured. The payload signed
        // is the request body (or an empty string for GET requests). This matches
        // the gateway's requireServiceAuthRawHttp verifier which re-canonicalises
        // the body on the server side.
        if (this.serviceAuthSecret && this.serviceAuthClientId) {
            // Sign the body (or empty string for bodyless requests). The payload
            // must be string | object for _buildServiceAuthHeader / _canonicalise;
            // opts.body is `unknown` so we cast after the undefined guard. Any
            // value that reaches here is always a plain serialisable object or
            // primitive (set by the public methods above), never a class instance.
            const signingPayload: string | object =
                opts.body !== undefined ? (opts.body as string | object) : '';
            headers[SERVICE_AUTH_HEADER] = _buildServiceAuthHeader(
                signingPayload,
                this.serviceAuthSecret,
                this.serviceAuthClientId,
            );
        }

        const init: RequestInit = { method: opts.method, headers };
        if (opts.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
        init.signal = controller.signal;

        let response: Response;
        try {
            response = await this.fetchImpl(url, init);
        } catch (err: unknown) {
            clearTimeout(timeoutHandle);
            // AbortError indicates our timeout fired; all other thrown errors
            // are network-layer failures (DNS, refused, reset, etc.).
            if (isAbortError(err)) {
                throw new ProxyClientTimeoutError(
                    `Request to ${opts.method} ${opts.path} timed out after ${this.timeoutMs}ms`,
                    this.timeoutMs,
                );
            }
            throw new ProxyClientNetworkError(
                `Network error calling ${opts.method} ${opts.path}: ${describeError(err)}`,
                err,
            );
        }
        clearTimeout(timeoutHandle);

        if (!response.ok) {
            let body: string | undefined;
            try {
                body = await response.text();
            } catch {
                body = undefined;
            }
            throw new ProxyClientHttpError(
                `Gateway returned ${response.status} for ${opts.method} ${opts.path}`,
                response.status,
                body,
            );
        }

        // 204 No Content paths — preserve type T as undefined to the caller.
        if (response.status === 204) return undefined as unknown as T;

        try {
            return (await response.json()) as T;
        } catch (err) {
            throw new ProxyClientNetworkError(
                `Failed to parse JSON response from ${opts.method} ${opts.path}: ${describeError(err)}`,
                err,
            );
        }
    }

    private buildUrl(
        path: string,
        query?: Record<string, string | number | undefined>,
    ): string {
        const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
            }
        }
        return url.toString();
    }
}

function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    return name === 'AbortError';
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
        return String(err);
    } catch {
        return '<unknown>';
    }
}
