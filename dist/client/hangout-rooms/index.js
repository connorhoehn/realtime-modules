"use strict";
// realtime-modules/src/client/hangout-rooms/index.ts
//
// Public barrel for the @connorhoehn/realtime-modules/client/hangout-rooms
// subpath. Consumer apps (gateway frontend, OrgIQ, etc.) import the
// hooks + types from here. The REST `api.ts` functions are also
// re-exported so non-React callers (SSR, scripts) can use the same
// transport directly without pulling in React.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useRoomMembers = exports.useRoomOccupancy = exports.useHangoutRooms = exports.updateRoom = exports.removeMember = exports.listRooms = exports.listMembers = exports.leaveRoom = exports.joinRoom = exports.getRoom = exports.createRoom = exports.archiveRoom = exports.addMember = exports.RoomApiError = void 0;
// REST client (pure — no React)
var api_1 = require("./api");
Object.defineProperty(exports, "RoomApiError", { enumerable: true, get: function () { return api_1.RoomApiError; } });
Object.defineProperty(exports, "addMember", { enumerable: true, get: function () { return api_1.addMember; } });
Object.defineProperty(exports, "archiveRoom", { enumerable: true, get: function () { return api_1.archiveRoom; } });
Object.defineProperty(exports, "createRoom", { enumerable: true, get: function () { return api_1.createRoom; } });
Object.defineProperty(exports, "getRoom", { enumerable: true, get: function () { return api_1.getRoom; } });
Object.defineProperty(exports, "joinRoom", { enumerable: true, get: function () { return api_1.joinRoom; } });
Object.defineProperty(exports, "leaveRoom", { enumerable: true, get: function () { return api_1.leaveRoom; } });
Object.defineProperty(exports, "listMembers", { enumerable: true, get: function () { return api_1.listMembers; } });
Object.defineProperty(exports, "listRooms", { enumerable: true, get: function () { return api_1.listRooms; } });
Object.defineProperty(exports, "removeMember", { enumerable: true, get: function () { return api_1.removeMember; } });
Object.defineProperty(exports, "updateRoom", { enumerable: true, get: function () { return api_1.updateRoom; } });
// Hooks
var useHangoutRooms_1 = require("./useHangoutRooms");
Object.defineProperty(exports, "useHangoutRooms", { enumerable: true, get: function () { return useHangoutRooms_1.useHangoutRooms; } });
var useRoomOccupancy_1 = require("./useRoomOccupancy");
Object.defineProperty(exports, "useRoomOccupancy", { enumerable: true, get: function () { return useRoomOccupancy_1.useRoomOccupancy; } });
var useRoomMembers_1 = require("./useRoomMembers");
Object.defineProperty(exports, "useRoomMembers", { enumerable: true, get: function () { return useRoomMembers_1.useRoomMembers; } });
//# sourceMappingURL=index.js.map