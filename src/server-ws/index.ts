// realtime-modules/src/server-ws/index.ts
//
// @connorhoehn/realtime-modules/server-ws — barrel export.
//
// Wave 3 — server-side WebSocket handler factory paired with the
// ./client useWebSocket hook. Lazy-loads `ws` so consumers without
// server-side code never pay the import cost.

export { createWsHandler } from './createWsHandler';
export { DEFAULT_WS_MAX_PAYLOAD, DEFAULT_INDEPENDENT_SERVICES } from './types';
export type {
    WsService,
    WsAuthFn,
    WsAuthContext,
    WsHandlerOptions,
    WsHandlerHandle,
    WsHttpServer,
} from './types';
export type { AuthSender, ResolveSender } from './senderIdentity';
export { splitServiceChannel, baseChannel, SERVICE_CHANNEL_PREFIXES } from './channelAccess';
export type { ServiceChannelPrefix, ChannelAccessKind } from './channelAccess';
export { createAuthorityScope, publishProofKey, revokePublishProofs, PUBLISH_PROOF_SKEW_MS } from './authorityScope';
export type { AuthorityScope } from './authorityScope';
