# Redis peer routing

`RedisRealtimeRouter` is an opt-in transport for `attachRealtime`. It routes
direct messages, channel messages, broadcasts and call departure events
between replicas while each destination runs the local recipient filter
and current channel authorization. It does not replicate service state.

The host supplies connected Redis command/publish and subscriber ports.
For example, an application using node-redis can compose them as follows:

```ts
import { createClient } from 'redis'; // installed by the host application
import { attachRealtime, chat, RedisRealtimeRouter }
    from '@connorhoehn/realtime-modules/server';

const command = createClient({ url: redisUrl, disableOfflineQueue: true });
const subscriber = command.duplicate();
// Install error handlers and the host's bounded connection/command policy.
await Promise.all([command.connect(), subscriber.connect()]);
const router = new RedisRealtimeRouter({
    namespace: 'my-app:staging',
    nodeId: replicaId, // unique among live replicas
    redis: {
        command: (...args) => command.sendCommand(args),
        publish: (topic, payload) => command.publish(topic, payload),
        subscribe: async (topic, receive) => {
            await subscriber.subscribe(topic, receive);
            return () => subscriber.unsubscribe(topic);
        },
    },
    authorize: currentChannelAuthorization,
    filterClientMessage: currentRecipientAuthorization,
});
await router.start();
const realtime = attachRealtime(httpServer, {
    router,
    auth: authenticateUpgrade,
    features: [chat({ /* application's durable stores */ })],
});
// At shutdown: drain sockets/services, then unsubscribe/release this owner.
await realtime.dispose();
await Promise.all([subscriber.quit(), command.quit()]);
```

Host ports own credentials, TLS, error handling, reconnect policy and command
deadlines. Use a dedicated subscriber connection. These scripts operate on a
single Redis primary; Redis Cluster multi-slot scripts are not supported.
Namespaces separate routing keys/topics between applications/environments;
the Redis connection itself is trusted infrastructure. Auth contexts stored
in Redis must be JSON-safe and contain only the identity claims needed by
the host's authorization callbacks.

`auth` supplies identity before any registration. Registration must succeed
before services connect, the session frame is sent or incoming client work
is dispatched. Up to 32 early frames are retained in arrival order, bounded
also by the WS `maxPayload` aggregate bytes; overflow closes with 1009.
Generate globally unique client IDs and do not reuse them for new sockets.
Redis records include an independent connection generation and owner boot
ID so known captured recipients and old peer frames cannot adopt a new
connection. A local duplicate client ID or a second live node owner is refused.

Ownership and client leases default to 30 seconds and renew every third of
that interval. Delivery is fenced on renewal failure or local lease expiry.
A late successful renewal cannot revive a fenced router: dispose it and
create/start a fresh instance. Lease fencing does not close the host's TCP
sockets automatically. The host decides when to retire that replica.

`sendToClient` resolves `true` only after the owning node confirms an actual
socket write following its recipient checks. `false` means unconfirmed or
refused; a lost receipt can return `false` even though the frame was written.
There is no automatic resend. Duplicate peer request IDs share one delivery
result within the bounded dedup window; separate application retries have
separate IDs. This is not an exactly-once end-to-end protocol.

Channel/broadcast completion confirms publication and local fanout, not a
receipt from every remote recipient. Destination channel admission is
rechecked per message, and unsubscribe/resubscribe during an awaited filter
does not revive that old subscription's delivery. The transport provides
no global ordering across replicas or asynchronous recipient filters.

`getClientsByUserId` is asynchronous and returns only registrations whose
owner lease is current. REST readers should await `resolveClientData` or
`isClientAlive` and then check the current application directory/resource
authority. Synchronous `getClientData` exposes a local context or a bounded
cached remote context for legacy services; that cache is not a current
directory grant. Refresh the audience explicitly for a new delivery attempt.

For calls, supply a shared `CallStateStore` and pass
`crossNodePubSub: router.crossNodePubSub` to `calls()`. `attachRealtime`
forwards the router's asynchronous liveness probe to CallService. The
departure transport supports only `call:client-departed`. Call-state mirrors
are asynchronous, so signaling acknowledgement does not imply that every
state write has completed. Notifications likewise need the application's
durable inbox for history; live fanout alone does not persist it.

Presence, CRDT ownership/snapshots, cached chat membership, room state and
other service state require their own shared stores/invalidation policies.
Adding this router alone does not accept a multi-replica application.

Run the native transport, call recovery and socket-close contracts against a
dedicated local Redis:

```sh
REAL_ROUTER_REDIS=1 REAL_ROUTER_REDIS_URL=redis://127.0.0.1:16481 \
CALL_TEST_REDIS_URL=redis://127.0.0.1:16481 npm test -- --runInBand
```

The native fixture uses real Redis and two TCP WebSocket servers with explicit
fixture authority. Application directory, cloud deployment, capacity and
presence/CRDT replication are separate acceptance work.
