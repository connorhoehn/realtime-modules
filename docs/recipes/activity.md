# Recipe: Activity feed

> Plug `activity` into an app you already have. Three steps + a graduation path.

App-level event stream (doc created, user joined, …) with replayable history.

**It is app-level, not room-level.** Live events go to every subscriber of
every channel: the server publishes them to one global `activity:broadcast`
channel that each client is auto-subscribed to on connect, and no frame
carries a channel to filter on. `useActivity('room:1')` will show you events
published from `room:2`.

The `channel` argument scopes `loadHistory` — history frames do carry
`channelId` and the hook filters on it — so the replay is per-channel while
the live tail is not. If a feed must not show one room's activity to another
room's viewers, do not build it on this.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, activity } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [activity()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
import { useActivity } from '@connorhoehn/realtime-modules/client';

function ActivityFeed({ channel }: { channel: string }) {
  const { events, loadHistory } = useActivity(channel);

  return (
    <>
      <button onClick={() => loadHistory(100)}>load more</button>
      <ul>{events.map((e, i) => <li key={i}>{e.eventType}</li>)}</ul>
    </>
  );
}
```

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedActivityPanel**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
activity({ historyStore: myStore })  // implement ActivityHistoryStore for durable feeds
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
