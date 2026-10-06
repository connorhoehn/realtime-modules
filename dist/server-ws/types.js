"use strict";
// realtime-modules/src/server-ws/types.ts
//
// Contract types for the createWsHandler factory. Service classes
// already shipped by this package (PresenceService, ChatService,
// ReactionsService, CRDTService, ...) fulfill WsService structurally
// via their existing `handleAction(clientId, action, data)` method.
//
// The handler does not depend on Node's `http` types directly (avoids a
// hard @types/node import in package consumers); instead it accepts a
// minimal `WsHttpServer` shape that real `http.Server` + `https.Server`
// instances satisfy.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WS_MAX_PAYLOAD = exports.DEFAULT_INDEPENDENT_SERVICES = void 0;
/** Default {@link WsHandlerOptions.independentServices}. */
exports.DEFAULT_INDEPENDENT_SERVICES = ['presence'];
/** Default `maxPayload` for `createWsHandler` / `attachRealtime`: 16 MiB. */
exports.DEFAULT_WS_MAX_PAYLOAD = 16 * 1024 * 1024;
//# sourceMappingURL=types.js.map