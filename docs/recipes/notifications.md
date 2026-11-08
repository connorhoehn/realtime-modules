# Recipe: Notifications

> Plug `notifications` into an app you already have. Three steps + a graduation path.

User-addressed toasts/badges delivered to every live tab; replay on reconnect when a store is wired.

For current recipient access and filtered replay across tenants, see
[direct recipient filtering](../integrations/current-direct-recipients.md).
Use `filterClientMessage` on the local attachment and `authorize` on the
notification feature; producer-time authorization alone does not protect
later replay.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, notifications } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [notifications()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

### Sending one

Attaching the feature gives you the delivery half. Nothing arrives until your
app pushes something, and it pushes by calling the service — not by a frame
from the browser, because who gets notified is your decision, not the
client's. `attachRealtime` hands the services back on the handle:

```ts
const notifier = realtime.services.notification;

// Wherever the thing worth telling someone about happens.
await notifier.notifyUser('u-carol', {
  type: 'mention',
  title: 'Eve mentioned you in #design',
  body: '…the pay figures are in the deck',
  channel: 'room:design',
});
// → { record, delivered }   `delivered` counts that user's live connections.
```

`delivered: 0` is not an error — it means that user has no tab open. Wire a
store (below) and they get it on reconnect; without one, the notification is
gone.

### Resolving one (0.147)

When a notification asks for something — an approval, a need — and it is
answered, take it out of every open inbox, not just the tab that acted:

```ts
await notifier.resolve('u-carol', 'need:approve-mina');   // the id it was sent with
// → { removed, delivered }   removed from the store; `notification:resolved` to every tab
```

Send needs with a stable `id` (the need's key) so the producer can resolve
them later; re-sending the same id replaces the entry in the hook's list.

## 2 — Client (React hook)

```tsx
import { useNotifications } from '@connorhoehn/realtime-modules/client';

function Inbox() {
  // User-scoped, not channel-scoped — no channel argument.
  const { notifications, unreadCount, markAsRead, markAllRead } = useNotifications();

  return (
    <>
      <button onClick={markAllRead}>{unreadCount} unread</button>
      <ul>
        {notifications.map((n) => (
          <li key={n.id} onClick={() => markAsRead(n.id)}>{n.title}</li>
        ))}
      </ul>
    </>
  );
}
```

Read marks persist to `localStorage` by default. Pass `{ storage }` for
sessionStorage or a React Native shim, or `{ storage: null }` for memory only.

**Read state is local to the device.** The hook sends nothing — it is a
receiver, and `markAsRead` moves a mark in local storage only. The service
does have `markRead` / `markAllRead` actions, but no hook calls them, so a
notification read on a laptop still shows unread on a phone. If you need read
state to follow the user, send those frames yourself via `useGateway()`.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **NotificationCenter**.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
notifications({ redisClient })  // node-redis v4 client → persistence + replay across tabs/sessions
```

A local, single-process app with no Redis can still replay on connect:

```ts
import { InMemoryNotificationStore } from '@connorhoehn/realtime-modules/notification';
notifications({ store: new InMemoryNotificationStore(), replayOnConnect: true })
```

`store` takes any `NotificationStore` (`append`, `list`, `listUnread`,
`markRead`, `markAllRead`, optional `remove`). `RedisNotificationStore` has no
`remove`, so `resolve` marks the record read there: it is not replayed, but it
still appears in `getHistory` as read.

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
