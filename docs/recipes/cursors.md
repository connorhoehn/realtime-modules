# Recipe: Live cursors

> Plug `cursors` into an app you already have. Three steps + a graduation path.

Low-frequency cursor/selection broadcast within a channel.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, cursor } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [cursor()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// useAwarenessState (or the cursor frames directly)
```

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **your canvas/editor overlay — cursors are app-geometry-specific**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
// ephemeral — nothing to graduate
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
