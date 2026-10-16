import { type MeetingServiceOptions, type MeetingState } from './types';
export declare class MeetingService {
    private readonly router;
    private readonly logger;
    private readonly store;
    private readonly isOrganizerHook;
    private readonly maxRooms;
    private readonly maxTimerMs;
    private readonly now;
    private readonly onChange;
    private readonly clients;
    private readonly chains;
    private readonly timers;
    private roomSeq;
    /** Last state this process read or wrote per meeting, for the synchronous lobby check. */
    private readonly mirror;
    /** Last organizer verdict per `meetingId\u0000userId`, for the synchronous lobby check. */
    private readonly organizerVerdicts;
    constructor(opts: MeetingServiceOptions);
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void>;
    onClientConnect(_clientId: string): void;
    onClientDisconnect(clientId: string): Promise<void>;
    /** The meeting's state, or null when nobody has subscribed yet. */
    getState(meetingId: string): Promise<MeetingState | null>;
    /**
     * Whether `userId` may sit in `lobby` right now, for a host's LVS lobby
     * guard. Non-breakout lobbies return null (not this service's question).
     * Organizers may enter any open room; everyone else only the open room
     * they belong in (in self-select mode, any open room).
     */
    admitsBreakoutLobby(userId: string, lobby: string): Promise<boolean | null>;
    /**
     * The same answer from this process's last-known state, synchronously —
     * for `calls({ lobbyGuard })`, which cannot await. A meeting this process
     * has not seen refuses; an organizer is recognised once the service has
     * resolved them (any subscribe or write of theirs).
     */
    admitsBreakoutLobbySync(userId: string, lobby: string): boolean | null;
    /**
     * Drop a meeting's state once nobody in this process is subscribed and it
     * holds nothing live (no raised hand, no breakout session). Without this a
     * long-running gateway keeps every meeting it ever saw. A meeting with
     * rooms (draft or open) is kept so an organizer who reconnects finds them.
     */
    private releaseIfIdle;
    /** Stop every breakout timer (tests, shutdown). */
    dispose(): void;
    private subscribe;
    private unsubscribe;
    private mutate;
    /** Pure state transition. Returns null for a no-op (nothing is broadcast). */
    private apply;
    private commit;
    private scheduleTimer;
    /** Close every room when the timer has run out (on the timer, and lazily on any access). */
    private expireIfDue;
    private serial;
    private organizer;
    private organizerByUser;
    private parseRooms;
    private mintRoomId;
    private freshState;
    private bump;
    private userIdOf;
    /** The auth context's display name; the frame's only when the context has none. */
    private displayNameOf;
    private userHasOtherClient;
    private send;
    private sendError;
    private iso;
}
//# sourceMappingURL=MeetingService.d.ts.map