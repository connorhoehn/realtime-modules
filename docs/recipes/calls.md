# Recipe: Calls / hangout invites

> Plug `calls` into an app you already have. Three steps + a graduation path.

User-addressed call invites, accept/decline/end lifecycle, participant state broadcast. Requires `auth` so userIds route (`getClientsByUserId`).

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, calls } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [calls()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// useVideoHangout family (client/video) for the media; call frames for invites
```

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedHangoutLayout, HangoutRoomRow**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
calls({ stateStore: new RedisCallStateStore(redis) })  // multi-replica call state; cross-node pub/sub via CallServiceOptions
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
