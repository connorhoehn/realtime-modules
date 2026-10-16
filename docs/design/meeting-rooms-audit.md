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
| ui-components | `~/Projects/ui-components` | `src/components/video/{Meeting*,Breakout*,RaisedHandBadge,RecordingConsentNotice}*`, and for goal G7/G8 only `ReactionOverlay.tsx` (`tone`) and `forms/InlineEditableText.tsx` (focus restore), `src/integrations/realtime/meeting.tsx`, the hand props on `ParticipantTile`/`CallTileRow`/`RosterPanel`/`HangoutGrid`/`HangoutSpotlight`, `handFor` on `ConversationCallDock`/`WrappedLVSHangoutLayout` |

- Another session works in these repos and in aws-agentcore. Never edit or
  revert anything outside the table, never touch a main checkout's
  uncommitted files, and never stage a lockfile you did not change.
- **No app wiring.** The user said not to bring it into aws-agentcore yet. No
  portal or middleware edits, and no pin moves.
- Work in a worktree (`git worktree add -b fix/meeting-audit-N .claude/worktrees/meeting-audit main`,
  then symlink `node_modules -> ../../../node_modules`). Merge with
  `git merge --ff-only` only; if main moved, rebase first. Delete the
  worktree and branch after merging. If the main checkout has uncommitted
  files the release also changes (the other session rebuilding `dist/`),
  do not merge into it: check `git merge-base --is-ancestor origin/main HEAD`
  and `git push origin HEAD:main` from the worktree, and leave local `main`
  behind for its owner to fast-forward. Run that tick's ui gates in a
  worktree off `origin/main`, not the lagging main checkout. If the other
  session commits on the stale local `main` meanwhile, it must rebase onto
  `origin/main` before pushing; say so in the tick summary, never rebase it
  for them.
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
     && npx vitest run src/components/video/__tests__/{MeetingToolbar,MeetingStatusCluster,RecordingConsentNotice,RaisedHandBadge,BreakoutRoomsPanel,CallTileRow.hands,ReactionPicker}.test.tsx \
        src/components/video/__tests__/meeting-brand.test.ts src/components/forms/__tests__/InlineEditableText.test.tsx \
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
   with headless Playwright at 1440×800 in light AND dark. **Dark:** the
   Storybook preview wraps stories in a light `ThemeProvider` that writes
   light tokens INLINE on `<html>`, which beats `[data-theme="dark"]`. Clear
   them first or the shot is half-themed and every panel looks broken:
   `document.documentElement.removeAttribute('style'); document.documentElement.dataset.theme = 'dark';`
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
| 2026-10-16 | H (in this tick's own change, before release): an organizer's Lower button vanished with the hand and dropped keyboard focus on `<body>` | 2.460.0: focus moves to the next Lower, else the panel; regression test |
| 2026-10-16 | H (closed by G8, 2.467.0): `InlineEditableText` (`forms/`, used for room rename) drops focus after Enter/Escape because the input unmounts | not ours to edit; noted for the library owner |
| 2026-10-16 | C: `useFollowMeetingLobby` still joined after unmount or `enabled: false` mid-move, rejoining a call the user had left | realtime-modules 0.122.1: re-check before each move and after the leave; 2 regression tests (fail without the fix) |
| 2026-10-16 | G/H (closed by G7, 2.465.0): `ReactionPicker` (`ReactionOverlay.tsx`) is styled for dark call chrome only; hosted in the toolbar's light panel its options' `hover:bg-white/10` shows no hover in light mode (the stories clear its own background with `className`) | not ours to edit; a `tone` like `ReactionPickerButton`'s would fix it — noted for the library owner |

## Backlog (top first)

The definition of done is `meeting-rooms-goal.md` (G1–G10); these items track it.

- [x] **G6 Fictional demo content.** — ui-components 2.464.0 (names replaced; the brand ratchet test refuses them). Replace names copied from the reference screenshot in stories and tests.

- [x] **H. Toolbar keyboard roving.** — ui-components 2.458.2 (`useRovingToolbar`; one tab stop, arrows wrap, Home/End, disabled skipped, chevrons reachable). `MeetingToolbar` declares `role="toolbar"` but Tab walks every button; arrow keys should move focus (Home/End, wrap) per WAI-ARIA. ui-components has `shared/RovingToolbar` — reuse it, test with fireEvent keyDown.
- [x] **Follow the active lobby.** — realtime-modules 0.122.0 (`useFollowMeetingLobby`, 8 tests: order, no overlap, latest wins, debounce, unrelated call, lagging host, failure). Every app must write "when `activeLobby` changes, leave the call and join the new lobby". Add `useFollowMeetingLobby(activeLobby, { leave, join, debounceMs })` to `./client/meeting` with tests (no double join, no join while leaving, ignores the first render).
- [x] **Rename and add rooms while open.** — realtime-modules 0.123.0 (`breakout.addRoom`/`breakout.rename`, `addRoom`/`renameRoom`, 4 tests) + ui-components 2.459.0 (`onRenameRoom` via `InlineEditableText`, `onAddRoom`, `maxRooms`; optional on `RMMeetingSource` for older pins). Teams allows both. Server verbs `breakout.rename { roomId, name }` and `breakout.addRoom { name? }` (organizer, any phase, name limits); `useMeeting` methods; inline rename in `BreakoutRoomsPanel` (organizer, via `forms/Input`) and an Add room button; wrapper bindings.
- [x] **Raised-hands queue in People.** — ui-components 2.460.0 (`raisedHandsFirst`, `onLowerHand`, `onLowerAllHands`, `orderRosterByHands`, `meetingRosterProps`; focus kept when a Lower disappears). `RosterPanel` sorted by queue position when hands are up, with organizer `onLowerHand(id)` and `onLowerAllHands()` actions; `WrappedRosterHands` binding or adapter.
- [x] **Closing grace.** — realtime-modules 0.124.0 (`closingGraceMs`, `breakout.closing`, `immediate`; 6 tests) + ui-components 2.461.0 (pane Closing in / Close now / Keep rooms open, banner Room closes in + polite status). When the timer runs out or the organizer closes rooms, Teams gives a short countdown before moving people. Server: optional `closingGraceMs` → `breakout.changed` with `closingAt`; banner shows "Rooms close in 0:30"; tests with fake timers.
- [x] **Dark mode pass.** — verified 2026-10-16 with the theme applied correctly: pane, consent card, banner, toolbar and organizer controls all flip; no change needed. Screenshot every new story in dark; fix any token that does not flip (consent card, banner, pane, toolbar active underline).
- [x] **Consent remembered.** — ui-components 2.462.0 (`useConsentDismissal(key, { storage })`, session by default, guarded storage with a memory fallback; 3 tests). `RecordingConsentNotice` dismissal per meeting+recording session via a small `useConsentDismissal(key)` helper (try/catch storage).
- [x] **React button.** — ui-components 2.463.0 (`MeetingToolbarItem.popover(close)`, `popoverLabel`, `popoverPlacement`; `InlinePopover`, never folds into More; 3 tests). Toolbar items gain an optional `popover` slot so React can host the existing `ReactionPickerButton`/`ReactionPicker` instead of a menu.
- [x] **Shared store.** — realtime-modules 0.125.0 (`RedisMeetingStateStore`: Lua compare-and-set on `version` + publish; service retries a lost write up to 5×, never deletes shared idle state, `watch` keeps lobby mirrors and timers on every following replica — the CAS lets exactly one close commit; 8 tests, 5 fail without the change). `RedisMeetingStateStore` (injected client like `RedisRoomStateStore`) with a version compare-and-set, plus one timer owner across replicas. Needed before any multi-replica deploy.
- [x] **G1 Brand color.** — ui-components 2.464.0 (`primary` tokens; ratchet test `meeting-brand.test.ts`; story TealBrand scopes a brand on a wrapper — a nested ThemeProvider cannot, it writes `:root`). (user, 2026-10-16) Our highlights use the library `accent` (fixed purple); the portal points `--color-primary` at the tenant brand. Move the toolbar active underline, pressed state, focus ring and the consent privacy link to the `primary` tokens; keep semantic warning (hands) and danger (closing). Add a ratchet test that fails on `accent`, raw palette classes or `white` in our files, and stories under a teal brand override.
- [x] **G2 Library primitives, not hand-drawn bits.** — ui-components 2.464.0 (`CloseIcon`, `MeetingRecordingIcon`, `Link external`, `T`, `text-text-inverse`). The `×` close glyphs (banner, consent, pane) become the library close button; the consent card's drawn radio, the hand badge's `text-white` and raw sizes (`text-[10px]`, `font-semibold`) move to `T` and tokens.
- [x] **G3 Announcements in the meeting chat.** — ui-components 2.466.0 (`useMeetingChat`, `MeetingChatTargetSwitch`, pane `announceIn='chat'` default; story `Video/MeetingChat`). (user, 2026-10-16: "this send box … would need to be in the main chat dialogue") Remove the pane's announcement box (keep `onAnnounce` for old pins, unused by default); organizers send from the chat composer with a "To: all rooms" target, and announcements render as marked messages in the main and room chats, merged client-side from the existing `breakout.announce` frame. The banner keeps the latest announcement.
- [x] **Brand visual check.** — 2026-10-16: MeetingStage default and TealBrand, light and dark; React popover hover; chat announcements and pane hint. Clean. Every story in light and dark under the default and a teal brand; compare.
- [x] **G5 React binding.** — ui-components 2.465.0. `meetingToolbarItems({ onReact })`.
- [x] **G7 ReactionPicker surface tone.** — ui-components 2.465.0 (default `chrome` unchanged).
- [x] **G4 Room chat channel.** — realtime-modules 0.126.0 (`meetingChatChannel`, `activeMeetingChat`, `useMeeting().activeChat`; room chat named like its lobby so one guard covers both). `meetingChatChannel(meetingId, roomId?)`.
- [x] **G8 Rename focus restore** (`InlineEditableText`). — ui-components 2.467.0 (Enter/Escape refocus the button; blur left alone; test fails without the fix).
- [ ] **G9 Organizer verdict across replicas.**
- [ ] **G10 event-catalog declarations** for the `meeting` frames (`~/Projects/event-catalog` if present, else `blocked:` with a note), then `satisfies` annotations in `useMeeting`.
- [ ] blocked: **App wiring** (aws-agentcore portal/BFF) — the user said not yet.

## Tick log

| When | Gates | Review A–J | Visual | Shipped |
|---|---|---|---|---|
| 2026-10-15 sweep | rm meeting 45/45 (full 2423 pass; `work-graph/streamService` flaky 1/3, not ours), ui affected 69/69 | B, C, D, F findings (above) | light, 4 stories, matches reference | 0.121.1 / 2.458.1 |
| 2026-10-16 00:10 | rm meeting 45/45, types ok; ui targeted 61/61, types ok; full 11142 pass | no changes to our code since last tick → A–J ok; 15/15 verbs have a server test and a hook method; `UseMeetingResult → RMMeetingSource` compiles | light + dark, 5 stories, clean (first dark attempt was a harness artefact, now documented) | 2.458.2 toolbar roving; dark pass closed |
| 2026-10-16 01:10 | rm meeting 45/45, ui 64/64, types ok | changed since last tick: toolbar roving → A–F n/a, G ok (shared hook), H fixed by it, I ok (no RM runtime import), J ok | light + dark, 5 stories clean; live toolbar has 1 tab stop; draft story shows Delete rooms | 0.122.0 useFollowMeetingLobby |
| 2026-10-16 02:10 | rm meeting 53/53, ui 64/64, types ok | changed: useFollowMeetingLobby → C finding (join after unmount/disable); A, B, D, E, F n/a; G–J ok | skipped (no UI change; visual done today) | 0.122.1 fix |
| 2026-10-16 03:10 | rm meeting 55/55, ui 64/64, types ok; after the change rm full 2438 pass, ui full 11146 pass | no changes since last tick → A–J ok; new verbs checked as written: A organizer-only (FORBIDDEN tested), E names 1–80 refused not truncated, ids pattern + unique, `maxRooms` cap; I new `RMMeetingSource` members optional (old-pin test) | light + dark, 5 stories + rename-in-place: clean, focus lands in the name input | 0.123.0 / 2.459.0 rename + add rooms; ui pushed to `origin/main` from the worktree (main checkout has the other session's uncommitted `dist/` rebuild, local `main` left at 2.458.2) |
| 2026-10-16 04:10 | rm meeting 59/59, types ok; ui 68/68 (worktree off `origin/main` 2.459.0), types ok; after the change ui full 11152 pass | no changes since last tick → A–J ok; new roster code: G Button from `ui/`, opt-in props; H finding fixed before release; I `meetingRosterProps` takes the structural source, no RM import | light + dark, 5 stories + RosterPanel RaisedHandsQueue: clean; keyboard Lower lands on the next Lower | 2.460.0 hands queue; pushed from the worktree. The other session committed `eef92785` on stale local `main` (4404e9de): it must rebase onto `origin/main` before its next push (no file overlap) |
| 2026-10-16 05:10 | rm meeting 59/59, ui 88/88, types ok (local ui `main` caught up: the other session rebased and released 2.460.1, no overlap); after the change rm full 2443 pass (`work-graph/streamService` flaked once, 3/3 alone), ui full 11157 pass | no changes since last tick → A–J ok; new code: A organizer-only verbs unchanged; B closing lives inside `serial()`; C deadline rides the existing timer, cleared by `closeAll`; D sync guard admits until the deadline, refuses after (tested); E grace clamped 0–5 min; I `closing` optional on `RMBreakoutState`; J design, recipe, both changelogs | light + dark, 5 stories + OrganizerClosing + banner Closing: clean | 0.124.0 / 2.461.0 closing grace; ui ff-merged locally again |
| 2026-10-16 06:10 | rm meeting 65/65, ui 92/92, types ok; after the change ui full 11160 pass | no changes since last tick → A–J ok; new hook: G no styles, collision-free names; J recipe's UI list was stale (missing the roster bindings and banner wrapper), fixed here | skipped: hook only, no visual change; full visual passed today (05:10) | 2.462.0 consent dismissal |
| 2026-10-16 07:10 | rm meeting 65/65, types ok; ui 76/76 (the doc's eight files plus WrappedLVSHangoutLayout), types ok; after the change ui full 11163 pass | no changes since last tick → A–J ok; new slot: G panel is `InlinePopover` with surface tokens, no inline styles; H `aria-haspopup`/`aria-expanded`, Escape and second click close, focus returns, panel portalled so roving skips it (tested); I `popover` optional, older callers unchanged; J recipe names the slot. Finding: `ReactionPicker` has no light hover (outside scope, logged) | light + dark, 5 stories + React open in MeetingStage: clean, matches the reference's reaction flyout | 2.463.0 React popover |
| 2026-10-16 08:10 | rm meeting 65/65, types ok; ui 79/79, types ok; after the change rm meeting 73/73, full 2452 pass, exports/contract/packed ok | no changes since last tick → A–J ok; new store: A authority unchanged (verbs still checked before apply); B ordering = in-process chain plus cross-process CAS, retried mutations re-read and re-check authority; C `dispose` stops `watch`; D lobby mirror follows remote writes, newer versions only; E retries capped at 5 then CONFLICT; I store members optional, old stores behave as before; J design + recipe + changelog | skipped: server only; full visual today (07:10) | 0.125.0 shared store |
| 2026-10-16 10:07 | rm meeting 75/75 (0.126 worktree), types ok; ui 100/100 (gate list now adds ReactionPicker, meeting-brand, InlineEditableText), types ok; ui full 11170 pass after each release | changed since 08:10 (user asked to work the goal through): A authority unchanged — announce still `breakout.announce` (organizer-only, server-checked), the chat switch only shows for organizers; B announcement list dedupes by `at`+sender, capped 50; C picker popover and chat binding hold no timers; D room chat reuses the lobby name so `admitsBreakoutLobby` guards it; E announcement trimmed and cut at 500 like the server; G brand ratchet test green, no hand-drawn bits; H focus restore (G8), segmented `To` switch is a labelled radio group; I new props optional, `announceIn` default is a documented behaviour change; J recipe Room chat section, both changelogs, goal doc | light + dark: TealBrand and default stage, React hover, chat announcement, pane hint — clean | ui 2.464.0–2.467.0 (G1 G2 G3 G5 G6 G7 G8), rm 0.126.0 (G4); rm full 2453 pass, `work-graph/streamService` flaked once (3/3 alone, not ours) |
