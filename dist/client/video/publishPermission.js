"use strict";
// Publish permission and stage termination, as the LVS wire contract states
// them (live-video-streaming docs/adopting-lvs.md, "Participants and publish
// control" and "Stage socket close codes"). Pure, so the policy is testable
// without React; useLVSHangout folds stage frames and WHIP refusals through it.
//
//   participant.publish-revoked / participant.publish-granted
//       stage frames `{ participantId, userId?, reason? }`. LVS sends them to
//       the affected participant's own socket too.
//   403 { reason: 'publish_revoked' } on WHIP
//       publishing is revoked for this participant until a grant; retrying
//       cannot succeed.
//   close 4403 / 4410
//       the stage socket was refused (token for another channel, or a denied
//       participant) or the participant was kicked; reconnecting is refused.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGE_CLOSE_KICKED = exports.STAGE_CLOSE_FORBIDDEN = exports.EMPTY_PUBLISH_STATE = exports.LVS_PUBLISH_REVOKED = void 0;
exports.reducePublishState = reducePublishState;
exports.isPublishRevokedError = isPublishRevokedError;
exports.parsePublishControlFrame = parsePublishControlFrame;
exports.stageTermination = stageTermination;
exports.terminationMessage = terminationMessage;
exports.tokenAttributes = tokenAttributes;
/** Error code of a WHIP refused because the participant's publishing is revoked. */
exports.LVS_PUBLISH_REVOKED = 'LVS_PUBLISH_REVOKED';
exports.EMPTY_PUBLISH_STATE = Object.freeze({
    canPublish: true,
    publishRevoked: false,
    reason: null,
});
/** Returns the same object when nothing changes. */
function reducePublishState(state, action) {
    switch (action.type) {
        case 'reset': {
            const canPublish = action.canPublish !== false;
            if (state.canPublish === canPublish && !state.publishRevoked && state.reason === null)
                return state;
            return { canPublish, publishRevoked: false, reason: null };
        }
        case 'revoked': {
            const reason = typeof action.reason === 'string' && action.reason ? action.reason : null;
            if (state.publishRevoked && !state.canPublish && (reason === null || state.reason === reason))
                return state;
            return { canPublish: false, publishRevoked: true, reason: reason ?? state.reason };
        }
        case 'granted':
            if (state.canPublish && !state.publishRevoked && state.reason === null)
                return state;
            return { canPublish: true, publishRevoked: false, reason: null };
        default:
            return state;
    }
}
/** A publish LVS refused because publishing is revoked (final until a grant). */
function isPublishRevokedError(err) {
    return Boolean(err && typeof err === 'object' && err.code === exports.LVS_PUBLISH_REVOKED);
}
/** `participant.publish-revoked` / `participant.publish-granted`, or null for any other frame. */
function parsePublishControlFrame(msg) {
    if (!msg || typeof msg !== 'object')
        return null;
    const m = msg;
    if (m.type !== 'participant.publish-revoked' && m.type !== 'participant.publish-granted')
        return null;
    if (typeof m.participantId !== 'string' || !m.participantId)
        return null;
    return {
        revoked: m.type === 'participant.publish-revoked',
        participantId: m.participantId,
        userId: typeof m.userId === 'string' && m.userId ? m.userId : null,
        reason: typeof m.reason === 'string' && m.reason ? m.reason : null,
    };
}
/** The stage socket's final close codes. */
exports.STAGE_CLOSE_FORBIDDEN = 4403;
exports.STAGE_CLOSE_KICKED = 4410;
/** A final stage close, or null when the close may be reconnected. */
function stageTermination(code, reason) {
    if (code !== exports.STAGE_CLOSE_FORBIDDEN && code !== exports.STAGE_CLOSE_KICKED)
        return null;
    return {
        outcome: code === exports.STAGE_CLOSE_KICKED ? 'kicked' : 'forbidden',
        code,
        reason: typeof reason === 'string' && reason ? reason : null,
    };
}
/** What to tell the person whose stage ended. */
function terminationMessage(t) {
    return t.outcome === 'kicked'
        ? 'You were removed from this call.'
        : 'This call refused your access token.';
}
/** Token attributes: string values only (anything else is dropped). Null when none. */
function tokenAttributes(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'string')
            out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
}
//# sourceMappingURL=publishPermission.js.map