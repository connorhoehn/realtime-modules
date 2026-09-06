# Recipe: a whole conversation

> Not one capability — the composition of several into the surface people
> actually mean when they say "add chat". Messages, the files shared in the
> thread, the documents written in it, the pinned messages, the times you were
> named, and the calls recorded from it.

The other recipes each add one capability. This one is about assembling them,
because a conversation that is only a message list sends people somewhere else
for everything that came out of the conversation.

## The idea: which views exist is DATA

The same component ships as chat-only in one product and chat-plus-everything
in another. That is only possible if the set of views can be handed over at
runtime, which is why it is an array and not six boolean props:

```
effective views = declared by the host  ∩  provisioned by the gateway
```

Either gate alone is wrong, in a different direction each time:

- **declared only** — you ship a Documents tab against a gateway with no
  document service. The tab is empty forever, which reads as a broken feature
  rather than an absent one.
- **provisioned only** — a product that deliberately ships chat-only grows
  tabs the day an operator enables something server-side.

## 1 — Server

Nothing new to attach. The views map onto capabilities you already run:

| View | Needs |
|---|---|
| `chat` | `chat()` |
| `files` | `chat()` + `fileUploads()` |
| `documents` | `collabDocs()` |
| `pins` | `chat()` (pins are channel state, served over REST) |
| `calls` | `calls()` — **and a lobby.** See below. |

`mentions` is deliberately absent. Mentions span every conversation, so a
per-channel tab claims a scope it does not have: it would show you the same
list whichever thread you opened. They belong on the RAIL, beside the
conversation list — see "The whole app" below.

**Calls need a lobby, not just a service.** A call is addressed to a lobby, and
only some conversations have one: `chat:dm:a:b` → `dm:a:b`, `room:x` → `room:x`,
and a plain channel like `general` → nothing. Declaring `calls` on a channel
that cannot have them produces a Calls tab whose empty state promises
recordings that can never exist. `conversationFeaturesFor` answers this for
you — pass it your channel and it drops what that conversation cannot do.

A gateway answers `GET /api/capabilities?name=conversation.documents&channel=…`
with the verdict, and names what is missing when the answer is no
(`requires: crdt`) — the difference between a fix and a guess.

## 2 — Client

```tsx
import {
  useChat,
  usePins,
  useCapabilities,
} from '@connorhoehn/realtime-modules/client';
import {
  WrappedConversationSurface,
  capabilityNamesFor,
  conversationFeaturesFor,
} from '@connorhoehn/ui-components/integrations/realtime-modules';
import { ChatPanel } from '@connorhoehn/ui-components';

// What THIS product ships, narrowed to what THIS conversation can do.
// `hasDocuments: false` is how a chat-plus-calls embed drops the Documents
// tab; the channel is what drops Calls from a conversation with no lobby.
function Conversation({ channel }: { channel: string }) {
  const declare = useMemo(
    () => conversationFeaturesFor({ channel, hasDocuments: true }),
    [channel],
  );

  const chat = useChat(channel);
  const pins = usePins(channel);
  const caps = useCapabilities(capabilityNamesFor(declare), channel);

  return (
    <WrappedConversationSurface
      name="Hank Anderson"
      declare={declare}
      capabilities={caps.enabled}
      // A gateway that is momentarily failing is not a gateway that
      // provisions nothing — without this, one 500 strips every view.
      capabilitiesError={caps.error}
      pins={pins.pins}
      onUnpin={pins.unpin}
      onStartCall={(audioOnly) => startCall(channel, audioOnly)}
    >
      <ChatPanel fill showHeader={false} messages={chat.messages} onSend={chat.send} />
    </WrappedConversationSurface>
  );
}
```

The transcript is `children`, not a prop, because a product's composer is the
piece most likely to be its own. Everything else is data in and callbacks out:
the surface does no fetching, opens no sockets, and knows nothing about your
router — `onOpenDocument` and `onOpenRecording` hand ids back and you decide
where they go.

## Chat-only, in one line

```tsx
<WrappedConversationSurface name={peer} declare={['chat']}>
  <ChatPanel fill showHeader={false} messages={chat.messages} onSend={chat.send} />
</WrappedConversationSurface>
```

No tab bar renders at all. A feature that is not declared is not there — no
greyed tab, no upgrade prompt, because a tab that cannot do anything is worse
than a tab that is not there.

## The whole app: a rail and a surface

The surface above is the RIGHT pane. On its own an embedder still has to build
the left one, and the two share a thing neither owns — what the pane is
showing. Mentions and `#general` cannot both be open, so a host wiring a shelf
and a list by hand has to remember to clear the other's selection, and the
failure is not a crash: it is two highlighted rows and a pane showing one of
them.

`ConversationRail` takes ONE selection and hands one back, which makes the
exclusivity structural:

```tsx
const [selected, setSelected] = useState<RailSelection | null>(null);

<ConversationRail
  shelf={[{ id: 'mentions', label: 'Mentions', icon: '@', count: unread, urgent: true }]}
  conversations={rows}
  selected={selected}
  onSelect={setSelected}
  onNewChat={() => setPickerOpen(true)}
/>

{selected?.kind === 'shelf'
  ? <ChannelMentionsPanel mentions={mentions} onJump={(channel) => setSelected({ kind: 'conversation', channel })} />
  : <Conversation channel={selected!.channel} />}
```

That is the entire two-pane product. The `WholeApp` story in
`Social/ConversationRail` is this, runnable, with fixtures to swap out.

## Watching instead of joining

A conversation that many more people watch than speak in — an all-hands, a
demo — should not make every viewer open a peer connection. The same channel
can be delivered two ways, and the difference is capacity, not taste:

| | transport | latency | cost |
|---|---|---|---|
| **Join** | WHEP (`useLVSSubscriber`) | sub-second | one peer connection PER VIEWER |
| **Watch** | HLS (`useLVSLiveHls`) | a few seconds | segmented HTTP; a CDN carries any audience |

If viewers TALK BACK they need realtime. If they watch, near-realtime is
cheaper by orders of magnitude and looks identical on screen.

Resolve the channel WITHOUT joining. The reusable piece is the route, not a
hook — a viewer must not be enrolled as a participant just to learn where to
watch, which is what asking for a session would do:

```
GET /api/video/sessions/by-lobby/:lobbyName   →  { channelArn, sessionId, … }
                                              →  404 when nothing is live
```

The 404 is the useful half: it is what lets you hide the affordance rather
than offer a button that leads nowhere. Wrap it in whatever your app calls a
data hook.

```tsx
const channelArn = useYourLobbyLookup(channel);   // the GET above

<WrappedConversationSurface … onWatch={channelArn ? () => setWatching(true) : undefined}>

<WrappedStreamStage
  channelArn={channelArn}
  mode="near-realtime"          // or "realtime"; the mode is DATA
  baseUrl={LVS_URL}             // needed unless you mount rm's LVSProvider
  chatMessages={ticker}         // the conversation IS the stream's chat
/>
```

## What appears in the thread on its own

Two things post themselves into the conversation, so a host renders nothing
extra to get them:

- **A document created in the conversation** arrives as a card with its live
  editors' faces (`documentEditors` supplies who is in it right now).
- **A call that happened** arrives as a record when it ENDS — who started it,
  how long, who was in it. Not while it is running: a stored message is
  replayed forever, so a "call in progress" row would still be advertising a
  call hours later.

Both are ordinary messages carrying `metadata`. If you render your own
transcript, read them with the exported `documentRefFromMetadata` and
`callRefFromMetadata` rather than re-deriving the shapes — a created document
and a SHARED one carry different keys, and checking one lets the other
through.

## Two things that are easy to get backwards

**Omit `capabilities` entirely when you have no capability service.** Passing
an empty map means "the gateway provisions nothing" and leaves a bare
transcript. Omitting it means "there is nothing to ask", and your declaration
stands on its own.

**`chat` is never gated.** `useCapabilities` reports every unresolved name as
`false` by design, so a caller never flashes a control it is about to hide.
That is right for the extra views and wrong for the thing they hang off — the
transcript would blank for the moment capabilities are loading.

## Graduate to production

- **Pins** need a durable store behind `/api/chat/pins`; without one the tab
  loads empty and stays empty.
- **Documents** bind to a conversation through `DocumentMeta.channel`, which
  is persisted metadata rather than a wire-only field. Confirm your metadata
  store carries it, or a rename will silently unbind the document.
- **Capabilities** are only as honest as the gateway's answer. Check that
  composite names resolve against the services that are actually running, not
  a static list — a gate that reports a working feature as absent is worse
  than no gate.
