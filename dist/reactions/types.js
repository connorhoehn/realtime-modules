"use strict";
// realtime-modules/src/reactions/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// ReactionService.
//
// Lift scope (Wave 2): pure in-memory reaction fan-out. No persistence,
// no DDB, no Redis. Gateway-specific concerns left behind:
//   - ownership-cleanup-coordinator integration (_cleanupRoom / onLost)
//   - enforceChannelPermission interceptor (replaced with `authorizeChannel` hook)
//   - ErrorCodes / createErrorResponse coupling (inlined to minimal shape)
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ERROR_CODE = exports.DEFAULT_AVAILABLE_REACTIONS = void 0;
/**
 * Built-in catalog: 12 emoji with paired effect tokens. Frozen so
 * consumers don't accidentally mutate the shared module-level object.
 */
exports.DEFAULT_AVAILABLE_REACTIONS = Object.freeze({
    '❤️': { name: 'heart', effect: 'pulse-red' },
    '\u{1F602}': { name: 'laugh', effect: 'shake' },
    '\u{1F44D}': { name: 'thumbs-up', effect: 'bounce-green' },
    '\u{1F44E}': { name: 'thumbs-down', effect: 'bounce-red' },
    '\u{1F62E}': { name: 'wow', effect: 'zoom' },
    '\u{1F622}': { name: 'sad', effect: 'fade-blue' },
    '\u{1F621}': { name: 'angry', effect: 'shake-red' },
    '\u{1F389}': { name: 'party', effect: 'confetti' },
    '\u{1F525}': { name: 'fire', effect: 'flicker-orange' },
    '⚡': { name: 'lightning', effect: 'flash-yellow' },
    '\u{1F4AF}': { name: 'hundred', effect: 'spin-gold' },
    '\u{1F680}': { name: 'rocket', effect: 'fly-up' },
});
/** Default error code emitted when sendError is called without an explicit code. */
exports.DEFAULT_ERROR_CODE = 'SERVICE_INTERNAL_ERROR';
//# sourceMappingURL=types.js.map