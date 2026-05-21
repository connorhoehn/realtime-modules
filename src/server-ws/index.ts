// realtime-modules/src/server-ws/index.ts
//
// @connorhoehn/realtime-modules/server-ws — barrel export.
//
// Wave 3 — server-side WebSocket handler factory paired with the
// ./client useWebSocket hook. Lazy-loads `ws` so consumers without
// server-side code never pay the import cost.

export { createWsHandler } from './createWsHandler';
export type {
    WsService,
    WsAuthFn,
    WsAuthContext,
    WsHandlerOptions,
    WsHandlerHandle,
    WsHttpServer,
} from './types';
