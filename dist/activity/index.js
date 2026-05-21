"use strict";
// realtime-modules/src/activity/index.ts
//
// Subpath entry — `@connorhoehn/realtime-modules/activity`.
//
// Lifted from gateway/src/realtime-fanout/activity-service.ts in Wave 2.
// Consumers wire an `ActivityHistoryStore` (defaults to
// InMemoryActivityHistoryStore) and an `ActivityMessageRouter` and get a
// ready-to-go ActivityService.
//
// What's left in gateway (not part of the lifted surface):
//   - EventCatalog `setEventCatalog` setter + durable `activity.recorded`
//     publish-with-retry path (depends on EC client which is gateway-
//     owned),
//   - Concrete Redis-backed ActivityHistoryStore adapter (stays in
//     gateway, satisfies the interface exported here).
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = exports.ActivityManifest = exports.InMemoryActivityHistoryStore = exports.ActivityService = void 0;
var ActivityService_1 = require("./ActivityService");
Object.defineProperty(exports, "ActivityService", { enumerable: true, get: function () { return ActivityService_1.ActivityService; } });
var ActivityHistoryStore_1 = require("./ActivityHistoryStore");
Object.defineProperty(exports, "InMemoryActivityHistoryStore", { enumerable: true, get: function () { return ActivityHistoryStore_1.InMemoryActivityHistoryStore; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "ActivityManifest", { enumerable: true, get: function () { return manifest_1.ActivityManifest; } });
var ActivityService_2 = require("./ActivityService");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(ActivityService_2).default; } });
//# sourceMappingURL=index.js.map