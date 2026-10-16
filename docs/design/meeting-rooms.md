# Meeting rooms: breakout rooms, raised hands and the meeting toolbar

Status: 2026-10-15, built in realtime-modules 0.121.0 and ui-components
(the release that ships `MeetingToolbar` and `BreakoutRoomsPanel`). Not yet
wired into any app. Reference: a Microsoft Teams meeting with the Rooms pane
open (one organizer, fifteen people, seven self-select rooms).

## 1. Audit of the reference

| Area | What Teams shows | What existed before this work | What this work adds |
|---|---|---|---|
| Title + status cluster | meeting title, shield (meeting options), red recording dot, elapsed `32:52` | `HangoutRoomHeader`, `RecordingChip`, `formatCallElapsed` | `MeetingStatusCluster` (recording + elapsed + optional lock slot) |
| Toolbar | labelled icon buttons: Chat, People (count), Raise, React, View, Notes, Rooms (active underline), Apps, More; Camera and Mic as split buttons with a device chevron; Share; red Leave | `MediaControlsBar` / `CallControls`: round icon-only buttons, no labels, no counts, no split buttons, no active-pane state | `MeetingToolbar` + `MeetingToolbarButton` (icon over label, count badge, pressed and active-pane states, split chevron menu, priority overflow into More) |
| Recording consent | "Recording and transcription. Started by X. By attending you agree…" dismissible card | `CallNoticePill` (one line), `CallStartedBanner` | `RecordingConsentNotice` |
| Grid tiles | avatar or initials on a soft surface when camera is off, name chip with mute glyph, signal bars on self, accent ring on the active speaker | `ParticipantTile`, `HangoutGrid` (ring, chip, mute) | a raised-hand badge with queue position on the tile and in the roster |
| Raise hand | toolbar toggle, hand badge on tile, ordered queue in People, organizer lowers all | `MediaControlsBar` story-only raise-hand extra; no state anywhere | `meeting` service hands (raise, lower, lower all, ordered queue) and `useMeeting().hands` |
| React | reaction picker over the call | `ReactionPicker` + `reactions` service | nothing new; the toolbar's React button hosts the existing picker |
| Rooms pane | "Breakout rooms" side pane: row per room with expand chevron (members), name, `Open` status, Join button | `CallSidePanel` (tabbed dock), hangout-rooms directory (persistent slug rooms, not breakouts) | `BreakoutRoomsPanel` (participant and organizer modes), `BreakoutRoomBanner` (in-room countdown, announcement, return) |
| Breakout control (organizer, not in the picture) | create N rooms, assign automatically or manually or let people choose, open/close all, timer, announcement, recall everyone | none | `meeting` service breakout verbs + organizer section of the panel |

## 2. Shape

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

- Channel admission is the router's `checkChannel`, as for every other feature.
- Organizer authority is `meeting({ isOrganizer(ctx) })`. Without the hook the
  user who created the meeting's state (its first subscriber) is the organizer,
  which is right for a local demo and wrong for a product: a host should
  supply the hook.
- LVS lobby admission stays with the host's lobby guard. `MeetingService.admitsBreakoutLobby(userId, lobby)`
  answers whether a breakout lobby is one that user may sit in right now
  (organizers: any open room; others: their assigned room, or any open room in
  self-select mode), so a guard can refuse a stale or forged lobby name.

## 3. Packaging

| Package | Surface | Files |
|---|---|---|
| realtime-modules | `./meeting` (server) | `src/meeting/{types,MeetingService,MeetingStateStore,manifest,lobby,index}.ts`; `meeting()` feature for `attachRealtime` |
| realtime-modules | `./client/meeting` (React) | `src/client/meeting/{reducer,useMeeting,index}.ts` |
| ui-components | `/video` | `MeetingToolbar`, `MeetingToolbarButton`, `MeetingStatusCluster`, `RecordingConsentNotice`, `RaisedHandBadge`, `BreakoutRoomsPanel`, `BreakoutRoomBanner`, `MeetingIcons`; `ParticipantTile` and `RosterPanel` gain an optional hand prop |
| ui-components | `/integrations/realtime-modules` | `WrappedBreakoutRoomsPanel`, `useMeetingToolbarModel` binding `useMeeting` |

Everything is additive: no existing prop, verb or export changes meaning.

## 4. Not done here

- No app wiring (aws-agentcore portal, realtime-examples). The next step is a
  `meeting()` feature in the BFF's `attachRealtime`, a lobby guard that calls
  `admitsBreakoutLobby`, and the toolbar on the huddle stage.
- Durable state: done in 0.125.0. `RedisMeetingStateStore` (version
  compare-and-set in Lua, publish on commit) for a cluster; the service
  re-applies a mutation whose write lost, never deletes shared idle state, and
  every replica following a meeting arms its timer (the compare-and-set lets
  exactly one close commit). Cross-replica frame fan-out is the router's job.
- event-catalog declarations for the `meeting` frames.
