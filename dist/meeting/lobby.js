"use strict";
// realtime-modules/src/meeting/lobby.ts
//
// A breakout room's media is an ordinary LVS hangout. Its lobby name is
// derived from the meeting's lobby (which IS the meetingId), so a host's lobby
// guard can map it back to the meeting and ask MeetingService whether the user
// belongs there. Pure: safe in the browser and on the server.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BREAKOUT_LOBBY_SEPARATOR = void 0;
exports.breakoutLobbyName = breakoutLobbyName;
exports.parseBreakoutLobby = parseBreakoutLobby;
exports.isBreakoutLobby = isBreakoutLobby;
exports.breakoutRoomFor = breakoutRoomFor;
exports.activeMeetingLobby = activeMeetingLobby;
const types_1 = require("./types");
exports.BREAKOUT_LOBBY_SEPARATOR = '~breakout~';
/** `<meetingId>~breakout~<roomId>` */
function breakoutLobbyName(meetingId, roomId) {
    return `${meetingId}${exports.BREAKOUT_LOBBY_SEPARATOR}${roomId}`;
}
/** The meeting and room a breakout lobby names, or null for any other lobby. */
function parseBreakoutLobby(lobby) {
    if (typeof lobby !== 'string')
        return null;
    const at = lobby.lastIndexOf(exports.BREAKOUT_LOBBY_SEPARATOR);
    if (at <= 0)
        return null;
    const meetingId = lobby.slice(0, at);
    const roomId = lobby.slice(at + exports.BREAKOUT_LOBBY_SEPARATOR.length);
    if (!types_1.BREAKOUT_ROOM_ID_PATTERN.test(roomId))
        return null;
    return { meetingId, roomId };
}
function isBreakoutLobby(lobby) {
    return parseBreakoutLobby(lobby) !== null;
}
/** The open room `userId` belongs in right now, or null for the main meeting. */
function breakoutRoomFor(breakout, userId) {
    if (!userId || breakout.phase !== 'open')
        return null;
    if (breakout.returned.includes(userId))
        return null;
    const room = breakout.rooms.find((r) => r.state === 'open' && r.members.includes(userId));
    return room ? room.id : null;
}
/**
 * The lobby a participant's media should be in: their open breakout room's,
 * or the meeting's own. Hand this to useLVSHangout / the conversation call.
 */
function activeMeetingLobby(meetingId, breakout, userId) {
    const roomId = breakoutRoomFor(breakout, userId);
    return roomId ? breakoutLobbyName(meetingId, roomId) : meetingId;
}
//# sourceMappingURL=lobby.js.map