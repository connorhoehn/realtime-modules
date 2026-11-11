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

/** Error code of a WHIP refused because the participant's publishing is revoked. */
export const LVS_PUBLISH_REVOKED = 'LVS_PUBLISH_REVOKED';

/** The token request made before the first publish after a grant. */
export interface LVSAuthTokenRequest {
  /** Return a token minted now, not a cached one. */
  forceRefresh?: boolean;
  /** Why: `'publish-granted'` after a grant. */
  reason?: string;
}

/** Resolves the participant token. Older resolvers ignore the request. */
export type LVSAuthTokenResolver = (request?: LVSAuthTokenRequest) => string | Promise<string>;

/** The local participant's publish permission. */
export interface PublishPermissionState {
  /** May publish now: false while revoked, and for a subscriber token until a grant. */
  canPublish: boolean;
  /** LVS revoked publishing; the participant stays in the call as a viewer. */
  publishRevoked: boolean;
  /** The host's reason for the revocation, or null. */
  reason: string | null;
}

export const EMPTY_PUBLISH_STATE: PublishPermissionState = Object.freeze({
  canPublish: true,
  publishRevoked: false,
  reason: null,
});

export type PublishPermissionAction =
  /** A new session: what its token allows. */
  | { type: 'reset'; canPublish?: boolean }
  | { type: 'revoked'; reason?: string | null }
  | { type: 'granted' };

/** Returns the same object when nothing changes. */
export function reducePublishState(state: PublishPermissionState, action: PublishPermissionAction): PublishPermissionState {
  switch (action.type) {
    case 'reset': {
      const canPublish = action.canPublish !== false;
      if (state.canPublish === canPublish && !state.publishRevoked && state.reason === null) return state;
      return { canPublish, publishRevoked: false, reason: null };
    }
    case 'revoked': {
      const reason = typeof action.reason === 'string' && action.reason ? action.reason : null;
      if (state.publishRevoked && !state.canPublish && (reason === null || state.reason === reason)) return state;
      return { canPublish: false, publishRevoked: true, reason: reason ?? state.reason };
    }
    case 'granted':
      if (state.canPublish && !state.publishRevoked && state.reason === null) return state;
      return { canPublish: true, publishRevoked: false, reason: null };
    default:
      return state;
  }
}

/** A publish LVS refused because publishing is revoked (final until a grant). */
export function isPublishRevokedError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === LVS_PUBLISH_REVOKED);
}

/** A parsed publish-control stage frame. */
export interface PublishControlFrame {
  revoked: boolean;
  participantId: string;
  userId: string | null;
  reason: string | null;
}

/** `participant.publish-revoked` / `participant.publish-granted`, or null for any other frame. */
export function parsePublishControlFrame(msg: unknown): PublishControlFrame | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'participant.publish-revoked' && m.type !== 'participant.publish-granted') return null;
  if (typeof m.participantId !== 'string' || !m.participantId) return null;
  return {
    revoked: m.type === 'participant.publish-revoked',
    participantId: m.participantId,
    userId: typeof m.userId === 'string' && m.userId ? m.userId : null,
    reason: typeof m.reason === 'string' && m.reason ? m.reason : null,
  };
}

/** The stage socket's final close codes. */
export const STAGE_CLOSE_FORBIDDEN = 4403;
export const STAGE_CLOSE_KICKED = 4410;

/** How LVS ended the stage for this participant. Reconnecting would be refused. */
export interface HangoutTermination {
  outcome: 'forbidden' | 'kicked';
  code: number;
  /** The close reason LVS sent, or null. */
  reason: string | null;
}

/** A final stage close, or null when the close may be reconnected. */
export function stageTermination(code: unknown, reason?: unknown): HangoutTermination | null {
  if (code !== STAGE_CLOSE_FORBIDDEN && code !== STAGE_CLOSE_KICKED) return null;
  return {
    outcome: code === STAGE_CLOSE_KICKED ? 'kicked' : 'forbidden',
    code,
    reason: typeof reason === 'string' && reason ? reason : null,
  };
}

/** What to tell the person whose stage ended. */
export function terminationMessage(t: HangoutTermination): string {
  return t.outcome === 'kicked'
    ? 'You were removed from this call.'
    : 'This call refused your access token.';
}

/** Token attributes: string values only (anything else is dropped). Null when none. */
export function tokenAttributes(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
