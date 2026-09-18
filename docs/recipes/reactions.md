# Recipe: Reactions

> Plug `reactions` into an app you already have. Three steps + a graduation path.

Per-channel (and per-target, via targetId) emoji reactions.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, reactions } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [reactions()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
import { useReactions } from '@connorhoehn/realtime-modules/client';

function MessageReactions({ channel, messageId, userId }: Props) {
  // targetId scopes the list to one message; omit it for floating call reactions.
  const { reactions, toggle } = useReactions(channel, { targetId: messageId });

  return (
    <>
      {reactions.map((r) => <span key={r.id}>{r.emoji}</span>)}
      {/* The chip is a toggle — `toggle` decides which way from the list it holds. */}
      <button onClick={() => toggle('🔥', { userId })}>🔥</button>
    </>
  );
}
```

`react` / `unreact` are there when you want to force a direction. Only
targeted reactions are removable — a floating one is an event that already
happened.

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **ReactionBar / your own emoji strip**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
// ephemeral counters — persist externally via a FeaturePlugin onMessage observer if you need durability
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
