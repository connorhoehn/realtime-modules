import { type BreakoutState } from './types';
export declare const BREAKOUT_LOBBY_SEPARATOR = "~breakout~";
/** `<meetingId>~breakout~<roomId>` */
export declare function breakoutLobbyName(meetingId: string, roomId: string): string;
export interface ParsedBreakoutLobby {
    meetingId: string;
    roomId: string;
}
/** The meeting and room a breakout lobby names, or null for any other lobby. */
export declare function parseBreakoutLobby(lobby: string | null | undefined): ParsedBreakoutLobby | null;
export declare function isBreakoutLobby(lobby: string | null | undefined): boolean;
/** The open room `userId` belongs in right now, or null for the main meeting. */
export declare function breakoutRoomFor(breakout: BreakoutState, userId: string | null | undefined): string | null;
/**
 * The lobby a participant's media should be in: their open breakout room's,
 * or the meeting's own. Hand this to useLVSHangout / the conversation call.
 */
export declare function activeMeetingLobby(meetingId: string, breakout: BreakoutState, userId: string | null | undefined): string;
//# sourceMappingURL=lobby.d.ts.map