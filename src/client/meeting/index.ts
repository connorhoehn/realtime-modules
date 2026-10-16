// realtime-modules/src/client/meeting/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/client/meeting`.
// Raised hands and breakout rooms for a call on LVS — the client half of the
// `meeting` service (`./meeting`). Design: docs/design/meeting-rooms.md.

export {
    useMeeting,
    type BreakoutRoomDraft,
    type UseMeetingOptions,
    type UseMeetingResult,
} from './useMeeting';

export {
    useFollowMeetingLobby,
    meetingOfLobby,
    type UseFollowMeetingLobbyOptions,
    type UseFollowMeetingLobbyResult,
} from './useFollowMeetingLobby';

export {
    INITIAL_MEETING_STATE,
    breakoutRemainingMs,
    handPosition,
    meetingReducer,
    unassignedUsers,
    type MeetingClientError,
    type MeetingClientEvent,
    type MeetingClientState,
} from './reducer';

export {
    BREAKOUT_LOBBY_SEPARATOR,
    activeMeetingChat,
    activeMeetingLobby,
    breakoutChannel,
    breakoutLobbyName,
    breakoutRoomFor,
    isBreakoutLobby,
    meetingChatChannel,
    parseBreakoutChannel,
    parseBreakoutLobby,
    type ParsedBreakoutChannel,
    type ParsedBreakoutLobby,
} from '../../meeting/lobby';

export type {
    BreakoutAnnouncement,
    BreakoutMode,
    BreakoutPhase,
    BreakoutRoom,
    BreakoutRoomState,
    BreakoutSettings,
    BreakoutState,
    MeetingErrorCode,
    RaisedHand,
} from '../../meeting/types';
