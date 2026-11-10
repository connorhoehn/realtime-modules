# Channel authorization — `attachRealtime({ authorize })`

One hook decides who may read and write every channel, for every built-in
feature. Since 0.147.0 it is required: `attachRealtime` throws without
`authorize` (or `insecureAllowAll: true`, local development only), and a
connection whose token has no `exp` is refused:

```ts
import { attachRealtime, chat, presence, reactions, cursor, splitServiceChannel }
    from '@connorhoehn/realtime-modules/server';

const realtime = attachRealtime(httpServer, {
    features: [chat(), presence(), reactions(), cursor()],
    auth: async (req) => {
        const claims = await verify(req);
        return { userId: claims.sub, org: orgOf(req), exp: claims.exp };   // exp in seconds
    },
    // Tenant scoping: a channel belongs to the org it is prefixed with.
    authorize: ({ kind, channel, ctx }) =>
        !!ctx && splitServiceChannel(channel).channel.startsWith(`${ctx.org}:`),
    // Browser upgrades from any other Origin are refused with 403.
    allowedOrigins: ['https://app.example.com'],
});
```

## What the hook sees

`authorize({ kind, clientId, channel, ctx })` — `ctx` is what `auth` returned
for the connection.

**`kind: 'subscribe'`** — joining a channel's fan-out, and every read that
hands channel state back: presence `subscribe` / `get`, reaction `subscribe`,
cursor `subscribe` / `get`, chat `join` / `history` / `members` / `receipts`,
the generic `subscribe` service, and the subscribe of activity, social,
typed-documents, ingest, pipeline and crdt.

**`kind: 'publish'`** — every write that stores or fans out: presence `set`
(once per channel it lists), reaction `send` / `remove`, cursor `update`, chat
`send` / `edit` / `delete` / `typing` / `read` / `addMembers` /
`removeMember`, and the router's `sendToChannel` whenever a publisher is
named.

**Channel names.** Three features wrap the client's channel in a prefix of
their own:

| Feature | Channel `authorize` receives |
|---|---|
| presence | `presence:<channel>` |
| reactions | `reactions:<channel>` |
| cursor | `cursor:<channel>` |

Chat, activity, social and crdt pass the client's channel unchanged.
typed-documents subscribes `doc:<documentId>` and `doc-comments:<documentId>`;
ingest (`ingest:…`) and pipeline (`pipeline:…`) channels arrive as the client
named them. `splitServiceChannel(name)` returns `{ service, channel }` —
`service` is `'presence' | 'reactions' | 'cursor'`, or `null` with the name
unchanged — so a rule strips the wrapping once instead of hand-rolling it.

## What a refusal does

Nothing happens on the channel: no subscription, no ack, no roster/history/
cursors handed back, no stored write, no fan-out. The client receives

```json
{ "type": "error", "service": "presence", "code": "AUTHZ_CHANNEL_DENIED",
  "kind": "subscribe", "channel": "acme:lobby", "message": "…",
  "error": { "code": "AUTHZ_CHANNEL_DENIED", "message": "…", "timestamp": "…" } }
```

`channel` is the name the client sent (without the service prefix). A
presence `set` naming a refused channel still updates the sender's own status;
the refused channel is left out of the entry.

**Presence `get` by `targetClientId`** is not scoped to one channel, so it is
checked against every channel the target is present in (`subscribe`, both
layers). The caller gets the entry with only the channels it may read; a
target in no readable channel — including a target in no channel at all —
answers `{ "type": "error", "service": "presence", "message": "Client not
found" }`, exactly like a clientId that does not exist, and these checks send
no `AUTHZ_CHANNEL_DENIED` frame. A client reading itself, and any read on an
attachment started with `insecureAllowAll: true`, gets the whole entry.

## Per-feature hooks

`presence({ authorizeChannel })`, `reactions({ authorizeChannel })` and
`cursor({ authorizeChannel })` receive the unprefixed channel and run in
addition to `authorize` — both must pass. They gate subscribe, the reads, and
the writes (presence `set`, reaction `send`/`remove`, cursor `update`).

## Custom routers

`attachRealtime({ router })` makes channel authz the router's job. Services
ask it through `router.subscribeToChannel` (a `false` return is a refusal)
and the optional `router.checkChannel(kind, clientId, channel, { service,
clientChannel, silent })`; since 0.147.0 a router without `checkChannel` is refused (the
services that need it throw) unless `insecureAllowAll: true`. `silent: true` means "refuse without sending the
error frame". A router may add `hasChannelAuthorize()` returning false when it
has no channel authz; without it, a router with `checkChannel` is assumed to
enforce (so presence `get` by id hides channel-less entries of other clients).
`new LocalRealtimeRouter({ authorize })` and `new RedisRealtimeRouter({ authorize, … })`
require the hook too, or `insecureAllowAll: true`.
