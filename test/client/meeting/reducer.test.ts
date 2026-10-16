import { describe, it, expect } from '@jest/globals';
import {
  INITIAL_MEETING_STATE,
  breakoutRemainingMs,
  handPosition,
  meetingReducer,
  unassignedUsers,
} from '../../../src/client/meeting/reducer';
import { EMPTY_BREAKOUT } from '../../../src/meeting/types';

const M = 'm1';
const base = meetingReducer(INITIAL_MEETING_STATE, { kind: 'reset', meetingId: M });
const frame = (action: string, data: unknown, meetingId: string | null = M) => ({ kind: 'frame' as const, frame: { type: 'meeting', action, meetingId, data } });

describe('meetingReducer', () => {
  it('ignores frames for other services and other meetings', () => {
    expect(meetingReducer(base, { kind: 'frame', frame: { type: 'chat', action: 'x' } })).toBe(base);
    expect(meetingReducer(base, frame('hands.changed', { version: 9, hands: [] }, 'other'))).toBe(base);
  });

  it('drops an out-of-order slice', () => {
    const s1 = meetingReducer(base, frame('hands.changed', { version: 5, hands: [{ userId: 'a', displayName: 'A', raisedAt: '' }] }));
    const s2 = meetingReducer(s1, frame('hands.changed', { version: 4, hands: [] }));
    expect(s2.hands).toHaveLength(1);
  });

  it('a snapshot during an open session keeps the standing announcement; ending clears it', () => {
    const ann = { message: 'hi', fromUserId: 'o', fromDisplayName: 'O', at: '' };
    const open = { ...EMPTY_BREAKOUT, phase: 'open', announcement: ann };
    const s = meetingReducer(base, frame('meeting.snapshot', { version: 3, hands: [], breakout: open, createdBy: 'o', you: { userId: 'a', organizer: false } }));
    expect(s.ready).toBe(true);
    expect(s.announcement).toEqual(ann);
    const ended = meetingReducer(s, frame('breakout.changed', { version: 4, breakout: { ...open, phase: 'draft' } }));
    expect(ended.announcement).toBeNull();
  });

  it('records an error for this meeting or for no meeting', () => {
    const s = meetingReducer(base, { kind: 'frame', frame: { type: 'meeting', action: 'error', meetingId: null, error: { code: 'FORBIDDEN', message: 'no', requestAction: 'hand.lowerAll' } } });
    expect(s.error).toEqual({ code: 'FORBIDDEN', message: 'no', requestAction: 'hand.lowerAll' });
    expect(meetingReducer(s, { kind: 'clearError' }).error).toBeNull();
  });
});

describe('selectors', () => {
  it('handPosition, breakoutRemainingMs, unassignedUsers', () => {
    const hands = [{ userId: 'a', displayName: '', raisedAt: '' }, { userId: 'b', displayName: '', raisedAt: '' }];
    expect(handPosition(hands, 'b')).toBe(2);
    expect(handPosition(hands, 'z')).toBeNull();
    const b = { ...EMPTY_BREAKOUT, phase: 'open' as const, endsAt: '2026-10-15T12:01:00.000Z', rooms: [{ id: 'r', name: 'R', state: 'open' as const, members: ['a'] }] };
    expect(breakoutRemainingMs(b, Date.parse('2026-10-15T12:00:30Z'))).toBe(30_000);
    expect(breakoutRemainingMs(b, Date.parse('2026-10-15T13:00:00Z'))).toBe(0);
    expect(breakoutRemainingMs({ ...b, phase: 'draft' }, 0)).toBeNull();
    expect(unassignedUsers(b, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
});
