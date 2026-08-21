"use strict";
// realtime-modules/src/call/types.ts
//
// Wire shapes + construction-time tunables for the lifted CallService.
//
// SCOPE — this module is hangout/call **invite signaling** only. It is
// not WebRTC, not SDP exchange, not ICE/TURN, not SFU media-plane
// signaling. The frontend's useVideoCall talks to platform-api for the
// actual media negotiation; this service simply fans out 5 lifecycle
// events (invite/accepted/declined/cancelled/ended) between users over
// the existing WS connection.
//
// Lift scope (Wave 2 catch-up):
//   - WS handleAction for the 5-action protocol.
//   - Targeted user routing via MessageRouterContract.getClientsByUserId,
//     plus broadcast fallback when no targets are supplied.
//
// Left behind in gateway:
//   - enforceChannelPermission authz interceptor — replaced by the
//     `authorize` hook below (defaults to allow-all).
//   - ErrorCodes / createErrorResponse — inlined to a minimal shape
//     matching the gateway-original error frame.
//   - The prom shadow counter wiring (src/observability/metrics).
//     Consumers expose a `recordCallAction` callback via CallConfig.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_CALL_ACTIONS = void 0;
exports.isParticipantStateBroadcast = isParticipantStateBroadcast;
/** Type guard for participant-state / user-status payloads. */
function isParticipantStateBroadcast(p) {
    return typeof p === 'object' && p !== null;
}
/** Verbs accepted by `handleAction`. Exposed for consumer dispatch tables. */
exports.ALLOWED_CALL_ACTIONS = new Set([
    'invite',
    'accepted',
    'declined',
    'cancelled',
    'ended',
    'participant-state',
    'user-status',
    // F3 — client→server query verb. `active-call` (the reply) is
    // deliberately NOT accepted here: it's server→client only.
    'status',
]);
//# sourceMappingURL=types.js.map