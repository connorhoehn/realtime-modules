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
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// `calls()` speaks `{ service: 'call' }` and broadcasts
// `{ type: 'call', action: 'invite' | 'active-call' | 'ended' | ... }`.
// No hook in ./client sends those yet, so read them off the socket directly.
import { useGateway } from '@connorhoehn/realtime-modules/client';

function CallInvites({ lobby }: { lobby: string }) {
  const { send, onMessage } = useGateway();
  const [invite, setInvite] = useState<any>(null);

  useEffect(
    () =>
      onMessage((msg: any) => {
        if (msg.type === 'call' && msg.action === 'invite') setInvite(msg);
      }),
    [onMessage],
  );

  const ring = () => send({ service: 'call', action: 'invite', lobby });

  return invite
    ? <button onClick={ring}>incoming call</button>
    : <button onClick={ring}>start a call</button>;
}
```

**`useVideoHangout` is not the client half of `calls()`.** It sends
`service: 'videohangout'`, and this package ships no such service — against
`attachRealtime` every frame it sends comes back `SERVICE_NOT_AVAILABLE`. It is
the signalling client for a live-video-streaming deployment, which serves that
service and hands back the `joinToken` that `./client/video` (`<Stage>` /
`useLVSHangout`) needs. Point it at that deployment, not at `calls()`.

`calls()` is the invite and call-state service: who is being rung, what is
active, what ended. Its verbs are listed above; a hook for them does not exist
yet.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

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

## Document calls

A call that belongs to a document review (2026-09-24): a title, a list of
review documents, a presenter others can follow, and per-person ring state.
Server side, pass a meta store to the call service:

```ts
import { CallService, RedisCallStateStore, RedisDocumentCallMetaStore } from '@connorhoehn/realtime-modules/call';

new CallService({
  messageRouter, logger,
  stateStore: new RedisCallStateStore(redis),
  metaStore: new RedisDocumentCallMetaStore(redis),       // call:meta:<callId>, TTL 4 h
  onOfflineInvite: (userId, invite) => notifications.notifyUser(userId, …),
  isClientAlive: (clientId) => nodeOfClientHasHeartbeat(clientId),
});
```

New actions: `meta` (reply `call-meta` to the asker), `set-documents`,
`present` and `set-title` (each broadcasts `call-meta`); server-only
`call-meta` and `invite-expired`; `user-status` gains `reconnecting`. An
invite with `kind:'document-review'` writes the meta; rings expire per person
(the caller gets `invite-expired`), and a call someone answered is never ended
by a ring timing out. Document calls never broadcast to every connected
client.

Client side (`./client/video`): `useDocumentCall` for the call,
`useIncomingDocumentCalls` for the rings, `useMediaDevices` and
`useAudioVideoSettings` for the settings drawer. `useDocumentCall` mints the
LVS stage token (`lvs`); mount `LVSHangoutSessionProvider` with it and pass
the session back as `media` so toggles and members line up.
