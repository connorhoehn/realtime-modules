"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyClientTimeoutError = exports.ProxyClientHttpError = exports.ProxyClientNetworkError = exports.ProxyClientError = exports.GatewayProxyClient = void 0;
var GatewayProxyClient_1 = require("./GatewayProxyClient");
Object.defineProperty(exports, "GatewayProxyClient", { enumerable: true, get: function () { return GatewayProxyClient_1.GatewayProxyClient; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ProxyClientError", { enumerable: true, get: function () { return types_1.ProxyClientError; } });
Object.defineProperty(exports, "ProxyClientNetworkError", { enumerable: true, get: function () { return types_1.ProxyClientNetworkError; } });
Object.defineProperty(exports, "ProxyClientHttpError", { enumerable: true, get: function () { return types_1.ProxyClientHttpError; } });
Object.defineProperty(exports, "ProxyClientTimeoutError", { enumerable: true, get: function () { return types_1.ProxyClientTimeoutError; } });
//# sourceMappingURL=index.js.map