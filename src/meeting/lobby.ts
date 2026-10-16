// realtime-modules/src/meeting/lobby.ts
//
// A breakout room's media is an ordinary LVS hangout. Its lobby name is
// derived from the meeting's lobby (which IS the meetingId), so a host's lobby
// guard can map it back to the meeting and ask MeetingService whether the user
// belongs there. Pure: safe in the browser and on the server.

import { BREAKOUT_ROOM_ID_PATTERN, type BreakoutState } from './types';

export const BREAKOUT_LOBBY_SEPARATOR = '~breakout~';

/** `<meetingId>~breakout~<roomId>` */
export function breakoutLobbyName(meetingId: string, roomId: string): string {
    return `${meetingId}${BREAKOUT_LOBBY_SEPARATOR}${roomId}`;
}

export interface ParsedBreakoutLobby {
    meetingId: string;
    roomId: string;
}

/** The meeting and room a breakout lobby names, or null for any other lobby. */
export function parseBreakoutLobby(lobby: string | null | undefined): ParsedBreakoutLobby | null {
    if (typeof lobby !== 'string') return null;
    const at = lobby.lastIndexOf(BREAKOUT_LOBBY_SEPARATOR);
    if (at <= 0) return null;
    const meetingId = lobby.slice(0, at);
    const roomId = lobby.slice(at + BREAKOUT_LOBBY_SEPARATOR.length);
    if (!BREAKOUT_ROOM_ID_PATTERN.test(roomId)) return null;
    return { meetingId, roomId };
}

export function isBreakoutLobby(lobby: string | null | undefined): boolean {
    return parseBreakoutLobby(lobby) !== null;
}

/** The open room `userId` belongs in right now, or null for the main meeting. */
export function breakoutRoomFor(breakout: BreakoutState, userId: string | null | undefined): string | null {
    if (!userId || breakout.phase !== 'open') return null;
    if (breakout.returned.includes(userId)) return null;
    const room = breakout.rooms.find((r) => r.state === 'open' && r.members.includes(userId));
    return room ? room.id : null;
}

/**
 * The lobby a participant's media should be in: their open breakout room's,
 * or the meeting's own. Hand this to useLVSHangout / the conversation call.
 */
export function activeMeetingLobby(
    meetingId: string,
    breakout: BreakoutState,
    userId: string | null | undefined,
): string {
    const roomId = breakoutRoomFor(breakout, userId);
    return roomId ? breakoutLobbyName(meetingId, roomId) : meetingId;
}
