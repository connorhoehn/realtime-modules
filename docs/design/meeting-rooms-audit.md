# Meeting rooms — audit loop checklist

The hourly loop for the Teams-style meeting feature (design:
[meeting-rooms.md](./meeting-rooms.md)) works from THIS file. Each tick runs
the protocol below, appends one line to the log at the bottom, and either
ships the top backlog item or stops the loop when nothing actionable is left.

Reference picture: `/Users/connorhoehn/Downloads/teams-snapshot-with-rooms.png`.

## Scope and fences

| Repo | Path | What is ours |
|---|---|---|
| realtime-modules | `~/Projects/realtime-modules` | `src/meeting/**`, `src/client/meeting/**`, `test/meeting/**`, `test/client/meeting/**`, `docs/design/meeting-rooms*.md`, `docs/recipes/meetings.md` |
| ui-components | `~/Projects/ui-components` | `src/components/video/{Meeting*,Breakout*,RaisedHandBadge,RecordingConsentNotice}*`, `src/integrations/realtime/meeting.tsx`, the hand props on `ParticipantTile`/`CallTileRow`/`RosterPanel`/`HangoutGrid`/`HangoutSpotlight`, `handFor` on `ConversationCallDock`/`WrappedLVSHangoutLayout` |

- Another session works in these repos and in aws-agentcore. Never edit or
  revert anything outside the table, never touch a main checkout's
  uncommitted files, and never stage a lockfile you did not change.
- **No app wiring.** The user said not to bring it into aws-agentcore yet. No
  portal or middleware edits, and no pin moves.
- Work in a worktree (`git worktree add -b fix/meeting-audit-N .claude/worktrees/meeting-audit main`,
  then symlink `node_modules -> ../../../node_modules`). Merge with
  `git merge --ff-only` only; if main moved, rebase first. Delete the
  worktree and branch after merging.
- Release realtime-modules per `RELEASE.md` (build, tag, push **both**
  remotes). Release ui-components per its CLAUDE.md (feature commit without
  `dist/`, release commit with the version bump, `dist/` and the export
  snapshot; `package.json` only, not the lockfile). Push `origin main`.
- No browser tools. Visual checks use headless Playwright against a Storybook
  you start on a private port, and you stop only the PID you started.

## Protocol for each tick

1. **Orient (2 min).** `git -C <repo> log --oneline -5` in both repos, and
   `git status --short`. Note any commits from the other session that touch
   files in the table. If one does, re-run step 2 before anything else.
2. **Health gates.** Record pass/fail counts in the log.
   ```bash
   cd ~/Projects/realtime-modules && npx tsc --noEmit -p tsconfig.json \
     && NODE_OPTIONS='--max-old-space-size=2048' npx jest test/meeting test/client/meeting --no-coverage
   cd ~/Projects/ui-components && node scripts/tsc.mjs --noEmit \
     && npx vitest run src/components/video/__tests__/{MeetingToolbar,MeetingStatusCluster,RecordingConsentNotice,RaisedHandBadge,BreakoutRoomsPanel,CallTileRow.hands}.test.tsx \
        src/integrations/realtime/__tests__/meeting.test.tsx src/integrations/realtime/__tests__/conversationCall.test.tsx \
        src/integrations/realtime-modules/__tests__/WrappedLVSHangoutLayout.test.tsx
   ```
   A red gate is the tick's work: fix it before any backlog item.
3. **Contract drift.** `src/integrations/realtime/__tests__/meeting.test.tsx`
   compiles `UseMeetingResult → RMMeetingSource`; if realtime-modules changed
   `useMeeting`, that line must still compile. Also check that every verb in
   `MEETING_ACTIONS` has a server test and a `useMeeting` method.
4. **Review questions.** Read the changed code since the last log line (or
   all of it on the first tick of a day) and answer each in the log
   (`ok` or a finding):
   - A. **Authority.** Can a non-organizer reach any `ORGANIZER_ACTIONS` path,
     lower another person's hand, join an assigned room that is not theirs,
     or leave when `allowReturnToMain` is false? Does `isOrganizer` throwing
     refuse?
   - B. **Ordering.** Can any frame roll client state back (version guard on
     every slice, snapshot included)? Can two writes to one meeting
     interleave outside `serial()`?
   - C. **Lifecycle.** Is state released when idle (`releaseIfIdle`)? Do
     timers die with their meeting? Does a reconnect (`sessionEpoch`)
     resubscribe exactly once?
   - D. **Lobby safety.** Do `admitsBreakoutLobby` and its Sync twin agree?
     Can a meetingId or room id forge another meeting's lobby?
   - E. **Input limits.** Room count, name length, announcement length, timer
     bounds, meetingId pattern: all enforced server-side, not just in the UI?
   - F. **Hands everywhere.** Does a raised hand show on every tile surface an
     app can render (`ParticipantTile`, `HangoutGrid`, `HangoutSpotlight`,
     `CallTileRow` bar/floating/dock/grid, `RosterPanel`, breakout member
     lists), with the queue position in the accessible name?
   - G. **Component discipline.** No `style={{}}` beyond allowlisted
     runtime values, form controls from `forms/`, text through `T`, tones
     from tokens, new names collision-free (`export-ambiguity.test.ts`).
   - H. **Accessibility.** Toolbar keyboard behaviour (`role="toolbar"`
     implies arrow-key roving), labelled buttons, `aria-pressed`/`aria-expanded`,
     focus after closing the Rooms pane, live regions for announcements.
   - I. **Old pins.** The ui-components integration barrels must load on
     realtime-modules < 0.121 (no runtime import of `/client/meeting` or
     `/meeting` outside tests).
   - J. **Docs.** CHANGELOG, recipe and design doc match the code.
5. **Visual check (every tick that changed UI, else daily).** Start Storybook
   (`npx storybook dev -p 6107 --ci --no-open` in the worktree), screenshot
   with headless Playwright at 1440×800 in light AND dark
   (`document.documentElement.dataset.theme = 'dark'`):
   `video-meetingstage-composition--main-meeting`,
   `video-meetingstage-composition--in-breakout-room`,
   `video-breakoutroomspanel--organizer-open`,
   `video-breakoutroomspanel--organizer-draft`,
   `video-meetingtoolbar--compact`. Compare against the reference picture:
   toolbar order and labels, People count, Rooms underline, split chevrons,
   red Leave, consent card copy, grid name chips and hands, the pane's
   Open/Join rows. Note regressions as findings. Stop Storybook by PID.
6. **Ship one thing.** Take the top unchecked backlog item (findings first),
   implement it in a worktree with tests, run the full suites
   (`npx jest --no-coverage` in realtime-modules; `npx vitest run`,
   `npm run lint`, `npm run build`, `npm run snapshot:exports` in
   ui-components), release, merge, push, tick it here with the release
   number.
7. **Stop condition.** When steps 2–5 are clean and every backlog item is
   either done or marked `blocked:` with a reason, delete the loop
   (`CronDelete`) and report.

## Findings log

| Date | Finding | Fix |
|---|---|---|
| 2026-10-15 | B: a `meeting.snapshot` could arrive after a newer change frame and roll it back (organizer resolution happens between the read and the send) | realtime-modules 0.121.1: reducer ignores an older snapshot's slices, keeps `you`/ready |
| 2026-10-15 | C: meeting state was never freed; a long-running gateway kept every meeting | 0.121.1: `releaseIfIdle` on last unsubscribe/disconnect when no hand is up and no rooms exist |
| 2026-10-15 | D: a meetingId containing `~breakout~` parsed as another meeting's breakout lobby | 0.121.1: refused with `INVALID_PAYLOAD` |
| 2026-10-15 | F: `CallTileRow` (the dock the app renders) dropped `handRaised` at every tile site; no way to feed hands to `ConversationCallDock` or `WrappedLVSHangoutLayout` | ui-components 2.458.1: hands on all variants with the position in the accessible name; `handFor` on both wrappers |
| 2026-10-15 | Organizer could not delete drafted rooms to start over | 2.458.1: `onDeleteRooms` / Delete rooms in draft; End only while open |

## Backlog (top first)

- [ ] **H. Toolbar keyboard roving.** `MeetingToolbar` declares `role="toolbar"` but Tab walks every button; arrow keys should move focus (Home/End, wrap) per WAI-ARIA. ui-components has `shared/RovingToolbar` — reuse it, test with fireEvent keyDown.
- [ ] **Follow the active lobby.** Every app must write "when `activeLobby` changes, leave the call and join the new lobby". Add `useFollowMeetingLobby(activeLobby, { leave, join, debounceMs })` to `./client/meeting` with tests (no double join, no join while leaving, ignores the first render).
- [ ] **Rename and add rooms while open.** Teams allows both. Server verbs `breakout.rename { roomId, name }` and `breakout.addRoom { name? }` (organizer, any phase, name limits); `useMeeting` methods; inline rename in `BreakoutRoomsPanel` (organizer, via `forms/Input`) and an Add room button; wrapper bindings.
- [ ] **Raised-hands queue in People.** `RosterPanel` sorted by queue position when hands are up, with organizer `onLowerHand(id)` and `onLowerAllHands()` actions; `WrappedRosterHands` binding or adapter.
- [ ] **Closing grace.** When the timer runs out or the organizer closes rooms, Teams gives a short countdown before moving people. Server: optional `closingGraceMs` → `breakout.changed` with `closingAt`; banner shows "Rooms close in 0:30"; tests with fake timers.
- [ ] **Dark mode pass.** Screenshot every new story in dark; fix any token that does not flip (consent card, banner, pane, toolbar active underline).
- [ ] **Consent remembered.** `RecordingConsentNotice` dismissal per meeting+recording session via a small `useConsentDismissal(key)` helper (try/catch storage).
- [ ] **React button.** Toolbar items gain an optional `popover` slot so React can host the existing `ReactionPickerButton`/`ReactionPicker` instead of a menu.
- [ ] **Shared store.** `RedisMeetingStateStore` (injected client like `RedisRoomStateStore`) with a version compare-and-set, plus one timer owner across replicas. Needed before any multi-replica deploy.
- [ ] **event-catalog declarations** for the `meeting` frames (`~/Projects/event-catalog` if present, else `blocked:` with a note), then `satisfies` annotations in `useMeeting`.
- [ ] blocked: **App wiring** (aws-agentcore portal/BFF) — the user said not yet.

## Tick log

| When | Gates | Review A–J | Visual | Shipped |
|---|---|---|---|---|
| 2026-10-15 sweep | rm meeting 45/45 (full 2423 pass; `work-graph/streamService` flaky 1/3, not ours), ui affected 69/69 | B, C, D, F findings (above) | light, 4 stories, matches reference | 0.121.1 / 2.458.1 |
