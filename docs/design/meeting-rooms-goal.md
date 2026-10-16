# Meeting rooms — goal (2026-10-16)

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
