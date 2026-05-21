"use strict";
// realtime-modules/src/server-ws/index.ts
//
// @connorhoehn/realtime-modules/server-ws — barrel export.
//
// Wave 3 — server-side WebSocket handler factory paired with the
// ./client useWebSocket hook. Lazy-loads `ws` so consumers without
// server-side code never pay the import cost.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWsHandler = void 0;
var createWsHandler_1 = require("./createWsHandler");
Object.defineProperty(exports, "createWsHandler", { enumerable: true, get: function () { return createWsHandler_1.createWsHandler; } });
//# sourceMappingURL=index.js.map