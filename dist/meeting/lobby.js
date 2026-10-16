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
exports.meetingChatChannel = meetingChatChannel;
exports.activeMeetingChat = activeMeetingChat;
exports.breakoutChannel = breakoutChannel;
exports.parseBreakoutChannel = parseBreakoutChannel;
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
/**
 * The chat channel for the main meeting or one of its rooms (0.126.0). A
 * room's chat is named exactly like its media lobby, so the guard a host
 * already runs for breakout lobbies (`admitsBreakoutLobby` /
 * `admitsBreakoutLobbySync`) answers for the room's chat too: members and
 * organizers read and post, everyone else is refused. The main meeting's chat
 * is the meeting id itself.
 */
function meetingChatChannel(meetingId, roomId) {
    return roomId ? breakoutLobbyName(meetingId, roomId) : meetingId;
}
/**
 * The chat a participant should be reading right now: their open room's, or
 * the meeting's. Moves with them exactly as `activeMeetingLobby` moves media.
 */
function activeMeetingChat(meetingId, breakout, userId) {
    return meetingChatChannel(meetingId, breakoutRoomFor(breakout, userId));
}
/**
 * A breakout room's chat under a host's own chat naming (0.134.0, lane L3).
 * A host that names a call's chat something other than its lobby (the app's
 * `orgiq:huddle:<callId>`) gets the room's chat as that channel plus the same
 * suffix a room's lobby carries: `<base>~breakout~<roomId>`. Guards strip the
 * suffix with `parseBreakoutChannel` before matching channel families.
 */
function breakoutChannel(base, roomId) {
    return `${base}${exports.BREAKOUT_LOBBY_SEPARATOR}${roomId}`;
}
/** The base channel and room a breakout chat names, or null for any other channel. */
function parseBreakoutChannel(name) {
    if (typeof name !== 'string')
        return null;
    const at = name.lastIndexOf(exports.BREAKOUT_LOBBY_SEPARATOR);
    if (at <= 0)
        return null;
    const base = name.slice(0, at);
    const roomId = name.slice(at + exports.BREAKOUT_LOBBY_SEPARATOR.length);
    if (!types_1.BREAKOUT_ROOM_ID_PATTERN.test(roomId))
        return null;
    return { base, roomId };
}
//# sourceMappingURL=lobby.js.map