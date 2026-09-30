# Recipe: Live chat

> Plug `chat` into an app you already have. Three steps + a graduation path.

Channel-based messaging with history, join/leave, and sender echo. Wire frames: `{service:"chat", action:"join"|"send"|"leave"|"history", channel, message}`.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, chat } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [chat()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

### Who sent it: the server says, not the frame

Since 0.98.5 a message's sender comes from the connection's auth context —
whatever your `auth` returned — never from the frame. For an authenticated
connection (a context with a `userId`) the service stamps `message.userId`
and `metadata.displayName` / `metadata.avatarUrl` itself and drops the
frame's copies of `userId`, `displayName` and `avatarUrl`, on `send` and on
`edit`. Typing and read receipts carry the same identity; edit and delete
are allowed only for the message's own `userId`. The frame's sender fields
are advisory: a socket cannot post under someone else's name.

Return the name from `auth` and it shows up everywhere:

```ts
auth: async (req) => {
    const claims = await verifyToken(req);
    return { userId: claims.sub, displayName: claims.name, org: claims.org };
},
```

The default mapping reads `userId`, `displayName` (or `name`) and `avatarUrl`
(or `picture`). If your context is shaped differently, map it:

```ts
chat({
    // Runs only for a context with a userId; return null to treat the
    // connection as unidentified. `frame` is untrusted input.
    resolveSender: (ctx, frame) => ({ userId: `${ctx.org}/${ctx.userId}`, displayName: String(ctx.fullName) }),
})
```

`chat({ trustFrameSender: true })` restores the old rule (the frame's
`metadata.displayName` / `avatarUrl` win and the server only fills gaps) for
a deployment that sets names client-side on purpose; `message.userId` is the
server's either way. A connection with no auth context (no `auth`, dev mode)
behaves as before: no `userId`, the frame's metadata kept.

## 2 — Client (React hook)

```tsx
import { GatewaySocketProvider, useChat } from '@connorhoehn/realtime-modules/client';

function ChatRoom({ channel }: { channel: string }) {
  const { messages, sendMessage, typingUsers, setTyping, editMessage, deleteMessage } =
    useChat(channel);

  return (
    <>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      {typingUsers.length > 0 && <em>{typingUsers.length} typing…</em>}
      <input
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') sendMessage(e.currentTarget.value);
        }}
      />
    </>
  );
}

// Wrap once, near the root — every hook shares this one socket.
<GatewaySocketProvider url="ws://localhost:3000" token={token}>
  <ChatRoom channel="room:general" />
</GatewaySocketProvider>;
```

`sendMessage(text, metadata?)` takes the text, not an object. `editMessage`
and `deleteMessage` act on your own messages by id.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedChatPanel (ui-components) — or ChatPanel with the hook wired manually**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
chat({ chatStore: myChatStore })  // any ChatStore
```

### DynamoDB: `DynamoChatStore`

The library ships a durable store over DynamoDB — the tables, keys, item
shapes and TTLs realtime-examples' gateway already writes, extracted from its
repositories, so both can share one implementation and that app could switch
with no data migration (`test/stores/dynamo/app-parity.test.ts` runs the same
operations against both and requires identical DynamoDB commands).

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { attachRealtime, chat } from '@connorhoehn/realtime-modules/server';
import { DynamoChatStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';

const store = new DynamoChatStore({
    client: new DynamoDBClient({}),  // or a DynamoDBDocumentClient — either works
    tables: { messages: 'chat-messages' },  // optional; every name has a default
    tablePrefix: process.env.DDB_TABLE_PREFIX,  // optional; prefixes every name
});

// Messages only:
attachRealtime(httpServer, { features: [chat({ chatStore: store })] });

// Messages + membership + read receipts + the conversations index a rail reads:
attachRealtime(httpServer, { features: [chat(store.chatOptions())] });
```

`@aws-sdk/client-dynamodb` (v3) is an optional peer — install it yourself;
the store only calls `client.send`. The tables it expects (create them in
your IaC; nothing here creates tables):

| Option (default) | Keys | Attributes | TTL |
|---|---|---|---|
| `tables.messages` (`chat-messages`) | PK `channelId`, SK `messageId` | `clientId`, `message`, `timestamp`, `metadata` (JSON string, omitted when empty), `userId`, `editedAt`, `deletedAt` | `ttl`, +90 days |
| `tables.conversations` (`chat-conversations`) | PK `userId`, SK `channel`; GSI `channel-index` (PK `channel`, projection ALL) | `peers` (JSON array), `lastMessageAt`, `lastMessagePreview` (140 chars), `lastMessageUserId`, `joinedAt`, per-person `pinned` / `mutedUntil` / `unreadFrom` / `section` | `ttl`, +90 days, rolling |
| `tables.members` (`chat-members`) | PK `channel`, SK `userId` | `role`, `addedBy`, `addedAt`, `historyFrom`, `removedAt` | none |
| `tables.reads` (`chat-reads`) | PK `channel`, SK `userId` | `readAt`, `updatedAt`, `displayName` | `ttl`, +90 days |

Enable DynamoDB TTL on the `ttl` attribute for the three tables that have
one. Other options: `ttlSeconds` (default 90 days), `channelIndexName`
(default `channel-index`), `logger` (index-write failures are logged, never
thrown).

`chatOptions()` returns `chatStore`, `membershipStore` (`store.members`),
`readReceiptStore` (`store.reads`) and the ChatService hooks that keep the
conversations index current: a DM send indexes both members; a channel send
indexes the sender and the recipients; an edit, a delete (previewed as
"Message deleted") or a server card patched in place with
`updateSystemMessage` moves the row's preview — a DM always re-indexes both
members with the pair as `peers`, never just the sender; a join seeds the
joiner's row; and `channelAudience` reads the GSI. Pass your own hooks to run
beside them — notifications, say:

```ts
chat(store.chatOptions({
    onDmMessage: (info) => notifyOthers(info),
    onChannelMessage: (info) => notifyOthers(info),
}))
```

Two things it cannot see: a card posted with `postSystemMessage` (a
document created in a DM, a call card) fires no hook, so index it yourself —
`await store.conversations.recordSystemMessage(channel, posted)` — and the
rail's reads and per-person state are yours to expose over HTTP:
`store.conversations.listForUser(userId)`, `setPinned` / `setMuted` /
`setUnreadFrom` / `setSection`, and `mutedMembers(channel, userIds)` for a
notification fan-out that respects mutes.

(`store` is the old spelling of that option and still works, but `chatStore`
is the one to write.)

**Chat has three stores, and only messages are covered above.** The other two
decide things a message store cannot:

```ts
chat({
  chatStore: myChatStore,               // the messages
  membershipStore: myMembershipStore,   // who is in a channel, and from when they may read
  readReceiptStore: myReceiptStore,     // per-person read cursors
})
```

`membershipStore` is the one to know about, because **it has no default**.
Leave it out and `addMembers` is refused outright — "Membership is not enabled
on this gateway" — and every channel stays readable by anyone who joins. That
is deliberate: membership is opt-in, not something the zero-config path turns
on behind you. But it does mean private channels need this wired before they
are private. `MemoryChatMembershipStore` from `./chat` gets you working
locally; it dies with the process, and an empty store means every channel is
open again after a restart.

`readReceiptStore` defaults to an in-memory one, so receipts work out of the
box and die with the process. On multiple nodes the live receipt still fans
out through the router, but the replay a client gets on request is only the
node it asked — wire a shared adapter in production. Pass `null` to switch
receipts off entirely.

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
