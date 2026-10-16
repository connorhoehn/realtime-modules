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
/**
 * The chat channel for the main meeting or one of its rooms (0.126.0). A
 * room's chat is named exactly like its media lobby, so the guard a host
 * already runs for breakout lobbies (`admitsBreakoutLobby` /
 * `admitsBreakoutLobbySync`) answers for the room's chat too: members and
 * organizers read and post, everyone else is refused. The main meeting's chat
 * is the meeting id itself.
 */
export declare function meetingChatChannel(meetingId: string, roomId?: string | null): string;
/**
 * The chat a participant should be reading right now: their open room's, or
 * the meeting's. Moves with them exactly as `activeMeetingLobby` moves media.
 */
export declare function activeMeetingChat(meetingId: string, breakout: BreakoutState, userId: string | null | undefined): string;
export interface ParsedBreakoutChannel {
    base: string;
    roomId: string;
}
/**
 * A breakout room's chat under a host's own chat naming (0.134.0, lane L3).
 * A host that names a call's chat something other than its lobby (the app's
 * `orgiq:huddle:<callId>`) gets the room's chat as that channel plus the same
 * suffix a room's lobby carries: `<base>~breakout~<roomId>`. Guards strip the
 * suffix with `parseBreakoutChannel` before matching channel families.
 */
export declare function breakoutChannel(base: string, roomId: string): string;
/** The base channel and room a breakout chat names, or null for any other channel. */
export declare function parseBreakoutChannel(name: string | null | undefined): ParsedBreakoutChannel | null;
//# sourceMappingURL=lobby.d.ts.map