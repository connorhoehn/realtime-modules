import { ProxyClientOptions, GatewayHealthResponse, GatewayClusterInfo, GatewayStatsResponse, GatewayMetricsResponse, PipelineWebhookResponse, TriggerPipelineWebhookOptions, ChatMessage, PresenceEntry, ActivityEvent } from './types';
export declare class GatewayProxyClient {
    private readonly baseUrl;
    private readonly authToken?;
    private readonly serviceAuthSecret?;
    private readonly serviceAuthClientId?;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(opts: ProxyClientOptions);
    /** `GET /health` — gateway health probe (Redis / cluster / pipeline / DDB). */
    getHealth(): Promise<GatewayHealthResponse>;
    /** `GET /cluster` — cluster membership / node info. */
    getClusterInfo(): Promise<GatewayClusterInfo>;
    /** `GET /stats` — per-service stats. */
    getStats(): Promise<GatewayStatsResponse>;
    /** `GET /metrics` — JSON metrics (connections / messages / crdt / redis / uptime). */
    getMetrics(): Promise<GatewayMetricsResponse>;
    /**
     * `POST /hooks/pipeline/:path` — trigger a pipeline run via the existing
     * webhook endpoint. When the gateway has PIPELINE_WEBHOOK_SECRET set the
     * caller must compute the HMAC-SHA256 signature and pass it via
     * `opts.signature` (format: `sha256=<hex>` over the JSON-encoded body).
     */
    triggerPipelineWebhook(webhookPath: string, payload: unknown, opts?: TriggerPipelineWebhookOptions): Promise<PipelineWebhookResponse>;
    /**
     * `POST /api/channels/:id/messages` — publishes a payload to all WS
     * subscribers of `channel` via the gateway's message router. Returns
     * the number of subscribers the gateway fanned out to. Requires
     * `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    publishToChannel(channel: string, payload: unknown): Promise<{
        delivered: number;
    }>;
    /**
     * `GET /api/presence/:channel` — returns the current presence roster
     * for `channel`. Requires `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    getPresence(channel: string): Promise<{
        users: PresenceEntry[];
    }>;
    /**
     * `GET /api/chat/:channel/history` — returns chat history for
     * `channel`, optionally bounded by `limit` and pagination cursor
     * `before` (a message id). Requires `SERVICE_AUTH_SECRET` wired in
     * gateway helm.
     */
    getChatHistory(channel: string, opts?: {
        limit?: number;
        before?: string;
    }): Promise<ChatMessage[]>;
    /**
     * `GET /api/activity/:channel/history` — returns activity events for
     * `channel`. Requires `SERVICE_AUTH_SECRET` wired in gateway helm.
     */
    getActivityHistory(channel: string, opts?: {
        limit?: number;
    }): Promise<ActivityEvent[]>;
    /**
     * `GET /api/capabilities?name=<name>[&channel=<channel>]` — queries the
     * gateway control plane for a named capability CRD. Returns the enabled
     * state and optional metadata (quotas, feature flags, bundle version).
     *
     * NOTE: The /api/capabilities route has not yet landed on the gateway.
     * useCapability() catches 404 from this method and falls back to optimistic
     * enabled=true so existing UI code continues to work without gating.
     *
     * When the route ships, it will be gated by service-auth HMAC — wire
     * `SERVICE_AUTH_SECRET` in the gateway helm chart and provide matching
     * `serviceAuthSecret` + `serviceAuthClientId` to this client.
     */
    getCapability(name: string, channel?: string): Promise<{
        enabled: boolean;
        version?: string;
        metadata?: Record<string, unknown>;
    }>;
    private request;
    private buildUrl;
}
//# sourceMappingURL=GatewayProxyClient.d.ts.map