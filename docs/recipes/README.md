# Recipes — plug interactivity into an existing app

Each capability is a vertical slice: server feature + client hook +
ui-components surface + a graduation path. They compose à la carte — every
feature works alone and in any combination (enforced by the attach test
matrix, all 78 pairs).

| Capability | Recipe | Feature | Hook |
|---|---|---|---|
| Live chat | [chat](./chat.md) | `chat()` | `useChat` |
| Presence | [presence](./presence.md) | `presence()` | `usePresence` |
| Live cursors | [cursors](./cursors.md) | `cursor()` | `useAwarenessState` |
| Reactions | [reactions](./reactions.md) | `reactions()` | `useReactions` |
| Activity feed | [activity](./activity.md) | `activity()` | `useActivity` |
| Rooms | [rooms](./rooms.md) | `rooms()` | `useChannel` |
| Calls / invites | [calls](./calls.md) | `calls()` | `useVideoHangout` |
| Notifications | [notifications](./notifications.md) | `notifications()` | `useNotifications` |
| File uploads | [file-uploads](./file-uploads.md) | `fileUploads()` | `useFileUpload` |
| Collab documents | [collab-docs](./collab-docs.md) | `collabDocs()` | `useCRDT` |
| Pinned messages | [conversation](./conversation.md) | `chat()` | `usePins` |

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

Authoring your own capability: `defineFeature({ manifest, create })` — it
plugs in identically to the built-ins. See `src/server/attach.ts`.
