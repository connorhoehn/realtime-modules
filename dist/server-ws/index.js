"use strict";
// realtime-modules/src/server-ws/index.ts
//
// @connorhoehn/realtime-modules/server-ws — barrel export.
//
// Wave 3 — server-side WebSocket handler factory paired with the
// ./client useWebSocket hook. Lazy-loads `ws` so consumers without
// server-side code never pay the import cost.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthorityScope = exports.SERVICE_CHANNEL_PREFIXES = exports.baseChannel = exports.splitServiceChannel = exports.DEFAULT_INDEPENDENT_SERVICES = exports.DEFAULT_WS_MAX_PAYLOAD = exports.createWsHandler = void 0;
var createWsHandler_1 = require("./createWsHandler");
Object.defineProperty(exports, "createWsHandler", { enumerable: true, get: function () { return createWsHandler_1.createWsHandler; } });
var types_1 = require("./types");
Object.defineProperty(exports, "DEFAULT_WS_MAX_PAYLOAD", { enumerable: true, get: function () { return types_1.DEFAULT_WS_MAX_PAYLOAD; } });
Object.defineProperty(exports, "DEFAULT_INDEPENDENT_SERVICES", { enumerable: true, get: function () { return types_1.DEFAULT_INDEPENDENT_SERVICES; } });
var channelAccess_1 = require("./channelAccess");
Object.defineProperty(exports, "splitServiceChannel", { enumerable: true, get: function () { return channelAccess_1.splitServiceChannel; } });
Object.defineProperty(exports, "baseChannel", { enumerable: true, get: function () { return channelAccess_1.baseChannel; } });
Object.defineProperty(exports, "SERVICE_CHANNEL_PREFIXES", { enumerable: true, get: function () { return channelAccess_1.SERVICE_CHANNEL_PREFIXES; } });
var authorityScope_1 = require("./authorityScope");
Object.defineProperty(exports, "createAuthorityScope", { enumerable: true, get: function () { return authorityScope_1.createAuthorityScope; } });
//# sourceMappingURL=index.js.map