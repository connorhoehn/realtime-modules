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
| `mentions` | `chat()` + `notifications()` |
| `calls` | `calls()` |

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
} from '@connorhoehn/ui-components/integrations/realtime-modules';
import { ChatPanel } from '@connorhoehn/ui-components';

// What THIS product ships. Everything else follows from it.
const DECLARE = ['chat', 'files', 'pins', 'calls'] as const;

function Conversation({ channel }: { channel: string }) {
  const chat = useChat(channel);
  const pins = usePins(channel);
  const caps = useCapabilities(capabilityNamesFor(DECLARE), channel);

  return (
    <WrappedConversationSurface
      name="Hank Anderson"
      declare={DECLARE}
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
