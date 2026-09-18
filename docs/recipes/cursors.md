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
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
import { useCursor } from '@connorhoehn/realtime-modules/client';

function CursorLayer({ channel, myClientId }: Props) {
  // selfClientId keeps a stale cursor of your own out of the list.
  const { cursors, move } = useCursor(channel, { selfClientId: myClientId });

  return (
    <div onPointerMove={(e) => move({ x: e.clientX, y: e.clientY })}>
      {cursors.map((c) => (
        <Pointer
          key={c.clientId}
          x={c.position.x as number}
          y={c.position.y as number}
          color={c.metadata.userColor}
          initials={c.metadata.userInitials}
        />
      ))}
    </div>
  );
}
```

`move` is throttled to the interval the service enforces (250 ms) and holds the
last suppressed position for the trailing edge, so wiring it straight to
`onPointerMove` is the intended use — the resting position still lands.

Modes other than `freeform` take different position fields: `{ row, col }` for
`table`, `{ position }` for `text`. Pass `{ mode }` to pick one.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

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
