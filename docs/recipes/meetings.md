# Meetings — raised hands and breakout rooms

A Teams-style meeting on top of a call you already run on LVS: a Raise
button with an ordered queue, and a Rooms pane where an organizer splits the
call into breakout rooms (assigned or self-select), opens and closes them,
runs a timer, broadcasts an announcement and recalls everyone. Design and wire
contract: [../design/meeting-rooms.md](../design/meeting-rooms.md).

## Server

```ts
import { attachRealtime, calls } from '@connorhoehn/realtime-modules/server';
import { meeting } from '@connorhoehn/realtime-modules/meeting';

const realtime = attachRealtime(httpServer, {
    features: [calls({ lobbyGuard }), meeting({ isOrganizer: ({ userId, meetingId }) => hosts(meetingId).has(userId) })],
    auth,
    authorize, // admits `meeting:<meetingId>` like any other channel
});
```

- The meetingId **is** the main call's lobby name.
- Without `isOrganizer`, the meeting's first subscriber is its organizer. Supply the hook in a product.
- `closingGraceMs` (e.g. `30_000`) gives people a countdown before rooms close when an organizer closes all rooms or ends the session (`breakout.closing` is true, `endsAt` is the deadline, joins are refused). A second close, or `closeRooms(undefined, { immediate: true })`, closes at once; opening rooms cancels it. Default 0.
- A breakout room is an ordinary LVS hangout at `breakoutLobbyName(meetingId, roomId)`. Make the lobby guard ask the service:

```ts
const svc = () => realtime.services.meeting as MeetingService;
// calls({ lobbyGuard }) is synchronous, so it uses the mirror-backed form:
const lobbyGuard = (auth, lobby) =>
    svc().admitsBreakoutLobbySync(auth.userId, lobby) ?? yourExistingGuard(auth, lobby); // null: not a breakout lobby
```

An async caller (a platform-api join route) uses `await svc().admitsBreakoutLobby(userId, lobby)`,
which reads the store rather than this process's mirror.

## Client

```tsx
import { useMeeting } from '@connorhoehn/realtime-modules/client/meeting';

const meeting = useMeeting(mainLobby, { displayName: me.name });
const [lobby, setLobby] = useState(mainLobby);
const call = useConversationCall({ lobbyName: lobby, ... });

// Media follows the room (0.122.0): when activeLobby moves, leave and join.
// One move at a time, bursts debounced, never out of an unrelated call.
useFollowMeetingLobby(meeting.activeLobby, {
    currentLobby: call.phase === 'live' ? lobby : null,
    leave: () => call.leave(),
    join: async (next) => { setLobby(next); /* then start/rejoin the call for `next` */ },
});
```

`useMeeting` returns `hands`, `myHandPosition`, `raiseHand`/`lowerHand`/`toggleHand`/`lowerAllHands`,
`breakout`, `myRoom`, `activeLobby`, the organizer verbs (`configureBreakouts`, `addRoom`, `renameRoom`, `assign`,
`autoAssign`, `openRooms`, `closeRooms`, `setTimer`, `broadcast`, `endBreakouts`), the participant
verbs (`joinRoom`, `returnToMain`), `isOrganizer`, `error`, and the standing `state.announcement`.
Pure selectors: `handPosition`, `breakoutRemainingMs`, `unassignedUsers`, `activeMeetingLobby`, `meetingOfLobby`.

## UI

ui-components `/video`: `MeetingToolbar`, `MeetingStatusCluster`, `RecordingConsentNotice`
(with `useConsentDismissal(\`${meetingId}:${recordingId}\`)` so a dismissal survives a reload),
`BreakoutRoomsPanel`, `BreakoutRoomBanner`, `RaisedHandBadge`, `RosterPanel` (`raisedHandsFirst`,
`onLowerHand`, `onLowerAllHands`); `/integrations/realtime-modules`: `WrappedBreakoutRoomsPanel`,
`WrappedBreakoutRoomBanner`, `meetingToolbarItems`, `meetingRosterProps`, `meetingHandPositions`.

## Graduation

`MeetingStateStore` is in-memory and the breakout timer is a process timer. A
multi-replica gateway needs a shared store (the interface is async; compare
`version` on write) and one timer owner.
