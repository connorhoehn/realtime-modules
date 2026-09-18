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
chat({ store: myChatStore })  // implement ChatStore — the gateway's DdbChatStore is the reference
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
