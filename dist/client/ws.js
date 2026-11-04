"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSharedWebSocket = exports.useSharedSocketTransport = exports.defaultChannelService = exports.createSharedSocketTransport = exports.useFeatures = exports.useGateway = exports.GatewaySocketProvider = exports.useWebSocket = void 0;
// Non-CRDT WebSocket surface — safe to import without yjs / y-protocols.
// Use this subpath (./client/ws) when you only need useWebSocket and its
// types. The ./client barrel re-exports GatewayProvider which has a hard
// yjs/y-protocols dependency; consumers that don't use CRDT must not import
// from ./client directly.
//
// GatewaySocketProvider is included here because it only depends on
// useWebSocket (no yjs / y-protocols imports) and is the recommended
// zero-config way to wire the WS connection in React apps.
var useWebSocket_1 = require("./useWebSocket");
Object.defineProperty(exports, "useWebSocket", { enumerable: true, get: function () { return useWebSocket_1.useWebSocket; } });
var GatewaySocketProvider_1 = require("./GatewaySocketProvider");
Object.defineProperty(exports, "GatewaySocketProvider", { enumerable: true, get: function () { return GatewaySocketProvider_1.GatewaySocketProvider; } });
Object.defineProperty(exports, "useGateway", { enumerable: true, get: function () { return GatewaySocketProvider_1.useGateway; } });
Object.defineProperty(exports, "useFeatures", { enumerable: true, get: function () { return GatewaySocketProvider_1.useFeatures; } });
// v0.144.0 — one host-owned socket shared by several consumers: fan-out of
// inbound frames, refcounted channel subscriptions, re-subscription per
// session epoch, and adapters for the pipeline hooks' `transport` and
// ui-components' EventStreamProvider `channelTransport`.
var sharedSocketTransport_1 = require("./sharedSocketTransport");
Object.defineProperty(exports, "createSharedSocketTransport", { enumerable: true, get: function () { return sharedSocketTransport_1.createSharedSocketTransport; } });
Object.defineProperty(exports, "defaultChannelService", { enumerable: true, get: function () { return sharedSocketTransport_1.defaultChannelService; } });
var useSharedSocketTransport_1 = require("./useSharedSocketTransport");
Object.defineProperty(exports, "useSharedSocketTransport", { enumerable: true, get: function () { return useSharedSocketTransport_1.useSharedSocketTransport; } });
Object.defineProperty(exports, "useSharedWebSocket", { enumerable: true, get: function () { return useSharedSocketTransport_1.useSharedWebSocket; } });
//# sourceMappingURL=ws.js.map