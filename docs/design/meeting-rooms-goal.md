# Meeting rooms — goal (2026-10-16)

**Status: done (2026-10-16).** G1–G21 are met; the judge for each is below
and the evidence is in `meeting-rooms-audit.md` (backlog ticks, findings,
tick log). Out of scope by design: app wiring (aws-agentcore portal and BFF),
which waits on the user.

| # | Closed by |
|---|---|
| G1 brand colour | ui-components 2.464.0 |
| G2 library primitives | ui-components 2.464.0 |
| G3 announcements in chat | ui-components 2.466.0 (2.468.0 merged into the thread) |
| G4 room chat channel | realtime-modules 0.126.0 |
| G5 React binding | ui-components 2.465.0 |
| G6 fictional demo content | ui-components 2.464.0 |
| G7 picker surface tone | ui-components 2.465.0 |
| G8 rename keeps focus | ui-components 2.467.0 |
| G9 organizer on every replica | realtime-modules 0.127.0 |
| G10 event-catalog declarations | event-catalog 0.8.6 (`meeting@1.0.0`) |
| G11 wiring rehearsal | realtime-modules 0.128.0 + ui-components 2.468.0 |
| G12 clock skew | realtime-modules 0.129.0 + ui-components 2.469.0 |
| G13 announcement history | realtime-modules 0.130.0 + ui-components 2.471.0 |
| G14 rate limits | realtime-modules 0.132.0 |
| G15 server refuses what the catalog refuses | realtime-modules 0.131.0 (+ event-catalog 0.8.7 `meeting@1.1.0`) |
| G16 which chat am I in | ui-components 2.470.0 |
| G17 narrow widths | ui-components 2.472.0 |
| G18 DOM and accessibility audit | ui-components 2.473.0 |
| G19 scale budgets | test-only (both repos): 0.09 ms/hand, 0.3 ms auto-assign of 300, 30 KB snapshot |
| G20 typed frames | realtime-modules 0.133.0 |
| G21 live media | test-only, `test/e2e-media` (`db0309f`): real SFU, two headless browsers; producers move main → room ARNs and back, forged join refused; re-run independently and passing |

The definition of done for the Teams-style meeting library work (raise hand,
reactions, people queue, breakout rooms) after the first build and nine audit
ticks. `meeting-rooms-audit.md` stays the protocol and log; this file lists
what is still missing and how each item is judged. Every gap below was found
in a tick, a visual check or a user review. App wiring (aws-agentcore portal
and BFF) stays out until the user asks.

## Done means

All of G1–G10 checked, the audit gates green, the visual check clean under
two brands in light and dark, and the audit backlog empty except `blocked:`.

## Gaps

| # | Gap | Where found | Judge |
|---|---|---|---|
| G1 | **Brand color.** Highlights use the library `accent` (fixed purple). Apps point `--color-primary` at their brand (the portal: indigo for Org, teal for Assessment), so the toolbar's active underline, pressed Raise, focus ring and the consent privacy link stay purple in every tenant. | user review, 2026-10-16 | a ratchet test fails on `accent`, raw palette classes, `white` or `[#hex]` in our files; stories under a teal brand show teal |
| G2 | **Hand-drawn bits.** `×` glyph spans as close buttons (banner, consent card, pane header), a drawn radio dot on the consent card, `text-white` on the tile hand badge, raw sizes (`text-[10px]`, `text-lg`, `font-semibold`) beside `T`. | component-discipline review | the same ratchet test, plus close buttons found by role and name |
| G3 | **Announcements belong in the chat.** The pane's "Send an announcement to every room" box is a second composer. Organizers should send from the meeting chat with a "To: all rooms" target, and an announcement should appear as a marked message in the main and every room's chat. The banner keeps the latest one. | user review, 2026-10-16 | pane renders no composer by default; a chat binding merges `breakout.announcement` frames into the timeline (test); the composer's target sends `breakout.announce` (test); story shows both |
| G4 | **Rooms have no chat of their own.** Media moves to the room's lobby, but nothing names the room's chat channel, so an app would keep everyone in the main chat. | G3 design | `meetingChatChannel(meetingId, roomId?)` in `./meeting` and `./client/meeting`, tested; recipe shows the switch |
| G5 | **React is not bound.** `meetingToolbarItems` builds every button but React; each app would hand-wire `popover` + `ReactionPicker` + `useReactions`. | 2.463.0 tick | `meetingToolbarItems({ onReact })` adds a React item with the picker (test); MeetingStage story uses the binding |
| G6 | **Demo content copies real names.** Stories and tests reuse names from the reference screenshot (a real meeting). Demo content must be fictional. | visual tour, 2026-10-16 | no name from the reference appears under `src/` (grep in the ratchet test) |
| G7 | **Reaction picker has no light hover.** `ReactionPicker` is styled only for dark call chrome; hosted in the toolbar's light panel its options show no hover. | 2.463.0 tick | `ReactionPicker tone="surface"` (default unchanged), test + toolbar story uses it |
| G8 | **Rename drops keyboard focus.** `InlineEditableText` unmounts its input on Enter/Escape and focus falls to the body; room rename inherits it. | 2.459.0 tick | focus returns to the edit trigger after Enter and Escape (test) |
| G9 | **Organizer lobby check across replicas.** `admitsBreakoutLobbySync` recognises an organizer only after they acted on THIS replica; on another replica the sync guard refuses them until then. | 0.125.0 review | the verdict is recorded on every replica that sees the organizer's state through `watch` (`createdBy`), or the recipe says to use the async guard for organizers; test either way |
| G10 | **Event catalog.** The `meeting` frames are not declared. | backlog since 0.121.0 | declarations in `~/Projects/event-catalog` if the repo exists, else `blocked:` with the reason |

## Scope added by this goal

G7 and G8 touch shared components outside the audit's original table:
`src/components/video/ReactionOverlay.tsx` (an optional `tone` only) and
`src/components/forms/InlineEditableText.tsx` (focus restore only). Check
`git log -3` on each first; if the other session changed it in the last day,
hand the fix to it instead.

## Order

G6 and G1 first (what a viewer sees), then G2, G5, G7, G3 with G4, G8, G9,
G10. One release per item or per tightly coupled pair, each ticked in the
audit backlog with its release number.

## Wave 2 (2026-10-16, after G1–G9 shipped)

Found while finishing wave 1: by the event-catalog declarations (event-catalog
0.8.6), by reading the code for what a real meeting would hit, and by the
user's ask to keep refining before app wiring.

| # | Gap | Evidence | Judge |
|---|---|---|---|
| G11 | **Wiring rehearsal.** Every story builds the stage by hand; nothing proves the bindings compose into the whole screen. | `MeetingStage.stories.tsx` hand-builds toolbar items | a story and an integration test build the stage only from `meetingToolbarItems`, `meetingRosterProps`, `useMeetingChat`, `WrappedBreakoutRoomsPanel`, `WrappedBreakoutRoomBanner` over a real `MeetingService`; anything that needs glue becomes a binding |
| G12 | **Clock skew.** Countdowns compare the viewer's own clock with the server's `endsAt`; a laptop 40 s off shows a timer 40 s off and closes "early". | `BreakoutRoomBanner`, `BreakoutRoomsPanel` use `Date.now()` | snapshot and breakout frames carry `serverNow`; `useMeeting` exposes `clockOffsetMs`; banner and pane take an optional `now` offset; test with a skewed clock |
| G13 | **Announcement history.** The state keeps only the latest announcement, so a late joiner's chat shows one and a reload loses the rest. | `BreakoutState.announcement` | state keeps the last 20 (`announcements`, `announcement` stays the latest for old clients); `useMeetingChat` seeds from it; test a late joiner |
| G14 | **No rate limits.** A client can toggle its hand or announce in a tight loop and every frame fans out to the whole meeting. | no limiter in `MeetingService` | per-user token bucket on mutating verbs (configurable, generous default), `RATE_LIMITED` error, declared in event-catalog; test |
| G15 | **Server leniency the catalog refuses.** A bad `mode` or a non-object room draft is silently ignored; the catalog schema refuses it. | event-catalog 0.8.6 notes | the server refuses both with `INVALID_PAYLOAD`; catalog and server agree (test) |
| G16 | **Which chat am I in?** Inside a room the chat changes channel with no sign of it. | G4 | `meetingChatTitle(meeting)` ("Room 2 chat" / "Meeting chat") and a one-line notice when the chat switches; test |
| G17 | **Narrow widths.** Every visual check ran at desktop width. | tick log | stage, pane, toolbar and chat at 390 px and 768 px, light and dark: no horizontal scroll, More holds the folded buttons, the pane becomes a sheet or stacks |
| G18 | **DOM and accessibility audit.** No automated check of roles, names, contrast or focus order on the meeting stories. | no axe; ui-components ships `skills/ui-dom-audit` | run the ui-dom-audit skill over the meeting stories; fix every finding in our files |
| G19 | **Scale.** Nothing measures a 300-person meeting with 50 rooms: snapshot size, auto-assign, roster ordering. | — | a test with budgets (snapshot under 64 KB, auto-assign and ordering under 50 ms) |
| G21 | **Live media never exercised.** Breakout media is LVS (mediasoup SFU) leave-then-join, but every test uses a fake router and every story placeholder tiles. | user question, 2026-10-16 | two headless browsers with fake camera/mic join a real LVS lobby on a local SFU; organizer opens rooms; each client's media moves to its room lobby (SFU sees the producer leave one router and join the other), a non-member is refused by the guard, close brings everyone back. If no SFU can run locally without app changes, `blocked:` with what is missing |
| G20 | **Typed frames.** `useMeeting` frames are not checked against the catalog. | G10 follow-up | repin `@connorhoehn/event-catalog` to 0.8.6 and add `satisfies` on outbound frames. Needs `npm install` in realtime-modules' shared `node_modules`: do it only when no other session is working in realtime-modules, else `blocked:` |

Order: G11 first (it will surface glue the others need), then G21 (proves the
media path before more polish), G12, G13, G15, G14, G16, G17, G18, G19, G20.
