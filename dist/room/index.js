"use strict";
// realtime-modules/src/room/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/room`.
//
// v0.18.0 — extracted from websocket-gateway's realtime-fanout/room, where
// it was born gateway-native (live-video-streaming's rooms were the pull
// signal for making it shared). App couplings are injected options: a
// RoomStateStore (Redis-backed impl included, client interface injected),
// cross-node pub/sub, and RoomMetricsHooks. Deployment glue (Redis client
// construction, CRD authz, HTTP mounts) stays with the consumer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CROSS_NODE_ROOM_TOPIC = exports.ALLOWED_ROOM_ACTIONS = exports.RedisRoomStateStore = exports.InMemoryRoomStateStore = exports.RoomService = void 0;
var RoomService_1 = require("./RoomService");
Object.defineProperty(exports, "RoomService", { enumerable: true, get: function () { return RoomService_1.RoomService; } });
var RoomStateStore_1 = require("./RoomStateStore");
Object.defineProperty(exports, "InMemoryRoomStateStore", { enumerable: true, get: function () { return RoomStateStore_1.InMemoryRoomStateStore; } });
Object.defineProperty(exports, "RedisRoomStateStore", { enumerable: true, get: function () { return RoomStateStore_1.RedisRoomStateStore; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ALLOWED_ROOM_ACTIONS", { enumerable: true, get: function () { return types_1.ALLOWED_ROOM_ACTIONS; } });
Object.defineProperty(exports, "CROSS_NODE_ROOM_TOPIC", { enumerable: true, get: function () { return types_1.CROSS_NODE_ROOM_TOPIC; } });
//# sourceMappingURL=index.js.map