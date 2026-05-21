// realtime-modules/src/call/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/call`.
//
// Wave 2 catch-up lift: hangout/call invite signaling. WS fan-out only —
// no WebRTC, no SDP, no SFU media plane (that lives in
// live-video-streaming). See CallService.ts for the lift notes.

export { CallService } from './CallService';

export {
    ALLOWED_CALL_ACTIONS,
    type CallAction,
    type CallConfig,
    type CallErrorFrame,
    type CallEvent,
    type CallInvite,
    type CallLogger,
    type CallMessageRouter,
    type CallServiceOptions,
    type UserClientMatch,
} from './types';

export { CallManifest } from './manifest';
