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
    auth: async (req) => ({ userId: await verifyToken(req) }),   // required to join a room
    // Judges `room:<slug>` for every room action and every room frame.
    authorize: ({ channel, ctx }) => sameTenant(channel, ctx),
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Since 0.146.0 every room action asks the router about `room:<slug>` first —
`subscribe` to watch a room, `publish` to join, leave or announce it — and each
member, occupancy and lifecycle frame is re-checked per recipient, so the
`rooms:index` stream lists only rooms a connection may read (per tenant, given
a tenant `authorize`). A `join` records the socket's authenticated `userId` and
`displayName`; the frame's are ignored, and a socket with no `userId` cannot
join.

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

**These hooks do not talk to `rooms()`.** `./client/hangout-rooms` is a REST
client for a rooms API — `GET/POST ${baseUrl}/api/rooms…` — with an optional
WS adapter for live echoes. Its adapter reads frames shaped
`{ type: 'room.member-joined' }`, while `RoomService` broadcasts
`{ type: 'room', action: 'member-joined' }`. Same events, different envelope,
so nothing arrives. The two halves are wired to different servers by design:
the hooks expect a deployment serving the rooms REST API, `rooms()` is the WS
membership and occupancy service.

Attach `rooms()` when you want the WS side — subscribe, join, leave, announce,
and the occupancy broadcasts — and read those frames through `useGateway()`
until a hook exists for them.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedHangoutRoomsList / HangoutRoomsSection**.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
rooms({ stateStore: new RedisRoomStateStore(redis) })  // multi-replica occupancy; metrics via rooms({ metrics })
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.

## Saved room layouts

`HangoutPlan`, `HangoutPlanInput`, `parseHangoutPlanInput` and
`HANGOUT_PLAN_LIMITS` come from `@connorhoehn/realtime-modules/hangout-rooms`.
That entry point and its REST client need no React, Node builtin or server SDK.
The validator normalizes names and strips untrusted metadata. The host stamps
`updatedBy` and `updatedAt`, increments the validated version, and compares
`expectedVersion` atomically at storage. A plan holds up to 50 rooms and 500
unique assignments; an assignment does not grant access to a private room and
does not describe who is live in it.
