"use strict";
// realtime-modules/src/meeting/types.ts
//
// Wire shapes for the `meeting` WS service: raised hands and breakout rooms
// for a call that is already running on LVS. Coordination state only — no
// media. A breakout room is an ordinary hangout whose lobby name is derived
// from the meeting's (see ./lobby.ts); the client moves its media there.
//
// Design: docs/design/meeting-rooms.md.
//
// Every change frame carries the FULL slice it changed (all hands, or the
// whole breakout state), never a diff, so a client reducer only overwrites.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DISPLAY_NAME_LENGTH = exports.MAX_ANNOUNCEMENT_LENGTH = exports.MAX_ROOM_NAME_LENGTH = exports.BREAKOUT_ROOM_ID_PATTERN = exports.MEETING_ID_PATTERN = exports.meetingChannel = exports.MEETING_CHANNEL_PREFIX = exports.EMPTY_BREAKOUT = exports.ORGANIZER_ACTIONS = exports.MEETING_ACTIONS = void 0;
exports.cloneState = cloneState;
exports.MEETING_ACTIONS = new Set([
    'subscribe',
    'unsubscribe',
    'hand.raise',
    'hand.lower',
    'hand.lowerAll',
    'breakout.configure',
    'breakout.addRoom',
    'breakout.rename',
    'breakout.assign',
    'breakout.autoAssign',
    'breakout.open',
    'breakout.close',
    'breakout.timer',
    'breakout.broadcast',
    'breakout.join',
    'breakout.leave',
    'breakout.end',
]);
/** Verbs only an organizer may send. `hand.lower` is organizer-only when it names someone else. */
exports.ORGANIZER_ACTIONS = new Set([
    'hand.lowerAll',
    'breakout.configure',
    'breakout.addRoom',
    'breakout.rename',
    'breakout.assign',
    'breakout.autoAssign',
    'breakout.open',
    'breakout.close',
    'breakout.timer',
    'breakout.broadcast',
    'breakout.end',
]);
exports.EMPTY_BREAKOUT = Object.freeze({
    phase: 'none',
    mode: 'self-select',
    rooms: [],
    returned: [],
    endsAt: null,
    announcement: null,
    settings: { allowReturnToMain: true },
});
exports.MEETING_CHANNEL_PREFIX = 'meeting:';
const meetingChannel = (meetingId) => `${exports.MEETING_CHANNEL_PREFIX}${meetingId}`;
exports.meetingChannel = meetingChannel;
exports.MEETING_ID_PATTERN = /^[A-Za-z0-9:_.~-]{1,200}$/;
exports.BREAKOUT_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
exports.MAX_ROOM_NAME_LENGTH = 80;
exports.MAX_ANNOUNCEMENT_LENGTH = 500;
exports.MAX_DISPLAY_NAME_LENGTH = 80;
/** Meeting state is plain JSON; a JSON round-trip clones it on every runtime (jsdom has no structuredClone). */
function cloneState(value) {
    return JSON.parse(JSON.stringify(value));
}
//# sourceMappingURL=types.js.map