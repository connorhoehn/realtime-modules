"use strict";
// realtime-modules/src/meeting/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/meeting`.
//
// Raised hands and breakout rooms for a call already running on LVS.
// Design: docs/design/meeting-rooms.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.meetingChannel = exports.ORGANIZER_ACTIONS = exports.MEETING_ID_PATTERN = exports.MEETING_CHANNEL_PREFIX = exports.MEETING_ACTIONS = exports.MAX_ROOM_NAME_LENGTH = exports.MAX_DISPLAY_NAME_LENGTH = exports.MAX_ANNOUNCEMENT_LENGTH = exports.EMPTY_BREAKOUT = exports.BREAKOUT_ROOM_ID_PATTERN = exports.parseBreakoutLobby = exports.isBreakoutLobby = exports.breakoutRoomFor = exports.breakoutLobbyName = exports.activeMeetingLobby = exports.BREAKOUT_LOBBY_SEPARATOR = exports.InMemoryMeetingStateStore = exports.MeetingManifest = exports.meeting = exports.MeetingService = void 0;
var MeetingService_1 = require("./MeetingService");
Object.defineProperty(exports, "MeetingService", { enumerable: true, get: function () { return MeetingService_1.MeetingService; } });
var feature_1 = require("./feature");
Object.defineProperty(exports, "meeting", { enumerable: true, get: function () { return feature_1.meeting; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "MeetingManifest", { enumerable: true, get: function () { return manifest_1.MeetingManifest; } });
var MeetingStateStore_1 = require("./MeetingStateStore");
Object.defineProperty(exports, "InMemoryMeetingStateStore", { enumerable: true, get: function () { return MeetingStateStore_1.InMemoryMeetingStateStore; } });
var lobby_1 = require("./lobby");
Object.defineProperty(exports, "BREAKOUT_LOBBY_SEPARATOR", { enumerable: true, get: function () { return lobby_1.BREAKOUT_LOBBY_SEPARATOR; } });
Object.defineProperty(exports, "activeMeetingLobby", { enumerable: true, get: function () { return lobby_1.activeMeetingLobby; } });
Object.defineProperty(exports, "breakoutLobbyName", { enumerable: true, get: function () { return lobby_1.breakoutLobbyName; } });
Object.defineProperty(exports, "breakoutRoomFor", { enumerable: true, get: function () { return lobby_1.breakoutRoomFor; } });
Object.defineProperty(exports, "isBreakoutLobby", { enumerable: true, get: function () { return lobby_1.isBreakoutLobby; } });
Object.defineProperty(exports, "parseBreakoutLobby", { enumerable: true, get: function () { return lobby_1.parseBreakoutLobby; } });
var types_1 = require("./types");
Object.defineProperty(exports, "BREAKOUT_ROOM_ID_PATTERN", { enumerable: true, get: function () { return types_1.BREAKOUT_ROOM_ID_PATTERN; } });
Object.defineProperty(exports, "EMPTY_BREAKOUT", { enumerable: true, get: function () { return types_1.EMPTY_BREAKOUT; } });
Object.defineProperty(exports, "MAX_ANNOUNCEMENT_LENGTH", { enumerable: true, get: function () { return types_1.MAX_ANNOUNCEMENT_LENGTH; } });
Object.defineProperty(exports, "MAX_DISPLAY_NAME_LENGTH", { enumerable: true, get: function () { return types_1.MAX_DISPLAY_NAME_LENGTH; } });
Object.defineProperty(exports, "MAX_ROOM_NAME_LENGTH", { enumerable: true, get: function () { return types_1.MAX_ROOM_NAME_LENGTH; } });
Object.defineProperty(exports, "MEETING_ACTIONS", { enumerable: true, get: function () { return types_1.MEETING_ACTIONS; } });
Object.defineProperty(exports, "MEETING_CHANNEL_PREFIX", { enumerable: true, get: function () { return types_1.MEETING_CHANNEL_PREFIX; } });
Object.defineProperty(exports, "MEETING_ID_PATTERN", { enumerable: true, get: function () { return types_1.MEETING_ID_PATTERN; } });
Object.defineProperty(exports, "ORGANIZER_ACTIONS", { enumerable: true, get: function () { return types_1.ORGANIZER_ACTIONS; } });
Object.defineProperty(exports, "meetingChannel", { enumerable: true, get: function () { return types_1.meetingChannel; } });
//# sourceMappingURL=index.js.map