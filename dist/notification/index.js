"use strict";
// realtime-modules/src/notification/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/notification`.
//
// v0.18.0 — extracted verbatim from websocket-gateway (the module was
// already dependency-pure: the Redis client is an injected interface).
// The gateway keeps its HTTP notify-route and Redis client construction.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_TTL_SEC = exports.NOTIFICATION_MAX_PER_USER = exports.RedisNotificationStore = exports.NotificationService = void 0;
var NotificationService_1 = require("./NotificationService");
Object.defineProperty(exports, "NotificationService", { enumerable: true, get: function () { return NotificationService_1.NotificationService; } });
var RedisNotificationStore_1 = require("./RedisNotificationStore");
Object.defineProperty(exports, "RedisNotificationStore", { enumerable: true, get: function () { return RedisNotificationStore_1.RedisNotificationStore; } });
__exportStar(require("./types"), exports);
var constants_1 = require("./constants");
Object.defineProperty(exports, "NOTIFICATION_MAX_PER_USER", { enumerable: true, get: function () { return constants_1.NOTIFICATION_MAX_PER_USER; } });
Object.defineProperty(exports, "NOTIFICATION_TTL_SEC", { enumerable: true, get: function () { return constants_1.NOTIFICATION_TTL_SEC; } });
//# sourceMappingURL=index.js.map