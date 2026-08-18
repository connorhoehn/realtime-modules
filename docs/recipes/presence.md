# Recipe: Presence

> Plug `presence` into an app you already have. Three steps + a graduation path.

Who is here, per channel, with display names and colors derived from the auth context (`auth: () => ({ userId, displayName })`).

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, presence } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [presence()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// usePresence
```

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **PresenceAvatars fed from the hook**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
// presence is ephemeral by design — no store to graduate; tune sweep intervals via presence({ heartbeatIntervalMs, … })
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
