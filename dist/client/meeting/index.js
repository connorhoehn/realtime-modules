"use strict";
// realtime-modules/src/client/meeting/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/client/meeting`.
// Raised hands and breakout rooms for a call on LVS — the client half of the
// `meeting` service (`./meeting`). Design: docs/design/meeting-rooms.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBreakoutLobby = exports.isBreakoutLobby = exports.breakoutRoomFor = exports.breakoutLobbyName = exports.activeMeetingLobby = exports.BREAKOUT_LOBBY_SEPARATOR = exports.unassignedUsers = exports.meetingReducer = exports.handPosition = exports.breakoutRemainingMs = exports.INITIAL_MEETING_STATE = exports.useMeeting = void 0;
var useMeeting_1 = require("./useMeeting");
Object.defineProperty(exports, "useMeeting", { enumerable: true, get: function () { return useMeeting_1.useMeeting; } });
var reducer_1 = require("./reducer");
Object.defineProperty(exports, "INITIAL_MEETING_STATE", { enumerable: true, get: function () { return reducer_1.INITIAL_MEETING_STATE; } });
Object.defineProperty(exports, "breakoutRemainingMs", { enumerable: true, get: function () { return reducer_1.breakoutRemainingMs; } });
Object.defineProperty(exports, "handPosition", { enumerable: true, get: function () { return reducer_1.handPosition; } });
Object.defineProperty(exports, "meetingReducer", { enumerable: true, get: function () { return reducer_1.meetingReducer; } });
Object.defineProperty(exports, "unassignedUsers", { enumerable: true, get: function () { return reducer_1.unassignedUsers; } });
var lobby_1 = require("../../meeting/lobby");
Object.defineProperty(exports, "BREAKOUT_LOBBY_SEPARATOR", { enumerable: true, get: function () { return lobby_1.BREAKOUT_LOBBY_SEPARATOR; } });
Object.defineProperty(exports, "activeMeetingLobby", { enumerable: true, get: function () { return lobby_1.activeMeetingLobby; } });
Object.defineProperty(exports, "breakoutLobbyName", { enumerable: true, get: function () { return lobby_1.breakoutLobbyName; } });
Object.defineProperty(exports, "breakoutRoomFor", { enumerable: true, get: function () { return lobby_1.breakoutRoomFor; } });
Object.defineProperty(exports, "isBreakoutLobby", { enumerable: true, get: function () { return lobby_1.isBreakoutLobby; } });
Object.defineProperty(exports, "parseBreakoutLobby", { enumerable: true, get: function () { return lobby_1.parseBreakoutLobby; } });
//# sourceMappingURL=index.js.map