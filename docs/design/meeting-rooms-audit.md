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
        src/integrations/realtime/__tests__/meeting.test.tsx src/integrations/realtime/__tests__/meetingRehearsal.test.tsx src/integrations/realtime/__tests__/conversationCall.test.tsx \
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
| 2026-10-16 | C (rehearsal): `useMeetingChat` drew announcements as viewer-only messages, which ChatPanel renders as YOUR OWN — another organizer's announcement sat on your side of the thread and the count read 0 | ui-components 2.468.0: `withAnnouncements` merges them as the organizer's messages, `renderMessageReferences` marks them; `localMessages` deprecated |
| 2026-10-16 | G (rehearsal, regression from 2.464.0): the banner's sender name moved to its own line — `T` renders a flex `Inline` | ui-components 2.468.0: `<strong>` |
| 2026-10-16 | H (ui-dom-audit): contrast under 4.5:1 — room "Open" 3.3:1, raised-hand number ~3:1 (both tones), active brand text and privacy link 3.7:1 under teal, announcement note 4.2:1 | ui-components 2.473.0 |
| 2026-10-16 | outside scope (ui-dom-audit): RecordingChip "Rec" 4.41:1; tile initials 4.44:1; count Badge 10px; ChatPanel default input lacks `data-composer-surface` | noted for the library owner |

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
- [x] **G9 Organizer verdict across replicas.** — realtime-modules 0.127.0 (creator recognised by every replica's sync guard; hook verdicts stay local, recipe says use the async guard then; test fails without the fix).
- [x] **G10 event-catalog declarations** — event-catalog 0.8.6 (`66f8c92b`, bundle `meeting@1.0.0`, 17 outbound + 6 inbound frames; `MeetingOutboundFrame`, `MeetingInboundFrame` from `/client-frames`). The `satisfies` step is wave-2 G20.
- [x] **G11 Wiring rehearsal.** — realtime-modules 0.128.0 (`createMeetingLoopback`) + ui-components 2.468.0 (story `Video/MeetingRehearsal` on the real `useMeeting`; integration test over the real service; `withMeetingHands`). Found and fixed two bugs (findings log). Note: under vitest the realtime-modules CommonJS dist loads its own React, so ui tests drive the seat through realtime-modules' reducer; the real hook is tested in realtime-modules and runs in the story.
- [x] **G21 Live media rehearsal** — test only, no release (`test/e2e-media/`, opt-in `REAL_LVS=1`). Real gateway (`attachRealtime` + `meeting()`), a private LVS SFU from `~/Projects/live-video-streaming` (port 3913, its own Redis on 16499), two headless Chromium pages with fake camera/mic running `useMeeting` + `useFollowMeetingLobby` + `useLVSHangout`. Proven on the SFU's own producer list, one ARN per lobby: both publish audio+video into the main lobby and decode each other; on open, Ada's producers sit only under r1's ARN, Bram's only under r2's, main has none, and neither page receives the other; Bram's token request for r1 is refused 403 by the mint guard (`admitsBreakoutLobby`); on end both return to main and decode each other again. Each move settles in ~0.5 s (the 300 ms follow debounce plus a fresh WHIP); whole run ~5 s, 3/3 consecutive passes on the final spec. Auth on (the harness default since the hardening pass; `REAL_LVS_AUTH=bypass` is the opt-in): with `LVS_SERVICE_TOKEN` set and no bypass, anonymous create, anonymous join and a forged-bearer join on the SFU's session routes are each refused 401, the page never ships the service token, the host's mint (which holds it) refuses Bram r1 with a 403, and the full move scenario passes. Two nodes (`REAL_LVS_URL_B`, gossip over TCP, one Redis): with r1 placed on node B, Ada's r1 producers are local on `g21-sfu-b` (Redis owner key `g21-sfu-b:<arn>`), node A holds only piped copies, and main and r2 stay on `g21-sfu-a`; the move and the return still pass. Still not proven: a viewer decoding across nodes (no subscriber ever sits on a node other than its publisher's, and `useLVSHangout` has no subscribe-only mode); a 307 or `/api/proxy` hop between nodes on one host (LVS takes a peer's HTTP port to be its own PORT, `src/services/cluster-adapter.js:403`); `CLUSTER_PUBSUB=redis` (needs `ioredis`, which live-video-streaming does not install). Found, outside this repo: LVS's unauthenticated `GET /api/channels/:arn` returns the `streamKey`, which mints a publisher token, so the room guard holds only while a client never learns another room's ARN (recorded as `arnHole`, not asserted). The two-node rehearsal is outside G21's judge, which asks for one SFU. Run: `REAL_LVS=1 REAL_LVS_URL=http://127.0.0.1:3913 REAL_LVS_SERVICE_TOKEN=$G21_SVC PLAYWRIGHT_MODULE=~/Projects/live-video-streaming/node_modules/playwright ESBUILD_MODULE=~/Projects/ui-components/node_modules/esbuild npx jest test/e2e-media` (SFU and Redis commands in the spec header).
- [x] **G12 Clock skew.** — realtime-modules 0.129.0 (`clockOffsetMs` from frame timestamps; no wire change) + ui-components (banner/pane/wrappers `clockOffsetMs`, ui-components 2.469.0).
- [x] **G13 Announcement history.** — realtime-modules 0.130.0 (`breakout.announcements`, last 20, kept across sessions) + ui-components 2.471.0 (`useMeetingChat` seeds from it, deduped with live frames).
- [x] **G15 Server refuses what the catalog refuses.** — realtime-modules 0.131.0 (configure: mode, allowReturnToMain, room drafts, names, members; 7 tests).
- [x] **G14 Rate limits.** — realtime-modules 0.132.0 (`rateLimit`, `RATE_LIMITED`; 3 tests). Catalog: event-catalog 0.8.7 (`d55372cc`, `meeting@1.1.0`: `RATE_LIMITED`, `breakout.announcements`, configure `name: null`; 1.0.0 fingerprint unchanged).
- [x] **G16 Which chat am I in.** — ui-components 2.470.0 (`MeetingChatContext` in the chat dock, polite status; `meetingChatTitle`; rehearsal asserts it).
- [x] **G17 Narrow widths.** — ui-components 2.472.0 (toolbar phone layout below 820px, banner wraps, stories fluid; 390/768/1024/1440 light + dark, no horizontal overflow).
- [x] **G18 DOM and accessibility audit.** — ui-dom-audit over 14 meeting stories × light/dark × 1440/900/390 (84 cases, Storybook adapter in the session scratchpad). In-scope contrast findings fixed in ui-components 2.473.0 (room status, raised-hand badge, active brand ink, privacy link, announcement note); the re-run clears them. Left, outside scope: RecordingChip "Rec" 4.41:1, tile avatar initials 4.44:1, shared count Badge at 10px, ChatPanel's default input has no composer marker. Harness-only: Storybook font, no main landmark, three rehearsal seats share a pane name.
- [x] **G19 Scale budgets.** — ui `meetingScale.test.tsx` (bindings < 25 ms at 300 people / 50 rooms / 100 hands) + rm `test/meeting/scale.test.ts` (measured 2026-10-16: 0.09 ms per hand raise with fan-out to 301 clients, 0.3 ms auto-assign of 300, worst-case snapshot 30 KB; budgets 25 ms / 100 ms / 64 KB). Test-only, no release.
- [x] **G20 Typed frames** — realtime-modules 0.133.0 (event-catalog dev pin `d55372cc` = 0.8.7; `act` typed by verb from `MeetingOutboundFrame`, subscribe/unsubscribe `satisfies`; a typo'd field fails to compile, checked). The install ran in the worktree's own node_modules; the main checkout's node_modules is refreshed after the merge.
App wiring (aws-agentcore portal/BFF) is not part of this backlog: it is the next goal, started when the user asks (see `meeting-rooms-goal.md`, "Next goal").

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
| 2026-10-16 11:30 | rm meeting 76/76, full 2455 pass, exports/contract/packed ok | new code: A organizer still the creator unless a hook is set (same rule as the async path); D sync guard now admits the creator on every replica that mirrors the meeting, hook verdicts stay local (documented); J changelog + recipe | skipped: server only | 0.127.0 G9; event-catalog 0.8.6 G10 (agent); wave 2 (G11–G21) written into the goal |

| 2026-10-16 12:40 | ui full 11171 pass; rm 0.128.0 full 2457 pass | G11 rehearsal found C (announcement side) and G (banner line), both fixed; I: `localMessages` kept, deprecated; scope: `.storybook/main.ts` gained the two meeting subpath aliases its own comment asks for | rehearsal walked headlessly, light + dark: hands queue, rooms, chat announcement, room chat private, return | rm 0.128.0 + ui 2.468.0 (G11) |
| 2026-10-16 13:10 | rm meeting 79/79, full 2458 pass; ui 102/102 (gate list adds the rehearsal), full 11172 pass | changed since 12:40: B offset only moves on a >250 ms change, deadlines unchanged on the wire; E nothing new accepted; H context line is a polite status, To switch unchanged; I `clockOffsetMs` optional on `RMMeetingSource`, older pins count as before; J changelogs + recipe Clocks section | rehearsal context line light (wrap fixed before release); countdown change has no visual difference | rm 0.129.0 + ui 2.469.0 (G12), ui 2.470.0 (G16) |
| 2026-10-16 14:10 | rm meeting 81/81, full 2460 pass; ui full 11173 pass | changed: A broadcast still organizer-only; E history capped at 20 (snapshot +~10 KB worst case), message limits unchanged; I field optional both sides, stored state without it tested; J changelog | skipped: data only, the chat already renders announcements | rm 0.130.0 + ui 2.471.0 (G13); G21 marked blocked: (Redis, user's call) |
| 2026-10-16 15:40 | rm meeting 88/88, full 2467 pass; ui video + meeting tests green | changed: E configure now refuses malformed mode/allowReturnToMain/room drafts/names/members (absent keeps); G toolbar phone layout uses existing primitives; H contrast fixes, active text on `primary-fg`; I `phone`/`phoneBelow` optional, `announceIn` unchanged | 390/768/1024/1440 light + dark no overflow; DOM audit 84 cases, in-scope findings cleared | rm 0.131.0 (G15), ui 2.472.0 (G17), ui 2.473.0 (G18). 2.472.0's full run had 3 load timeouts outside our files (114/114 alone); release now gates on vitest's exit code |
| 2026-10-16 16:40 | rm meeting 91/91, full 2470 pass; ui gate green (adds meetingScale) | changed: A/E rate limit per person per meeting, writes only (subscribe exempt), refused writes broadcast nothing; C buckets cleared with the meeting's local state; I `rateLimit` optional, generous default; J changelog | skipped: server only | rm 0.132.0 (G14); event-catalog 0.8.7 (`meeting@1.1.0`); ui scale test (G19 half) |
| 2026-10-16 17:40 | rm meeting 92/92, contract check green (pinned outbound names + 25 catalog additions), full 2470 pass; `work-graph/streamService` failed once (also 3/5 on the old tree, does not use the catalog: the known flake) | changed: type-only; I published `.d.ts` do not reference the catalog; J changelog | skipped: no UI | rm 0.133.0 (G20) — every backlog item done except `blocked:` G21 (Redis) and app wiring |
| 2026-10-16 18:10 | G21 live rehearsal 3/3 pass (~5 s each, ~12 s with jest boot) against a private SFU; normal suite skips it | changed: test only. D the breakout guard sits at the token mint (async `admitsBreakoutLobby`), forged join refused; I no library code touched | skipped: no UI (headless media pages are test fixtures) | none: G21 harness committed, no version |
| 2026-10-16 18:30 | rm meeting gate green; live-media test re-run independently on a private SFU + Redis: pass | G21 verified (producers move main → r1/r2 → main, forged join 403); goal doc marked done with a closing table | n/a | goal complete: every backlog item done; only app wiring stays out (user's call) |
| 2026-10-16 13:30 EDT | G21 hardening: on the final spec, auth-on single node 2/2 pass, two nodes 4/4, bypass 1/1 (5–7 s each, 8–14 s with jest boot; one earlier fail was the spec's own mint expectation, fixed) on private Redis + SFUs; normal suite skips it | changed: test only. D the SFU's session routes refuse anonymous and forged-bearer calls 401; the mint is the only token path. Two nodes: r1 local on `g21-sfu-b`, piped copy on A. Found an LVS hole: `GET /api/channels/:arn` returns the streamKey (logged, not asserted) | skipped: no UI | none: test and docs only, no version |
| 2026-10-16 19:30 | rm meeting 93/93; ui full 11179 pass; Storybook widths 36/36; DOM audit re-run via the committed adapter (findings only outside scope or Storybook artefacts) | independent review: G2/G5/G6/G11 partial, fixed (ui 2.474.0, `1743052`); doc wording fixed (Done means, G3 verb, G12 field); G21 hardened (auth on, two nodes, `f50f31d`); LVS streamKey read hole recorded for its owner | widths spec light + dark | ui 2.474.0; app wiring moved out to the next goal |
| 2026-10-16 21:00 | rm meeting + conversation-call 166/166 (new: lobby 3, useMeeting 1, mediaLobby 9); full 2485 pass, 63 skipped; exports/contract/packed ok | app goal M1 lanes L1 + L3. A no new authority: the call's signalling stays on `lobbyName`, a media move sends no call frame; B moves serialized, latest wins, a target landing mid-move is honoured after it; C a leave mid-move tears down at once and the late join ends its own session; D breakout media and chat go through the same `~breakout~` parse (`parseBreakoutChannel`), so guards strip before family matching; E a failed join keeps the call, `error` set, `rejoin()` in the current media lobby; I `mediaLobby` / `chatChannel` optional, unchanged when absent, result `mediaLobby` optional; J recipe + changelog | skipped: no UI | rm 0.134.0 (L1, L3); ui `createCallBlockHost` pass-through still owed (ui-components) |
