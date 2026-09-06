"use strict";
// realtime-modules/src/call/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/call`.
//
// v0.18.0 — the evolved CallService came home. The gateway forked the
// v0.6-era ancestor and grew it 5.5x in-tree (invite dedup, state stores,
// cross-node departure pub/sub, sweeper leadership, tracing seam); that
// implementation now lives here, with app couplings expressed as injected
// options (withSpan, stateStore, crossNodePubSub, sweeperIsLeader,
// onSweepSkipped) so the library stays dependency-light. The gateway keeps
// its DDB session-binding repository, Redis wiring and HTTP routes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallManifest = exports.shouldKnockToJoin = exports.dmLobbyMembers = exports.isDmLobby = exports.channelForLobby = exports.lobbyForChannel = exports.RedisCallStateStore = exports.InMemoryCallStateStore = exports.isParticipantStateBroadcast = exports.ALLOWED_CALL_ACTIONS = exports.CallService = void 0;
var CallService_1 = require("./CallService");
Object.defineProperty(exports, "CallService", { enumerable: true, get: function () { return CallService_1.CallService; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ALLOWED_CALL_ACTIONS", { enumerable: true, get: function () { return types_1.ALLOWED_CALL_ACTIONS; } });
Object.defineProperty(exports, "isParticipantStateBroadcast", { enumerable: true, get: function () { return types_1.isParticipantStateBroadcast; } });
var CallStateStore_1 = require("./CallStateStore");
Object.defineProperty(exports, "InMemoryCallStateStore", { enumerable: true, get: function () { return CallStateStore_1.InMemoryCallStateStore; } });
Object.defineProperty(exports, "RedisCallStateStore", { enumerable: true, get: function () { return CallStateStore_1.RedisCallStateStore; } });
// The call ↔ conversation mapping, in both directions. Exported because both
// the gateway (posting a finished call into its thread) and the frontend
// (listing a conversation's recordings) need it, and two copies of one rule
// drift silently.
var lobbyChannel_1 = require("./lobbyChannel");
Object.defineProperty(exports, "lobbyForChannel", { enumerable: true, get: function () { return lobbyChannel_1.lobbyForChannel; } });
Object.defineProperty(exports, "channelForLobby", { enumerable: true, get: function () { return lobbyChannel_1.channelForLobby; } });
Object.defineProperty(exports, "isDmLobby", { enumerable: true, get: function () { return lobbyChannel_1.isDmLobby; } });
Object.defineProperty(exports, "dmLobbyMembers", { enumerable: true, get: function () { return lobbyChannel_1.dmLobbyMembers; } });
Object.defineProperty(exports, "shouldKnockToJoin", { enumerable: true, get: function () { return lobbyChannel_1.shouldKnockToJoin; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "CallManifest", { enumerable: true, get: function () { return manifest_1.CallManifest; } });
//# sourceMappingURL=index.js.map