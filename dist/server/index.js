"use strict";
// realtime-modules/src/server/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/server`.
//
// Backend CRDT toolkit lifted from gateway's src/realtime-fanout/ in
// CRDT Cut 1. Consumers wire a `SnapshotStore`, `MetadataStore`,
// `HotCache`, and `MessageRouterContract` (all defined in
// `./stores`) and get a ready-to-go CRDTService orchestrator.
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseChannel = exports.splitServiceChannel = exports.DEFAULT_INDEPENDENT_SERVICES = exports.DEFAULT_WS_MAX_PAYLOAD = exports.RedisDeadlineError = exports.LeaseFencedError = exports.LeaseHeldError = exports.createBoundedRedis = exports.BoundedRedis = exports.RedisPeerRegistry = exports.ReadinessGate = exports.LeaseGroup = exports.FencedLease = exports.RedisRealtimeRouter = exports.liveUsersOnChannel = exports.PLUGIN_SCOPE_RETAIN_MAX_MS = exports.LocalRealtimeRouter = exports.collabDocs = exports.fileUploads = exports.notifications = exports.rooms = exports.typedDocuments = exports.workGraph = exports.pipeline = exports.ingest = exports.calls = exports.social = exports.activity = exports.reactions = exports.cursor = exports.presence = exports.chat = exports.defineFeature = exports.attachRealtime = exports.inMemoryAdapters = exports.createRealtimeServer = exports.crdtManifest = exports.config = exports.MemorySnapshotStore = exports.MemoryMetadataStore = exports.MemoryHotCache = exports.createSubscribeService = exports.SubscribeService = exports.AwarenessLedger = exports.IdleEvictionManager = exports.AwarenessCoalescer = exports.DocumentPresenceService = exports.DocumentMetadataService = exports.SnapshotManager = exports.CRDTService = void 0;
exports.exportCanvasProjection = exports.createCanvasSeed = exports.dmLobbyAdmits = exports.WorkGraphStreamService = exports.PUBLISH_PROOF_SKEW_MS = exports.revokePublishProofs = exports.publishProofKey = exports.createAuthorityScope = exports.SERVICE_CHANNEL_PREFIXES = void 0;
const CRDTService_1 = __importDefault(require("./CRDTService"));
exports.CRDTService = CRDTService_1.default;
const SnapshotManager_1 = __importDefault(require("./SnapshotManager"));
exports.SnapshotManager = SnapshotManager_1.default;
const DocumentMetadataService_1 = __importDefault(require("./DocumentMetadataService"));
exports.DocumentMetadataService = DocumentMetadataService_1.default;
const DocumentPresenceService_1 = __importDefault(require("./DocumentPresenceService"));
exports.DocumentPresenceService = DocumentPresenceService_1.default;
const AwarenessCoalescer_1 = __importDefault(require("./AwarenessCoalescer"));
exports.AwarenessCoalescer = AwarenessCoalescer_1.default;
const IdleEvictionManager_1 = __importDefault(require("./IdleEvictionManager"));
exports.IdleEvictionManager = IdleEvictionManager_1.default;
// CRDTServiceOpts.awarenessLedger is an AwarenessLedger — named in an
// exported signature while being importable from no published entry point.
//
// PresenceMode has the same problem and is NOT fixed here:
// DocumentPresenceService uses `export =`, which forbids any other export
// from that module, so exposing it needs a module-shape change rather than
// an export line.
var AwarenessLedger_1 = require("./AwarenessLedger");
Object.defineProperty(exports, "AwarenessLedger", { enumerable: true, get: function () { return AwarenessLedger_1.AwarenessLedger; } });
// The generic multiplexer attachRealtime registers itself. Exported so a
// consumer wiring createWsHandler by hand gets the same channel membership
// service, rather than rediscovering that useWebSocket's subscribe() has
// nothing to talk to.
var subscribeService_1 = require("./subscribeService");
Object.defineProperty(exports, "SubscribeService", { enumerable: true, get: function () { return subscribeService_1.SubscribeService; } });
Object.defineProperty(exports, "createSubscribeService", { enumerable: true, get: function () { return subscribeService_1.createSubscribeService; } });
var MemoryStore_1 = require("./stores/MemoryStore");
Object.defineProperty(exports, "MemoryHotCache", { enumerable: true, get: function () { return MemoryStore_1.MemoryHotCache; } });
Object.defineProperty(exports, "MemoryMetadataStore", { enumerable: true, get: function () { return MemoryStore_1.MemoryMetadataStore; } });
Object.defineProperty(exports, "MemorySnapshotStore", { enumerable: true, get: function () { return MemoryStore_1.MemorySnapshotStore; } });
// Configuration constants, exposed so consumers can override windows
// per deployment (e.g. for soak tests).
exports.config = __importStar(require("./config"));
// FeatureManifest — apps read this to discover env vars + channels.
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "crdtManifest", { enumerable: true, get: function () { return manifest_1.crdtManifest; } });
// Zero-config factory — createRealtimeServer + inMemoryAdapters.
var factory_1 = require("./factory");
Object.defineProperty(exports, "createRealtimeServer", { enumerable: true, get: function () { return factory_1.createRealtimeServer; } });
Object.defineProperty(exports, "inMemoryAdapters", { enumerable: true, get: function () { return factory_1.inMemoryAdapters; } });
// ---- pluggable composition layer (v0.19.0) ------------------------------------
// attachRealtime + defineFeature + the thirteen built-in features, plus the
// swappable router contract. See attach.ts for the design principles.
var attach_1 = require("./attach");
Object.defineProperty(exports, "attachRealtime", { enumerable: true, get: function () { return attach_1.attachRealtime; } });
Object.defineProperty(exports, "defineFeature", { enumerable: true, get: function () { return attach_1.defineFeature; } });
Object.defineProperty(exports, "chat", { enumerable: true, get: function () { return attach_1.chat; } });
Object.defineProperty(exports, "presence", { enumerable: true, get: function () { return attach_1.presence; } });
Object.defineProperty(exports, "cursor", { enumerable: true, get: function () { return attach_1.cursor; } });
Object.defineProperty(exports, "reactions", { enumerable: true, get: function () { return attach_1.reactions; } });
Object.defineProperty(exports, "activity", { enumerable: true, get: function () { return attach_1.activity; } });
Object.defineProperty(exports, "social", { enumerable: true, get: function () { return attach_1.social; } });
Object.defineProperty(exports, "calls", { enumerable: true, get: function () { return attach_1.calls; } });
Object.defineProperty(exports, "ingest", { enumerable: true, get: function () { return attach_1.ingest; } });
Object.defineProperty(exports, "pipeline", { enumerable: true, get: function () { return attach_1.pipeline; } });
Object.defineProperty(exports, "workGraph", { enumerable: true, get: function () { return attach_1.workGraph; } });
Object.defineProperty(exports, "typedDocuments", { enumerable: true, get: function () { return attach_1.typedDocuments; } });
Object.defineProperty(exports, "rooms", { enumerable: true, get: function () { return attach_1.rooms; } });
Object.defineProperty(exports, "notifications", { enumerable: true, get: function () { return attach_1.notifications; } });
Object.defineProperty(exports, "fileUploads", { enumerable: true, get: function () { return attach_1.fileUploads; } });
Object.defineProperty(exports, "collabDocs", { enumerable: true, get: function () { return attach_1.collabDocs; } });
var router_1 = require("./router");
Object.defineProperty(exports, "LocalRealtimeRouter", { enumerable: true, get: function () { return router_1.LocalRealtimeRouter; } });
Object.defineProperty(exports, "PLUGIN_SCOPE_RETAIN_MAX_MS", { enumerable: true, get: function () { return router_1.PLUGIN_SCOPE_RETAIN_MAX_MS; } });
Object.defineProperty(exports, "liveUsersOnChannel", { enumerable: true, get: function () { return router_1.liveUsersOnChannel; } });
var RedisRealtimeRouter_1 = require("./RedisRealtimeRouter");
Object.defineProperty(exports, "RedisRealtimeRouter", { enumerable: true, get: function () { return RedisRealtimeRouter_1.RedisRealtimeRouter; } });
// 0.117: the fenced-ownership primitives the router is built on, re-exported
// so a host composes LeaseGroup / ReadinessGate / BoundedRedis from the same
// distributed-core copy the router uses.
var leases_1 = require("distributed-core/cluster/leases");
Object.defineProperty(exports, "FencedLease", { enumerable: true, get: function () { return leases_1.FencedLease; } });
Object.defineProperty(exports, "LeaseGroup", { enumerable: true, get: function () { return leases_1.LeaseGroup; } });
Object.defineProperty(exports, "ReadinessGate", { enumerable: true, get: function () { return leases_1.ReadinessGate; } });
Object.defineProperty(exports, "RedisPeerRegistry", { enumerable: true, get: function () { return leases_1.RedisPeerRegistry; } });
Object.defineProperty(exports, "BoundedRedis", { enumerable: true, get: function () { return leases_1.BoundedRedis; } });
Object.defineProperty(exports, "createBoundedRedis", { enumerable: true, get: function () { return leases_1.createBoundedRedis; } });
Object.defineProperty(exports, "LeaseHeldError", { enumerable: true, get: function () { return leases_1.LeaseHeldError; } });
Object.defineProperty(exports, "LeaseFencedError", { enumerable: true, get: function () { return leases_1.LeaseFencedError; } });
Object.defineProperty(exports, "RedisDeadlineError", { enumerable: true, get: function () { return leases_1.RedisDeadlineError; } });
const types_1 = require("../server-ws/types");
const channelAccess_1 = require("../server-ws/channelAccess");
const authorityScope_1 = require("../server-ws/authorityScope");
const streamService_1 = require("../work-graph/streamService");
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.DEFAULT_WS_MAX_PAYLOAD = types_1.DEFAULT_WS_MAX_PAYLOAD;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.DEFAULT_INDEPENDENT_SERVICES = types_1.DEFAULT_INDEPENDENT_SERVICES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.splitServiceChannel = channelAccess_1.splitServiceChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.baseChannel = channelAccess_1.baseChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.SERVICE_CHANNEL_PREFIXES = channelAccess_1.SERVICE_CHANNEL_PREFIXES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.createAuthorityScope = authorityScope_1.createAuthorityScope;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.publishProofKey = authorityScope_1.publishProofKey;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.revokePublishProofs = authorityScope_1.revokePublishProofs;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
exports.PUBLISH_PROOF_SKEW_MS = authorityScope_1.PUBLISH_PROOF_SKEW_MS;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
exports.WorkGraphStreamService = streamService_1.WorkGraphStreamService;
// 0.116 — the authority primitives every multi-tenant host wrote by hand:
// the channel-family mechanism, the partition/DM guard, the fresh-per-request
// authority engine, principal revalidation and the bearer subprotocol parser.
__exportStar(require("./authority"), exports);
var lobbyChannel_1 = require("../call/lobbyChannel");
Object.defineProperty(exports, "dmLobbyAdmits", { enumerable: true, get: function () { return lobbyChannel_1.dmLobbyAdmits; } });
__exportStar(require("./documentGrant"), exports);
var canvasSeed_1 = require("./canvasSeed");
Object.defineProperty(exports, "createCanvasSeed", { enumerable: true, get: function () { return canvasSeed_1.createCanvasSeed; } });
Object.defineProperty(exports, "exportCanvasProjection", { enumerable: true, get: function () { return canvasSeed_1.exportCanvasProjection; } });
//# sourceMappingURL=index.js.map