"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useFeatures = exports.useGateway = exports.GatewaySocketProvider = exports.useWebSocket = void 0;
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
//# sourceMappingURL=ws.js.map