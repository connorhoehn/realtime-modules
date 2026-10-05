# Recipes — plug interactivity into an existing app

Each capability is a vertical slice: server feature + client hook +
ui-components surface + a graduation path. They compose à la carte — every
feature works alone and in any combination (enforced by the attach test
matrix, all 78 pairs).

| Capability | Recipe | Feature | Hook |
|---|---|---|---|
| Live chat | [chat](./chat.md) | `chat()` | `useChat` |
| Presence | [presence](./presence.md) | `presence()` | `usePresence` |
| Live cursors | [cursors](./cursors.md) | `cursor()` | `useCursor` |
| Reactions | [reactions](./reactions.md) | `reactions()` | `useReactions` |
| Activity feed | [activity](./activity.md) | `activity()` | `useActivity` |
| Rooms | [rooms](./rooms.md) | `rooms()` | none yet — frames via `useGateway()` |
| Calls / invites | [calls](./calls.md) | `calls()` | none yet — frames via `useGateway()` |
| Notifications | [notifications](./notifications.md) | `notifications()` | `useNotifications` |
| File uploads | [file-uploads](./file-uploads.md) | `fileUploads()` + REST routes you mount | `useFileUpload` |
| Collab documents | [collab-docs](./collab-docs.md) | `collabDocs()` | `useCRDT` |
| Pinned messages | [conversation](./conversation.md) | `chat()` + REST routes you mount | `usePins` |

**Broadcasting:** [streaming](./streaming.md) covers the other shape — one
publisher, many viewers — and the choice that decides whether it scales:
realtime WHEP (one peer connection per viewer) versus near-realtime HLS (a
cacheable segment any CDN carries). If viewers talk back they need realtime;
if they watch, near-realtime is cheaper by orders of magnitude.

**Composing them:** [conversation](./conversation.md) is the quick-start. It
assembles chat, files, documents, pins and calls into one surface whose view
set is DATA — the same component ships as chat-only in one product and
chat-plus-everything in another — then adds the rail beside it, so the two
together are an entire two-pane messaging app. It also covers the parts that
are easy to get wrong from outside: which conversations can have calls at all,
watching a channel instead of joining it (an audience of any size, for a few
seconds of latency), and the events that post themselves into a thread.

**Multi-tenant:** [channel-authorization](./channel-authorization.md) — the
one `authorize` hook every feature asks before a subscribe, a read or a write,
and the channel names it sees (`presence:<channel>`, `reactions:<channel>`,
`cursor:<channel>`, chat's unprefixed).

**Peer routing:** [redis-router](./redis-router.md) — opt-in Redis transport,
leased connection ownership, confirmed direct writes and the service state
that an application must share separately.

Authoring your own capability: `defineFeature({ manifest, create })` — it
plugs in identically to the built-ins. See `src/server/attach.ts`.

## Plugins — observe every publish

`attachRealtime(server, { plugins })` takes lifecycle observers. They see
traffic; they cannot change or stop it, and a plugin that throws never breaks
a send.

```ts
attachRealtime(server, {
    features: [chat(), presence(), reactions()],
    plugins: [{
        name: 'audit',
        onConnect: ({ clientId, channelId, userId }) => { /* subscribed */ },
        onDisconnect: ({ clientId, channels }) => { /* gone */ },
        onMessage: ({ clientId, channelId, message, userId }) => {
            // Before fan-out, for every feature's publish on `channelId`
            // (chat's channel, `presence:<channel>`, `reactions:<channel>`, …).
        },
    }],
});
```

`userId` (0.99.0) is the authenticated user behind the publishing
connection — the `userId` your `auth` returned for it, the same context that
names a chat message's sender. Read it rather than a `metadata.userId` in the
payload, which is chat-shaped and absent from presence and reactions.
`clientId` is `'server'` and `userId` is `undefined` for a server-originated
publish (a system message); `userId` is also `undefined` for a connection
with no authenticated user.
