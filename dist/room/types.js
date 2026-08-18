"use strict";
// realtime-modules/src/room/types.ts
//
// Wire shapes + construction-time contracts for the new 'room' WS
// service. Distinct from CallService — RoomService is about live
// occupancy of named rooms (slug-addressed: 'lounge', 'standup', …)
// rather than the 1:1/N-target invite signaling that CallService owns.
//
// Two subscriber surfaces:
//
//   1. Per-room subscribers ('subscribe' / 'unsubscribe' with `{slug}`):
//      receive `member-joined` / `member-left` events for that one room.
//      Powers the per-room sidebar/header avatar strips.
//
//   2. Index subscribers ('subscribe-index' / 'unsubscribe-index'):
//      receive aggregated `occupancy-delta` snapshots covering every
//      room with non-zero membership. Powers the sidebar/index page
//      that lists all rooms + their current head-counts. Aggregated +
//      debounced (500ms) so a burst of joins/leaves coalesces into a
//      single frame.
//
// Membership ingress (W3) — for this pass we ride on the existing
// call WS surface: when a client emits `participant-state` for a
// `room:*` lobby, CallService records them as a room member via a
// thin RoomService.handleMemberJoined call. This avoids the
// cross-service HTTP plumbing (platform-api → gateway /internal/rooms
// /event) that the long-term design wants but is overkill for W3.
// The internal HMAC-signed endpoint can be added later without
// changing RoomService's public surface.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CROSS_NODE_ROOM_TOPIC = exports.ALLOWED_ROOM_ACTIONS = void 0;
/** Verbs accepted by `handleAction`. Exposed for consumer dispatch tables. */
exports.ALLOWED_ROOM_ACTIONS = new Set([
    'subscribe-index',
    'unsubscribe-index',
    'subscribe',
    'unsubscribe',
    'join',
    'leave',
]);
/** Topic naming pattern for cross-node room events. */
exports.CROSS_NODE_ROOM_TOPIC = 'room:event';
//# sourceMappingURL=types.js.map