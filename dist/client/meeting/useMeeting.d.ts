import type { GatewayMessage } from '../types';
import type { BreakoutMode, BreakoutRoom, BreakoutState, RaisedHand } from '../../meeting/types';
import { type MeetingClientError, type MeetingClientState } from './reducer';
export interface UseMeetingOptions {
    /** Send/receive handles when the caller owns the socket (see useReactions). */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    };
    /**
     * Shown on your raised hand when the server's auth context carries no
     * display name. The server prefers its own.
     */
    displayName?: string;
    /** Set false to hold the subscription (e.g. before the call is live). Default true. */
    enabled?: boolean;
}
export interface BreakoutRoomDraft {
    id?: string;
    name: string;
    members?: string[];
}
export interface UseMeetingResult {
    state: MeetingClientState;
    ready: boolean;
    error: MeetingClientError | null;
    clearError(): void;
    /** Whether the server treats you as an organizer of this meeting. */
    isOrganizer: boolean;
    hands: RaisedHand[];
    /** Your 1-based place in the queue, or null. */
    myHandPosition: number | null;
    raiseHand(): void;
    /** Lower your own hand, or (organizer) someone else's. */
    lowerHand(userId?: string): void;
    toggleHand(): void;
    lowerAllHands(): void;
    breakout: BreakoutState;
    /** The open room you belong in, or null for the main meeting. */
    myRoom: BreakoutRoom | null;
    /** The lobby your media should be in: your room's, or the meeting's. */
    activeLobby: string | null;
    /**
     * The chat channel this user should read right now: their open room's, or
     * the meeting's (0.126.0). Hand it to `useChat`; it moves with `activeLobby`.
     */
    activeChat: string | null;
    configureBreakouts(rooms: BreakoutRoomDraft[], opts?: {
        mode?: BreakoutMode;
        allowReturnToMain?: boolean;
    }): void;
    /** Adds one closed room in any phase (default name `Room N`); open it with `openRooms([id])`. */
    addRoom(opts?: {
        id?: string;
        name?: string;
    }): void;
    /** Renames a room in any phase; 1–80 characters after trimming. */
    renameRoom(roomId: string, name: string): void;
    /** userId → roomId, or null to unassign. */
    assign(assignments: Record<string, string | null>): void;
    autoAssign(userIds: string[]): void;
    openRooms(roomIds?: string[]): void;
    /**
     * Close some rooms (by id, at once) or all of them. With a server
     * `closingGraceMs`, closing all starts the countdown (`breakout.closing`);
     * `{ immediate: true }` or a second call closes at once.
     */
    closeRooms(roomIds?: string[], opts?: {
        immediate?: boolean;
    }): void;
    /** Minutes are the common unit in the UI; pass null to clear. */
    setTimer(durationMs: number | null): void;
    broadcast(message: string): void;
    joinRoom(roomId: string): void;
    returnToMain(): void;
    /** End the session; the same countdown and `immediate` as `closeRooms()`. */
    endBreakouts(opts?: {
        immediate?: boolean;
    }): void;
    dismissAnnouncement(): void;
}
export declare function useMeeting(meetingId: string | null, opts?: UseMeetingOptions): UseMeetingResult;
//# sourceMappingURL=useMeeting.d.ts.map