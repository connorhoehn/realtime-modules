// realtime-modules/src/proxy-client/index.ts
//
// Barrel for the HTTP-shim subpath. Importable as:
//   import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';
//
// Lambda-native apps (OrgIQ, future App #3) use this to interact with
// gateway-hosted features over REST without speaking WebSocket.
//
// See ./GatewayProxyClient.ts for the endpoint matrix (what gateway exposes
// today vs. the stub methods waiting on gateway-side REST routes).

export { GatewayProxyClient } from './GatewayProxyClient';
export {
    ProxyClientError,
    ProxyClientNetworkError,
    ProxyClientHttpError,
    ProxyClientTimeoutError,
} from './types';
export type {
    ProxyClientOptions,
    GatewayHealthResponse,
    GatewayClusterInfo,
    GatewayStatsResponse,
    GatewayMetricsResponse,
    PipelineWebhookResponse,
    TriggerPipelineWebhookOptions,
    ChatMessage,
    PresenceEntry,
    PresenceStatus,
    ActivityEvent,
} from './types';
