/** Client → server verbs. */
export type MeetingAction = 'subscribe' | 'unsubscribe' | 'hand.raise' | 'hand.lower' | 'hand.lowerAll' | 'breakout.configure' | 'breakout.addRoom' | 'breakout.rename' | 'breakout.assign' | 'breakout.autoAssign' | 'breakout.open' | 'breakout.close' | 'breakout.timer' | 'breakout.broadcast' | 'breakout.join' | 'breakout.leave' | 'breakout.end';
export declare const MEETING_ACTIONS: ReadonlySet<MeetingAction>;
/** Verbs only an organizer may send. `hand.lower` is organizer-only when it names someone else. */
export declare const ORGANIZER_ACTIONS: ReadonlySet<MeetingAction>;
export interface RaisedHand {
    userId: string;
    displayName: string;
    /** ISO-8601. The queue is ordered by this, oldest first. */
    raisedAt: string;
}
export type BreakoutRoomState = 'open' | 'closed';
export interface BreakoutRoom {
    /** `[A-Za-z0-9_-]{1,64}` — it becomes part of an LVS lobby name. */
    id: string;
    name: string;
    state: BreakoutRoomState;
    /** userIds that belong in this room. A user is in at most one room. */
    members: string[];
}
/**
 * - `assigned`: the organizer places people; a participant may only join the
 *   room they were placed in.
 * - `self-select`: participants pick any open room (the reference picture's
 *   "Join" buttons).
 */
export type BreakoutMode = 'assigned' | 'self-select';
/**
 * - `none`: no breakout session.
 * - `draft`: rooms exist, nobody has been sent anywhere yet.
 * - `open`: at least one room is open.
 */
export type BreakoutPhase = 'none' | 'draft' | 'open';
export interface BreakoutAnnouncement {
    message: string;
    fromUserId: string;
    fromDisplayName: string;
    /** ISO-8601. */
    at: string;
}
export interface BreakoutSettings {
    /** Participants may leave their room for the main meeting. Default true. */
    allowReturnToMain: boolean;
}
export interface BreakoutState {
    phase: BreakoutPhase;
    mode: BreakoutMode;
    rooms: BreakoutRoom[];
    /** userIds who left their room for the main meeting while rooms are open. */
    returned: string[];
    /** ISO-8601 when every room closes, or null for no timer. */
    endsAt: string | null;
    /**
     * True while rooms are in the closing grace period (0.124.0): an organizer
     * closed or ended the session, `endsAt` is the end of the grace, and joins
     * are refused. Absent on older servers; read it as false.
     */
    closing?: boolean;
    announcement: BreakoutAnnouncement | null;
    settings: BreakoutSettings;
}
export interface MeetingState {
    /** Also the main meeting's LVS lobby name. */
    meetingId: string;
    /** The first subscriber's userId: the default organizer. */
    createdBy: string | null;
    /** Bumped on every change, so a client can drop an out-of-order frame. */
    version: number;
    hands: RaisedHand[];
    breakout: BreakoutState;
    /** ISO-8601. */
    updatedAt: string;
}
export declare const EMPTY_BREAKOUT: BreakoutState;
export type MeetingErrorCode = 'INVALID_ACTION' | 'INVALID_PAYLOAD' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_SUBSCRIBED' | 'NOT_FOUND' | 'CONFLICT';
/** Server → client frames. */
export type MeetingServerFrame = {
    type: 'meeting';
    action: 'meeting.snapshot';
    meetingId: string;
    data: MeetingState & {
        you: {
            userId: string | null;
            organizer: boolean;
        };
    };
    timestamp: string;
} | {
    type: 'meeting';
    action: 'hands.changed';
    meetingId: string;
    data: {
        version: number;
        hands: RaisedHand[];
    };
    timestamp: string;
} | {
    type: 'meeting';
    action: 'breakout.changed';
    meetingId: string;
    data: {
        version: number;
        breakout: BreakoutState;
    };
    timestamp: string;
} | {
    type: 'meeting';
    action: 'breakout.announcement';
    meetingId: string;
    data: BreakoutAnnouncement;
    timestamp: string;
} | {
    type: 'meeting';
    action: 'meeting.unsubscribed';
    meetingId: string;
    data: Record<string, never>;
    timestamp: string;
} | {
    type: 'meeting';
    action: 'error';
    meetingId: string | null;
    error: {
        code: MeetingErrorCode;
        message: string;
        requestAction: string;
    };
    timestamp: string;
};
export interface OrganizerContext {
    meetingId: string;
    userId: string;
    clientId: string;
    /** The meeting's state as it stands (createdBy is the first subscriber). */
    state: Readonly<MeetingState>;
}
export interface MeetingLogger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}
/** The slice of RealtimeRouter the service uses. */
export interface MeetingRouter {
    sendToClient(clientId: string, message: unknown): void | boolean | Promise<void | boolean>;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string | null): Promise<void> | void;
    subscribeToChannel?(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    checkChannel?(kind: 'subscribe' | 'publish', clientId: string, channel: string): boolean | Promise<boolean>;
    getUserIdForClient?(clientId: string): string | undefined;
    getClientData?(clientId: string): {
        userContext?: {
            userId?: string;
            displayName?: unknown;
            [k: string]: unknown;
        };
    } | null;
}
export interface MeetingConfig {
    /** Durable state. Defaults to an in-memory store (one process only). */
    store?: import('./MeetingStateStore').MeetingStateStore;
    /**
     * Who may run breakouts and lower other people's hands. Without it, the
     * meeting's first subscriber is its organizer — fine for a demo, wrong for
     * a product. A throw or rejection counts as false.
     */
    isOrganizer?: (ctx: OrganizerContext) => boolean | Promise<boolean>;
    /** Max rooms per breakout session. Default 50. */
    maxRooms?: number;
    /** Max breakout timer. Default 4 hours. */
    maxTimerMs?: number;
    /**
     * Grace before rooms close when an organizer closes all rooms or ends the
     * session while rooms are open, so people can finish a sentence (Teams'
     * countdown). During it `breakout.closing` is true, `endsAt` counts down
     * and joins are refused. Default 0: close at once. Clamped to 0–5 min.
     * A second close/end, or `immediate: true`, closes at once; opening rooms
     * or setting a timer cancels it. Closing some rooms by id and the timer
     * running out still close at once.
     */
    closingGraceMs?: number;
    /** Clock, for tests. */
    now?: () => number;
    /** Observes every accepted mutation (metrics, audit). Never awaited; a throw is logged. */
    onChange?: (event: {
        meetingId: string;
        action: MeetingAction;
        userId: string;
        state: Readonly<MeetingState>;
    }) => void;
}
export interface MeetingServiceOptions {
    router: MeetingRouter;
    logger?: MeetingLogger;
    config?: MeetingConfig;
}
export declare const MEETING_CHANNEL_PREFIX = "meeting:";
export declare const meetingChannel: (meetingId: string) => string;
export declare const MEETING_ID_PATTERN: RegExp;
export declare const BREAKOUT_ROOM_ID_PATTERN: RegExp;
export declare const MAX_ROOM_NAME_LENGTH = 80;
export declare const MAX_ANNOUNCEMENT_LENGTH = 500;
export declare const MAX_DISPLAY_NAME_LENGTH = 80;
/** Meeting state is plain JSON; a JSON round-trip clones it on every runtime (jsdom has no structuredClone). */
export declare function cloneState<T>(value: T): T;
//# sourceMappingURL=types.d.ts.map