import { activeMeetingLobby, breakoutLobbyName, breakoutRoomFor, isBreakoutLobby, parseBreakoutLobby } from '../../src/meeting/lobby';
import { EMPTY_BREAKOUT, type BreakoutState } from '../../src/meeting/types';

const open: BreakoutState = {
    ...EMPTY_BREAKOUT,
    phase: 'open',
    mode: 'assigned',
    rooms: [
        { id: 'r1', name: 'Room 1', state: 'open', members: ['u-a'] },
        { id: 'r2', name: 'Room 2', state: 'closed', members: ['u-b'] },
    ],
};

describe('meeting lobby names', () => {
    it('round-trips, including a meeting id with colons and its own tilde', () => {
        const meetingId = 'room:lounge~x';
        const lobby = breakoutLobbyName(meetingId, 'r1');
        expect(lobby).toBe('room:lounge~x~breakout~r1');
        expect(parseBreakoutLobby(lobby)).toEqual({ meetingId, roomId: 'r1' });
        expect(isBreakoutLobby(lobby)).toBe(true);
    });

    it('rejects anything else', () => {
        for (const s of [null, undefined, '', 'room:lounge', '~breakout~r1', 'm~breakout~', 'm~breakout~bad id']) {
            expect(parseBreakoutLobby(s as any)).toBeNull();
        }
    });

    it('activeMeetingLobby follows the open room, a closed room and a return', () => {
        expect(activeMeetingLobby('m', open, 'u-a')).toBe('m~breakout~r1');
        expect(activeMeetingLobby('m', open, 'u-b')).toBe('m');
        expect(activeMeetingLobby('m', open, 'u-z')).toBe('m');
        expect(activeMeetingLobby('m', { ...open, returned: ['u-a'] }, 'u-a')).toBe('m');
        expect(activeMeetingLobby('m', { ...open, phase: 'draft' }, 'u-a')).toBe('m');
        expect(breakoutRoomFor(open, null)).toBeNull();
    });
});
