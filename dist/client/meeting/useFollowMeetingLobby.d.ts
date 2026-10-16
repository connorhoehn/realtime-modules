export interface UseFollowMeetingLobbyOptions {
    /** The lobby your media is in now (null when not in a call). */
    currentLobby: string | null;
    /** Leave the current call. May be async; awaited before join. */
    leave: () => void | Promise<void>;
    /** Join `lobby`'s call. May be async. */
    join: (lobby: string) => void | Promise<void>;
    /** Coalesce bursts of target changes. Default 300 ms. */
    debounceMs?: number;
    /** Hold following (e.g. while a pre-join dialog is open). Default true. */
    enabled?: boolean;
}
export interface UseFollowMeetingLobbyResult {
    /** A leave/join is in flight. */
    moving: boolean;
    /** Where the in-flight move is going, or null. */
    target: string | null;
    /** The last leave/join failure, cleared by the next target change. */
    error: unknown | null;
}
/** The meeting a lobby belongs to: itself, or the meeting of its breakout. */
export declare function meetingOfLobby(lobby: string): string;
export declare function useFollowMeetingLobby(activeLobby: string | null, opts: UseFollowMeetingLobbyOptions): UseFollowMeetingLobbyResult;
//# sourceMappingURL=useFollowMeetingLobby.d.ts.map