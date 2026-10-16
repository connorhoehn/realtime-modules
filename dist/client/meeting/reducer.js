"use strict";
// realtime-modules/src/client/meeting/reducer.ts
//
// Pure client state for the `meeting` service. Every server change frame
// carries a whole slice, so the reducer only overwrites, and drops a frame
// whose `version` is older than what it already holds.
Object.defineProperty(exports, "__esModule", { value: true });
exports.INITIAL_MEETING_STATE = void 0;
exports.meetingReducer = meetingReducer;
exports.handPosition = handPosition;
exports.breakoutRemainingMs = breakoutRemainingMs;
exports.unassignedUsers = unassignedUsers;
const types_1 = require("../../meeting/types");
exports.INITIAL_MEETING_STATE = {
    meetingId: null,
    ready: false,
    version: 0,
    hands: [],
    breakout: types_1.EMPTY_BREAKOUT,
    createdBy: null,
    you: { userId: null, organizer: false },
    announcement: null,
    error: null,
};
function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}
/** Apply one event. Unrelated frames (other services, other meetings) return `state` unchanged. */
function meetingReducer(state, event) {
    switch (event.kind) {
        case 'reset':
            return { ...exports.INITIAL_MEETING_STATE, meetingId: event.meetingId };
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
function applyFrame(state, f) {
    if (f.type !== 'meeting' || !state.meetingId)
        return state;
    if (f.action === 'error') {
        if (f.meetingId !== null && f.meetingId !== undefined && f.meetingId !== state.meetingId)
            return state;
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
    if (f.meetingId !== state.meetingId || !isObject(f.data))
        return state;
    const d = f.data;
    switch (f.action) {
        case 'meeting.snapshot': {
            const snap = d;
            return {
                ...state,
                ready: true,
                version: typeof snap.version === 'number' ? snap.version : 0,
                hands: Array.isArray(snap.hands) ? snap.hands : [],
                breakout: isObject(snap.breakout) ? snap.breakout : types_1.EMPTY_BREAKOUT,
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
            if (version && version < state.version)
                return state;
            return { ...state, version: Math.max(state.version, version), hands: Array.isArray(d.hands) ? d.hands : [] };
        }
        case 'breakout.changed': {
            const version = typeof d.version === 'number' ? d.version : 0;
            if (version && version < state.version)
                return state;
            const breakout = isObject(d.breakout) ? d.breakout : state.breakout;
            return {
                ...state,
                version: Math.max(state.version, version),
                breakout,
                // Ending the session clears what was said in it.
                announcement: breakout.phase === 'open' ? state.announcement : null,
            };
        }
        case 'breakout.announcement':
            return { ...state, announcement: d };
        // The hook resets locally when it unsubscribes; the ack carries nothing.
        default:
            return state;
    }
}
/** The user's place in the raised-hand queue (1-based), or null. */
function handPosition(hands, userId) {
    if (!userId)
        return null;
    const i = hands.findIndex((h) => h.userId === userId);
    return i === -1 ? null : i + 1;
}
/** Milliseconds left on the breakout timer at `now`, or null without one. Never negative. */
function breakoutRemainingMs(breakout, now) {
    if (!breakout.endsAt || breakout.phase !== 'open')
        return null;
    const end = Date.parse(breakout.endsAt);
    return Number.isFinite(end) ? Math.max(0, end - now) : null;
}
/** userIds placed in no room — the organizer's "unassigned" list. */
function unassignedUsers(breakout, userIds) {
    const placed = new Set(breakout.rooms.flatMap((r) => r.members));
    return userIds.filter((u) => !placed.has(u));
}
//# sourceMappingURL=reducer.js.map