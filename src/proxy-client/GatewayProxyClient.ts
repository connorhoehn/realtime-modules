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
// `SERVICE_AUTH_SECRET` in the gateway helm chart — without that secret
// the routes reject with 401. Callers must also pass the HMAC signature
// (see service-auth docs); the proxy-client does not yet compute it for
// you. Pipeline status query remains a future addition.

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
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(opts: ProxyClientOptions) {
        if (!opts || typeof opts.gatewayUrl !== 'string' || opts.gatewayUrl.length === 0) {
            throw new TypeError('GatewayProxyClient: gatewayUrl is required');
        }
        // Strip trailing slash so URL composition stays a clean `${base}/path`.
        this.baseUrl = opts.gatewayUrl.replace(/\/+$/, '');
        this.authToken = opts.authToken;
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
