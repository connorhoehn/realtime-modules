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

**Composing them:** [conversation](./conversation.md) assembles chat, files,
documents, pins, mentions and calls into one surface whose view set is data —
the same component ships as chat-only in one product and chat-plus-everything
in another.

Authoring your own capability: `defineFeature({ manifest, create })` — it
plugs in identically to the built-ins. See `src/server/attach.ts`.
