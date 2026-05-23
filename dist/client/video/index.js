"use strict";
// Public barrel for the @connorhoehn/realtime-modules/client/video
// subpath. Consumers import the hooks + context + low-level transport
// from here. Internal lib/* modules stay unexported — callers should
// reach for the hooks first; transport helpers are surfaced for
// advanced cases (custom retry, headless tests).
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyNetQ = exports.formatBitrate = exports.waitForIceGather = exports.decodeArn = exports.decodeJwt = exports.LVSApiError = exports.fetchIceServers = exports.whepPublish = exports.whipPublish = exports.useLiveCaptions = exports.useLVSHlsPlayer = exports.useLVSRecordings = exports.useLVSHangout = exports.useLVSSubscriber = exports.useLVSPublisher = exports.useLVSContext = exports.LVSProvider = void 0;
var LVSProvider_1 = require("./LVSProvider");
Object.defineProperty(exports, "LVSProvider", { enumerable: true, get: function () { return LVSProvider_1.LVSProvider; } });
Object.defineProperty(exports, "useLVSContext", { enumerable: true, get: function () { return LVSProvider_1.useLVSContext; } });
var useLVSPublisher_1 = require("./useLVSPublisher");
Object.defineProperty(exports, "useLVSPublisher", { enumerable: true, get: function () { return useLVSPublisher_1.useLVSPublisher; } });
var useLVSSubscriber_1 = require("./useLVSSubscriber");
Object.defineProperty(exports, "useLVSSubscriber", { enumerable: true, get: function () { return useLVSSubscriber_1.useLVSSubscriber; } });
var useLVSHangout_1 = require("./useLVSHangout");
Object.defineProperty(exports, "useLVSHangout", { enumerable: true, get: function () { return useLVSHangout_1.useLVSHangout; } });
var useLVSRecordings_1 = require("./useLVSRecordings");
Object.defineProperty(exports, "useLVSRecordings", { enumerable: true, get: function () { return useLVSRecordings_1.useLVSRecordings; } });
var useLVSHlsPlayer_1 = require("./useLVSHlsPlayer");
Object.defineProperty(exports, "useLVSHlsPlayer", { enumerable: true, get: function () { return useLVSHlsPlayer_1.useLVSHlsPlayer; } });
var useLiveCaptions_1 = require("./useLiveCaptions");
Object.defineProperty(exports, "useLiveCaptions", { enumerable: true, get: function () { return useLiveCaptions_1.useLiveCaptions; } });
// Transport re-exports for advanced consumers (custom WHIP retry loops,
// SSR-shimmed fetch in tests). The hooks above own the common path.
var transport_1 = require("./lib/transport");
Object.defineProperty(exports, "whipPublish", { enumerable: true, get: function () { return transport_1.whipPublish; } });
Object.defineProperty(exports, "whepPublish", { enumerable: true, get: function () { return transport_1.whepPublish; } });
Object.defineProperty(exports, "fetchIceServers", { enumerable: true, get: function () { return transport_1.fetchIceServers; } });
Object.defineProperty(exports, "LVSApiError", { enumerable: true, get: function () { return transport_1.LVSApiError; } });
var jwt_1 = require("./lib/jwt");
Object.defineProperty(exports, "decodeJwt", { enumerable: true, get: function () { return jwt_1.decodeJwt; } });
Object.defineProperty(exports, "decodeArn", { enumerable: true, get: function () { return jwt_1.decodeArn; } });
var sdp_1 = require("./lib/sdp");
Object.defineProperty(exports, "waitForIceGather", { enumerable: true, get: function () { return sdp_1.waitForIceGather; } });
Object.defineProperty(exports, "formatBitrate", { enumerable: true, get: function () { return sdp_1.formatBitrate; } });
Object.defineProperty(exports, "classifyNetQ", { enumerable: true, get: function () { return sdp_1.classifyNetQ; } });
//# sourceMappingURL=index.js.map