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

## Without a server

`createMeetingLoopback()` (0.128.0) runs the real service in the page or the
test: give each simulated person `useMeeting(meetingId, { socket: loop.socketFor(clientId, userId, name) })`.
ui-components' `Video/MeetingRehearsal` story builds the whole stage this way.

## Clocks

Breakout deadlines are server time. Count down from
`Date.now() + meeting.clockOffsetMs` (0.129.0); the ui-components wrappers do.

## When the call ends

Call `meetingService.resetMeeting(lobbyName)` from the host's call-ended hook
(0.135.0), so the next call in that lobby starts with no rooms, hands or
announcements.

## Room chat

Read `meeting.activeChat` with `useChat` (0.126.0): it is the meeting's chat in
the main meeting and the room's chat inside a room, and it moves when
`activeLobby` does. Room chat channels are named like room lobbies
(`meetingChatChannel(meetingId, roomId)`), so route chat channel checks through
the same `admitsBreakoutLobby` guard as lobbies.

A host that names a call's chat something other than its lobby (the app's
`orgiq:huddle:<callId>`) passes it as `useMeeting(meetingId, { chatChannel })`
(0.134.0). `activeChat` is then that channel in the main meeting and
`breakoutChannel(chatChannel, roomId)`, i.e. `<chatChannel>~breakout~<roomId>`,
inside a room. A guard calls `parseBreakoutChannel(name)` first: it returns
`{ base, roomId }` for a room's chat, so the guard can admit `base` by its usual
family rule and then ask `admitsBreakoutLobby` about the room. Never let an
unparsed room channel reach a family match.

## Live media

Media never passes through the gateway: `meeting()` and `calls()` carry
signalling, and each participant publishes over WHIP straight to the SFU into
the channel its stage token names. Moving rooms is therefore leave-then-join:
`useFollowMeetingLobby(meeting.activeLobby, { currentLobby, leave, join })`
calls `leave()` (the hangout's `leave`), then `join(lobby)`, which asks your
server for a stage token for that lobby and remounts `useLVSHangout` with it.
Guard the lobby where tokens are minted: for a breakout lobby, mint only when
`await meetingService.admitsBreakoutLobby(userId, lobby)` is true (the SFU
itself does not know who belongs in a room).

Run the SFU with auth on. Its session routes (`POST /api/sessions`,
`POST /api/sessions/:arn/join`) then take only a Cognito token or
`Bearer <LVS_SERVICE_TOKEN>`. Keep the service token on your server: the server
creates the session and asks for the join, then hands the browser only the
participant token the SFU signed. With that in place, the only way a client gets
a stage token is through your mint and its `admitsBreakoutLobby` check. One gap
is outside this library: LVS's unauthenticated `GET /api/channels/:arn` returns
the channel's `streamKey`, and that key can mint a publisher token. So don't
hand a client the channel ARN of a room it was not admitted to.
`LVS_AUTH_BYPASS=true` opens the session routes to anyone and is for local
experiments only.

On an LVS cluster, a channel belongs to the node that takes its first WHIP. LVS
has no placement hint. To place a lobby on a node, create its session and mint
its token on that node, and return the node's URL with the token so the client
publishes there.

`test/e2e-media/` rehearses this end to end against a real LVS SFU with two
headless Chromium pages (fake camera and mic) and the real gateway. Auth is on
by default. It can also run against two SFU nodes, with one breakout placed on
the second. The commands are at the top of `breakout-media.live.test.ts`. It is
opt-in (`REAL_LVS=1`) and needs a local Redis, the SFU, `playwright` and
`esbuild`.

## With a conversation call

When the meeting is a `useConversationCall` call, pass the meeting's lobby as
the media lobby (0.134.0):

```tsx
const meeting = useMeeting(lobbyName, { chatChannel });
const call = useConversationCall({ lobbyName, mediaLobby: meeting.activeLobby, ... });
```

The call then moves its own media. When `mediaLobby` changes mid-call, it
leaves the current media and ends its participant in that LVS session. It then
creates or joins the new lobby's session (`/api/video/sessions`, then `/join`)
and joins media with your current device choices and mic and camera state. The
call does not change: the `callId`, the signalling on `lobbyName` and the roster
all stay the same, and it sends no call frames (no ring, `invite`, `accepted`,
`ended` or `participant-state`). Moves run one at a time and the latest target
wins. A failed join keeps the call in `phase: 'failed'` with `error` set, and
`rejoin()` retries in the current media lobby. `leave()` ends the session the
media is in. The result's `mediaLobby` says where the media is (or is going). Recording
binding reports `unavailable` while you are in a room. A host using this does
not also need `useFollowMeetingLobby`; that hook stays for hosts that drive
`useLVSHangout` themselves. Platform-api's lobby check must also admit breakout
lobbies, through the same `admitsBreakoutLobby` guard as the token mint.

## UI

ui-components `/video`: `MeetingToolbar` (an item's `popover: (close) => <ReactionPicker … />` makes React
open the reaction picker; send with `useReactions`), `MeetingStatusCluster`, `RecordingConsentNotice`
(with ``useConsentDismissal(`${meetingId}:${recordingId}`)`` so a dismissal survives a reload),
`BreakoutRoomsPanel`, `BreakoutRoomBanner`, `RaisedHandBadge`, `RosterPanel` (`raisedHandsFirst`,
`onLowerHand`, `onLowerAllHands`); `/integrations/realtime-modules`: `WrappedBreakoutRoomsPanel`,
`WrappedBreakoutRoomBanner`, `meetingToolbarItems`, `meetingRosterProps`, `meetingHandPositions`.

## Graduation

`MeetingStateStore` defaults to in-memory, which is right for one process. For
more than one gateway replica pass `meeting({ store: new RedisMeetingStateStore(redis, { subscriber }) })`
(0.125.0), with `subscriber` a separate pub/sub connection. Writes compare
`version`, so two replicas never lose each other's update; `subscriber` lets
each replica's synchronous lobby check and breakout timer follow writes made
elsewhere (without it, use the async `admitsBreakoutLobby`). Frames still reach
clients on other replicas only through a router that fans channels out across
the cluster. If you pass an `isOrganizer` hook, guard lobbies with the async
`admitsBreakoutLobby` on a multi-replica gateway: the synchronous check only knows
hook verdicts from its own replica (0.127.0).
