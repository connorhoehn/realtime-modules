# Meeting rooms: breakout rooms, raised hands and the meeting toolbar

A Teams-style meeting layer for calls: an ordered raised-hand queue, breakout
rooms an organizer can assign or let people choose, and a meeting toolbar in
ui-components. The server half is `./meeting`, the React half is
`./client/meeting`; the recipe is [../recipes/meetings.md](../recipes/meetings.md).

## 1. Shape

Breakouts are not new media. A breakout room is an ordinary LVS hangout whose
lobby name is derived from the main meeting's lobby:

```
<mainLobby>~breakout~<roomId>
```

`breakoutLobbyName(main, roomId)` and `parseBreakoutLobby(lobby)` are pure
and exported by both `./meeting` and `./client/meeting`. The client asks
`activeMeetingLobby(state, main, selfUserId)` which lobby it should be in and
hands that to `useLVSHangout` / the conversation call it already uses. Moving
rooms is leave-then-join on LVS; nothing in `useLVSHangout` or `CallService`
changes.

The `meeting` service owns coordination state only:

- `hands`: ordered queue of `{ userId, displayName, raisedAt }`.
- `breakout`: `{ phase: 'none'|'draft'|'open'|'closing', mode: 'assigned'|'self-select', rooms: [{ id, name, members: userId[], state: 'open'|'closed' }], endsAt, announcement }`.
- `organizers`: who may run breakouts and lower every hand.

### Wire contract (`service: 'meeting'`, channel `meeting:<meetingId>`)

| Client verb | Who | Effect |
|---|---|---|
| `subscribe` / `unsubscribe` `{ meetingId }` | anyone the router's `checkChannel('subscribe', …, 'meeting:<id>')` admits | joins the channel and gets a `meeting.snapshot` |
| `hand.raise` / `hand.lower` `{ meetingId }` | self | adds or removes self from the queue |
| `hand.lower` `{ meetingId, userId }` | organizer | lowers someone else |
| `hand.lowerAll` `{ meetingId }` | organizer | clears the queue |
| `breakout.configure` `{ meetingId, rooms: [{ id?, name }], mode }` | organizer | replaces the draft; ids are minted when absent |
| `breakout.addRoom` `{ meetingId, id?, name? }` | organizer | appends one closed room in any phase (default name `Room N`); open it with `breakout.open { roomIds }` |
| `breakout.rename` `{ meetingId, roomId, name }` | organizer | renames a room in any phase; names are 1–80 characters after trimming |
| `breakout.assign` `{ meetingId, assignments: { [userId]: roomId \| null } }` | organizer | moves people between rooms |
| `breakout.autoAssign` `{ meetingId, userIds }` | organizer | round-robins the listed people over the rooms |
| `breakout.open` / `breakout.close` `{ meetingId, roomIds?, immediate? }` | organizer | opens or closes some or all rooms; closing every room ends the session. With `closingGraceMs`, closing all (no `roomIds`) first sets `closing: true` and `endsAt` to the end of the grace; a second close or `immediate` closes at once, and an open cancels it |
| `breakout.timer` `{ meetingId, durationMs \| null }` | organizer | sets or clears `endsAt`; at expiry the server closes every room |
| `breakout.broadcast` `{ meetingId, message }` | organizer | sends an announcement into every room |
| `breakout.join` `{ meetingId, roomId }` | self; allowed in `self-select` mode, or the room you were assigned | moves self |
| `breakout.leave` `{ meetingId }` | self | returns self to the main meeting |
| `breakout.end` `{ meetingId, immediate? }` | organizer | closes every room and recalls everyone, after the closing grace when one is configured |

Server frames: `{ type: 'meeting', action: 'meeting.snapshot' | 'hands.changed' | 'breakout.changed' | 'breakout.announcement' | 'error', meetingId, data }`.
Every change frame carries the full slice (hands or breakout), never a diff, so
a client's reducer only ever overwrites (the same rule as rooms' occupancy).

### Authority

- Channel admission is the router's `checkChannel`, as for every other feature; since 0.147.0 a custom router without it is refused unless `insecureAllowAll: true`.
- Organizer authority is `meeting({ isOrganizer(ctx) })`. Without the hook the
  user who created the meeting's state (its first subscriber) is the organizer,
  which is right for a local demo and wrong for a product: a host should
  supply the hook.
- LVS lobby admission stays with the host's lobby guard. `MeetingService.admitsBreakoutLobby(userId, lobby)`
  answers whether a breakout lobby is one that user may sit in right now
  (organizers: any open room; others: their assigned room, or any open room in
  self-select mode), so a guard can refuse a stale or forged lobby name.

## 2. Packaging

| Package | Surface | Files |
|---|---|---|
| realtime-modules | `./meeting` (server) | `src/meeting/{types,MeetingService,MeetingStateStore,manifest,lobby,index}.ts`; `meeting()` feature for `attachRealtime` |
| realtime-modules | `./client/meeting` (React) | `src/client/meeting/{reducer,useMeeting,index}.ts` |
| ui-components | `/video` | `MeetingToolbar`, `MeetingToolbarButton`, `MeetingStatusCluster`, `RecordingConsentNotice`, `RaisedHandBadge`, `BreakoutRoomsPanel`, `BreakoutRoomBanner`, `MeetingIcons`; `ParticipantTile` and `RosterPanel` gain an optional hand prop |
| ui-components | `/integrations/realtime-modules` | `WrappedBreakoutRoomsPanel`, `useMeetingToolbarModel` binding `useMeeting` |

## 3. Durable state

`RedisMeetingStateStore` keeps meeting state in Redis for a cluster: writes
are version compare-and-set in Lua and publish on commit. The service
re-applies a mutation whose write lost, never deletes shared idle state, and
every replica following a meeting arms its timer (the compare-and-set lets
exactly one close commit). Cross-replica frame fan-out is the router's job.
