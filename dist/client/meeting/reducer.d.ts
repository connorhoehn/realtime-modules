import type { BreakoutAnnouncement, BreakoutState, MeetingErrorCode, RaisedHand } from '../../meeting/types';
export interface MeetingClientError {
    code: MeetingErrorCode | string;
    message: string;
    requestAction: string;
}
export interface MeetingClientState {
    meetingId: string | null;
    /** True once the snapshot for `meetingId` has arrived. */
    ready: boolean;
    version: number;
    hands: RaisedHand[];
    breakout: BreakoutState;
    createdBy: string | null;
    you: {
        userId: string | null;
        organizer: boolean;
    };
    /** The latest announcement the user has not dismissed. */
    announcement: BreakoutAnnouncement | null;
    error: MeetingClientError | null;
}
export declare const INITIAL_MEETING_STATE: MeetingClientState;
export type MeetingClientEvent = {
    kind: 'reset';
    meetingId: string | null;
} | {
    kind: 'frame';
    frame: Record<string, unknown>;
} | {
    kind: 'dismissAnnouncement';
} | {
    kind: 'clearError';
};
/** Apply one event. Unrelated frames (other services, other meetings) return `state` unchanged. */
export declare function meetingReducer(state: MeetingClientState, event: MeetingClientEvent): MeetingClientState;
/** The user's place in the raised-hand queue (1-based), or null. */
export declare function handPosition(hands: readonly RaisedHand[], userId: string | null | undefined): number | null;
/** Milliseconds left on the breakout timer at `now`, or null without one. Never negative. */
export declare function breakoutRemainingMs(breakout: BreakoutState, now: number): number | null;
/** userIds placed in no room — the organizer's "unassigned" list. */
export declare function unassignedUsers(breakout: BreakoutState, userIds: readonly string[]): string[];
//# sourceMappingURL=reducer.d.ts.map