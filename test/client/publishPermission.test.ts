// The publish-permission and stage-termination policy behind useLVSHangout.

import { describe, it, expect } from '@jest/globals';
import {
  EMPTY_PUBLISH_STATE,
  isPublishRevokedError,
  parsePublishControlFrame,
  reducePublishState,
  stageTermination,
  tokenAttributes,
} from '../../src/client/video/publishPermission';

describe('reducePublishState', () => {
  it('a revocation stops publishing and keeps the reason; a grant clears both', () => {
    const revoked = reducePublishState(EMPTY_PUBLISH_STATE, { type: 'revoked', reason: 'off topic' });
    expect(revoked).toEqual({ canPublish: false, publishRevoked: true, reason: 'off topic' });
    const granted = reducePublishState(revoked, { type: 'granted' });
    expect(granted).toEqual({ canPublish: true, publishRevoked: false, reason: null });
  });

  it('repeats are no-ops (same object), and a reasonless repeat keeps the reason', () => {
    const revoked = reducePublishState(EMPTY_PUBLISH_STATE, { type: 'revoked', reason: 'r' });
    expect(reducePublishState(revoked, { type: 'revoked' })).toBe(revoked);
    expect(reducePublishState(revoked, { type: 'revoked', reason: 'r' })).toBe(revoked);
    expect(reducePublishState(EMPTY_PUBLISH_STATE, { type: 'granted' })).toBe(EMPTY_PUBLISH_STATE);
  });

  it('a subscriber token starts without publishing; a grant allows it', () => {
    const viewer = reducePublishState(EMPTY_PUBLISH_STATE, { type: 'reset', canPublish: false });
    expect(viewer).toEqual({ canPublish: false, publishRevoked: false, reason: null });
    expect(reducePublishState(viewer, { type: 'granted' }).canPublish).toBe(true);
    expect(reducePublishState(viewer, { type: 'reset' })).toEqual(EMPTY_PUBLISH_STATE);
  });
});

describe('frames and errors', () => {
  it('parses publish-control frames and ignores others', () => {
    expect(parsePublishControlFrame({ type: 'participant.publish-revoked', participantId: 'p1', userId: 'u1', reason: 'why' }))
      .toEqual({ revoked: true, participantId: 'p1', userId: 'u1', reason: 'why' });
    expect(parsePublishControlFrame({ type: 'participant.publish-granted', participantId: 'p1' }))
      .toEqual({ revoked: false, participantId: 'p1', userId: null, reason: null });
    expect(parsePublishControlFrame({ type: 'participant.publish-granted' })).toBeNull();
    expect(parsePublishControlFrame({ type: 'producer.added', participantId: 'p1' })).toBeNull();
  });

  it('recognises the revoked refusal by code', () => {
    expect(isPublishRevokedError({ code: 'LVS_PUBLISH_REVOKED' })).toBe(true);
    expect(isPublishRevokedError(new Error('403'))).toBe(false);
    expect(isPublishRevokedError(null)).toBe(false);
  });

  it('only 4403 and 4410 end the stage', () => {
    expect(stageTermination(4410, 'kicked')).toEqual({ outcome: 'kicked', code: 4410, reason: 'kicked' });
    expect(stageTermination(4403, '')).toEqual({ outcome: 'forbidden', code: 4403, reason: null });
    expect(stageTermination(1001)).toBeNull();
    expect(stageTermination(4401)).toBeNull();
    expect(stageTermination(undefined)).toBeNull();
  });

  it('keeps string attributes only', () => {
    expect(tokenAttributes({ seat: 'guest', n: 1 })).toEqual({ seat: 'guest' });
    expect(tokenAttributes({})).toBeNull();
    expect(tokenAttributes(['a'])).toBeNull();
  });
});
