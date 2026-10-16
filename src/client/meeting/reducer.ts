// realtime-modules/src/client/meeting/reducer.ts
//
// Pure client state for the `meeting` service. Every server change frame
// carries a whole slice, so the reducer only overwrites, and drops a frame
// whose `version` is older than what it already holds.

import type {
    BreakoutAnnouncement,
    BreakoutState,
    MeetingErrorCode,
    MeetingState,
    RaisedHand,
} from '../../meeting/types';
import { EMPTY_BREAKOUT } from '../../meeting/types';

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
    you: { userId: string | null; organizer: boolean };
    /** The latest announcement the user has not dismissed. */
    announcement: BreakoutAnnouncement | null;
    error: MeetingClientError | null;
}

export const INITIAL_MEETING_STATE: MeetingClientState = {
    meetingId: null,
    ready: false,
    version: 0,
    hands: [],
    breakout: EMPTY_BREAKOUT,
    createdBy: null,
    you: { userId: null, organizer: false },
    announcement: null,
    error: null,
};

export type MeetingClientEvent =
    | { kind: 'reset'; meetingId: string | null }
    | { kind: 'frame'; frame: Record<string, unknown> }
    | { kind: 'dismissAnnouncement' }
    | { kind: 'clearError' };

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Apply one event. Unrelated frames (other services, other meetings) return `state` unchanged. */
export function meetingReducer(state: MeetingClientState, event: MeetingClientEvent): MeetingClientState {
    switch (event.kind) {
        case 'reset':
            return { ...INITIAL_MEETING_STATE, meetingId: event.meetingId };
        case 'dismissAnnouncement':
            return state.announcement ? { ...state, announcement: null } : state;
        case 'clearError':
            return state.error ? { ...state, error: null } : state;
        case 'frame':
            return applyFrame(state, event.frame);
        default:
            return state;
    }
}

function applyFrame(state: MeetingClientState, f: Record<string, unknown>): MeetingClientState {
    if (f.type !== 'meeting' || !state.meetingId) return state;
    if (f.action === 'error') {
        if (f.meetingId !== null && f.meetingId !== undefined && f.meetingId !== state.meetingId) return state;
        const e = isObject(f.error) ? f.error : {};
        return {
            ...state,
            error: {
                code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
                message: typeof e.message === 'string' ? e.message : 'The meeting could not be updated',
                requestAction: typeof e.requestAction === 'string' ? e.requestAction : '',
            },
        };
    }
    if (f.meetingId !== state.meetingId || !isObject(f.data)) return state;
    const d = f.data;
    switch (f.action) {
        case 'meeting.snapshot': {
            const snap = d as unknown as MeetingState & { you?: { userId?: string | null; organizer?: boolean } };
            const snapVersion = typeof snap.version === 'number' ? snap.version : 0;
            // The server reads the snapshot, then resolves organizer status
            // before sending it, so a change frame committed in between can
            // arrive FIRST. A snapshot older than what we hold keeps our
            // slices and contributes only `you` and readiness.
            if (snapVersion < state.version) {
                return {
                    ...state,
                    ready: true,
                    createdBy: typeof snap.createdBy === 'string' ? snap.createdBy : state.createdBy,
                    you: {
                        userId: typeof snap.you?.userId === 'string' ? snap.you.userId : null,
                        organizer: snap.you?.organizer === true,
                    },
                };
            }
            return {
                ...state,
                ready: true,
                version: snapVersion,
                hands: Array.isArray(snap.hands) ? snap.hands : [],
                breakout: isObject(snap.breakout) ? (snap.breakout as BreakoutState) : EMPTY_BREAKOUT,
                createdBy: typeof snap.createdBy === 'string' ? snap.createdBy : null,
                you: {
                    userId: typeof snap.you?.userId === 'string' ? snap.you.userId : null,
                    organizer: snap.you?.organizer === true,
                },
                // A rejoin mid-breakout still shows the standing announcement.
                announcement: snap.breakout?.phase === 'open' ? snap.breakout.announcement ?? null : null,
            };
        }
        case 'hands.changed': {
            const version = typeof d.version === 'number' ? d.version : 0;
            if (version && version < state.version) return state;
            return { ...state, version: Math.max(state.version, version), hands: Array.isArray(d.hands) ? (d.hands as RaisedHand[]) : [] };
        }
        case 'breakout.changed': {
            const version = typeof d.version === 'number' ? d.version : 0;
            if (version && version < state.version) return state;
            const breakout = isObject(d.breakout) ? (d.breakout as unknown as BreakoutState) : state.breakout;
            return {
                ...state,
                version: Math.max(state.version, version),
                breakout,
                // Ending the session clears what was said in it.
                announcement: breakout.phase === 'open' ? state.announcement : null,
            };
        }
        case 'breakout.announcement':
            return { ...state, announcement: d as unknown as BreakoutAnnouncement };
        // The hook resets locally when it unsubscribes; the ack carries nothing.
        default:
            return state;
    }
}

/** The user's place in the raised-hand queue (1-based), or null. */
export function handPosition(hands: readonly RaisedHand[], userId: string | null | undefined): number | null {
    if (!userId) return null;
    const i = hands.findIndex((h) => h.userId === userId);
    return i === -1 ? null : i + 1;
}

/** Milliseconds left on the breakout timer at `now`, or null without one. Never negative. */
export function breakoutRemainingMs(breakout: BreakoutState, now: number): number | null {
    if (!breakout.endsAt || breakout.phase !== 'open') return null;
    const end = Date.parse(breakout.endsAt);
    return Number.isFinite(end) ? Math.max(0, end - now) : null;
}

/** userIds placed in no room — the organizer's "unassigned" list. */
export function unassignedUsers(breakout: BreakoutState, userIds: readonly string[]): string[] {
    const placed = new Set(breakout.rooms.flatMap((r) => r.members));
    return userIds.filter((u) => !placed.has(u));
}
