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
| Meetings (raise hand, breakout rooms) | [meetings](./meetings.md) | `meeting()` from `./meeting` | `useMeeting` |
| Notifications | [notifications](./notifications.md) | `notifications()` | `useNotifications` |
| File uploads | [file-uploads](./file-uploads.md) | `fileUploads()` + REST routes you mount | `useFileUpload` |
| Collab documents | [collab-docs](./collab-docs.md) | `collabDocs()` | `useCRDT` |
| Pinned messages | [conversation](./conversation.md) | `chat()` + REST routes you mount | `usePins` |
| One host socket, many consumers | [shared-socket](./shared-socket.md) | `pipeline()` / the `subscribe` service | `useSharedWebSocket`, `useSharedSocketTransport` |

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
    auth, authorize, allowedOrigins: ['https://app.example.com'],   // required since 0.147.0
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

## Composition, startup and disposal

Since 0.147.0 `createRealtimeServer` starts only with `insecureAllowAll: true` (it has no
authorization seam; production uses `attachRealtime` with `authorize`).

`attachRealtime` and `createRealtimeServer` check the whole feature graph
before they create a service or install a listener. Dependencies may name a
manifest or its wire alias. A missing dependency, a duplicate identity, an
alias collision or a cycle throws synchronously. Independent features keep
their input order; dependencies are constructed first and shut down last.
`ctx.service(name)` resolves either name. Legacy wire names are unchanged
(`pipeline-ws` maps to `pipeline`), and an unknown legacy feature name throws
with a hint to use `attachRealtime` / `defineFeature`.

A manifest may declare `adapterRequirements: [{ provider: 'chat-store',
capabilities: ['conditional-write'] }]`. Pass matching `capabilityProviders` to
either entry point; the check uses service-runtime's static evaluator. A
declaration does not prove availability: the host still needs live readiness
probes and must describe the adapters it actually injects.

Factories are synchronous, so the host owns asynchronous readiness before it
attaches. A factory registers resources it has partly acquired with
`ctx.onCleanup?.(fn)` during `create()`; the hook is supplied by attachment,
and a caller that invokes a factory directly owns its own cleanup. A returned
service has its `shutdown()` or `stop()` called once, so do not also register
that call. `dispose()` drains sockets, then reverses service and resource
construction, then closes the router. Repeated calls return the same promise.
Cleanup continues after an error and rejects with an `AggregateError` once
every resource has been attempted. A startup failure still throws
synchronously: the `RealtimeStartupError` keeps the original `cause` and
exposes `cleanup`, a promise of cleanup failures (empty after a clean
rollback). Await it before you retry the attachment.
