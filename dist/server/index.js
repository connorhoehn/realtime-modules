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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inMemoryAdapters = exports.createRealtimeServer = exports.crdtManifest = exports.config = exports.MemorySnapshotStore = exports.MemoryMetadataStore = exports.MemoryHotCache = exports.IdleEvictionManager = exports.AwarenessCoalescer = exports.DocumentPresenceService = exports.DocumentMetadataService = exports.SnapshotManager = exports.CRDTService = void 0;
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
//# sourceMappingURL=index.js.map