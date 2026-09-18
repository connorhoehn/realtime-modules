# Recipe: Rooms

> Plug `rooms` into an app you already have. Three steps + a graduation path.

Named shared spaces with live occupancy deltas — the primitive under hangout lists and lobbies.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, rooms } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [rooms()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
import { useHangoutRooms } from '@connorhoehn/realtime-modules/client/hangout-rooms';

function RoomList() {
  const { rooms, isLoading, createRoom, joinRoom, archiveRoom } = useHangoutRooms();

  if (isLoading) return <Spinner />;

  return (
    <ul>
      {rooms.map((r) => (
        <li key={r.slug}>
          {r.name}
          {/* Resolves to the SFU session details, ready for <Stage>. */}
          <button onClick={() => void joinRoom(r.slug)}>join</button>
        </li>
      ))}
    </ul>
  );
}
```

`useRoomOccupancy` and `useRoomMembers` cover who is in a room right now. The
REST functions behind these hooks are exported from the same subpath, so SSR
and scripts can use one transport without pulling in React.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedHangoutRoomsList / HangoutRoomsSection**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
rooms({ stateStore: new RedisRoomStateStore(redis) })  // multi-replica occupancy; metrics via rooms({ metrics })
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
