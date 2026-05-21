"use strict";
// realtime-modules/src/call/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/call`.
//
// Wave 2 catch-up lift: hangout/call invite signaling. WS fan-out only —
// no WebRTC, no SDP, no SFU media plane (that lives in
// live-video-streaming). See CallService.ts for the lift notes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallManifest = exports.ALLOWED_CALL_ACTIONS = exports.CallService = void 0;
var CallService_1 = require("./CallService");
Object.defineProperty(exports, "CallService", { enumerable: true, get: function () { return CallService_1.CallService; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ALLOWED_CALL_ACTIONS", { enumerable: true, get: function () { return types_1.ALLOWED_CALL_ACTIONS; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "CallManifest", { enumerable: true, get: function () { return manifest_1.CallManifest; } });
//# sourceMappingURL=index.js.map