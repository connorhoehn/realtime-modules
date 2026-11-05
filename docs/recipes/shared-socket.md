# One host socket, many consumers (0.144.0)

An app that owns its own WebSocket — rather than mounting
`GatewaySocketProvider` — usually hands it to more than one consumer:
several `usePipelineRunStatus` cards, ui-components' `EventStreamProvider`
(`channelTransport`), and its own frame handler. Three things go wrong with a
bare socket:

- `useWebSocket` takes one `onMessage`, so frames reach one consumer.
- The server keeps **one** subscription per socket and channel. When two views
  watch the same run, the first to unmount unsubscribes the other.
- A reconnect is a new server connection that has subscribed to nothing.

`createSharedSocketTransport` (framework-free) and its React bindings fix all
three. Exported from `./client`, `./client/ws` and `./client/pipelines`.

```tsx
import { useSharedWebSocket, usePipelineRunStatus } from '@connorhoehn/realtime-modules/client/pipelines';

function App() {
  // useWebSocket + fan-out. onMessage (optional) is the host's own handler.
  const { socket, transport } = useSharedWebSocket({ url, authToken, onMessage: onHostFrame });
  return (
    <EventStreamProvider channelTransport={transport.asChannelTransport()}>
      <RunCard transport={transport} sessionEpoch={socket.sessionEpoch} />
    </EventStreamProvider>
  );
}

function RunCard({ transport, sessionEpoch }) {
  const status = usePipelineRunStatus(runs, {
    apiBaseUrl, idToken,
    transport: transport.asPipelineRunTransport(),
    sessionEpoch, // re-reads unsettled runs after a reconnect
  });
}
```

Already have a socket? `useSharedSocketTransport(ws)` binds one (`send`,
`sessionEpoch`, `connectionState`); hand each inbound frame to
`transport.deliver`.

## What the transport does

- **Fan-out.** `deliver(frame)` calls every `onMessage(handler)` handler. A
  handler that throws is reported (`onHandlerError`, default `console.error`)
  and the others still run.
- **Refcounted channels.** `subscribe(channel, { service? })` returns a
  release. The first hold sends `{ service, action: 'subscribe', channel }`;
  the last release sends the unsubscribe. The service defaults to
  `'pipeline'` for `pipeline:*` channels and `'subscribe'` otherwise (since
  0.143.0 the `subscribe` service delegates `pipeline:` channels to the
  `pipeline()` feature, so both reach the same gate).
- **Coalesced releases.** The last release's unsubscribe waits a microtask
  (`scheduleRelease`), so a release followed by a re-hold in the same tick —
  React re-running an effect — sends nothing.
- **Per-epoch re-subscription.** `sessionEpoch` `0` holds channels without
  sending; each new epoch re-sends every held channel exactly once. The React
  binding updates in a layout effect, before consumers' passive effects, so
  hooks that release and re-hold on the new epoch add no frames.

## The adapters

- `asPipelineRunTransport()` — the `{ send, onMessage }` shape
  `usePipelineRunStatus` and `usePipelineCatalog` take. Subscribe and
  unsubscribe frames sent through it become holds and releases (they must be
  paired; the library hooks pair them). Other frames pass through.
- `asChannelTransport()` — the `{ subscribe, unsubscribe }` shape of
  ui-components' `EventStreamChannelTransport`. Its identity is stable: the
  shared transport re-subscribes after a reconnect, so the provider's
  subscribers do not re-run for it.

Both drop an unsubscribe for a channel they never held, rather than releasing
another consumer's hold.

## `GatewaySocketProvider`

Hosts on the provider get the same reconnect controls as `useWebSocket`:
`autoResubscribe` (default false) and `maxRetries` (default unlimited) are
forwarded.

## Live refresh

(0.145.0.) Most screens render a durable record — a project, a run — and use
frames only as hints that it moved. `useLiveRefresh` is that loop, so apps stop
hand-rolling "frame → coalesced re-read" and "socket up, else poll":

```tsx
// App shell: one socket, in context. The transport is never null.
<SharedSocketProvider options={{ url: `${wsBase}/events`, onMessage, maxRetries: 5 }}>
  <App />
</SharedSocketProvider>

// Any page:
const { data: project, live, error, refresh } = useLiveRefresh(
  (signal) => request<Project>(`/api/projects/${id}`, { signal }),
  {
    channel: `studio:project:${id}`,
    isHint: (f) => f.type === 'studio.work.changed' && f.projectId === id,
    coalesceMs: 100,
    pollMs: 15_000,
  },
);
```

- **Live** is the socket connected AND the channel's subscribe acknowledged in
  the current session (`{ action: 'subscribed', channel }` from the
  `subscribe` service or the `pipeline()` feature). The transport tracks this
  per channel: `transport.channelState(channel)` is `'unheld' | 'pending' |
  'subscribed' | 'refused'`, and `onChannelState(fn)` reports changes. A
  refusal (`PIPELINE_CHANNEL_REFUSED`, `AUTHZ_CHANNEL_DENIED` with `kind:
  'subscribe'`) or no answer at all keeps the hook polling — a server may
  refuse e.g. `studio:project:<id>`. `isRefusal(frame)` adds refusals that name
  another channel (a `channelFor`-mapped router channel).
- **Hints.** While live, a frame for which `isHint(frame)` is true re-reads the
  record. Hints within `coalesceMs` collapse into one read; at most one read is
  in flight and one queued behind it. Without `isHint`, frames whose `channel`
  is the hook's channel count (acks and errors excepted).
- **Catch-up.** Becoming live reads at once. A reconnect is a new session: the
  channel goes back to `'pending'` and is re-sent, and its ack makes the hook
  live again, which re-reads — frames sent while the socket was down are only
  in the record.
- **Polling.** `pollMs` (default 5 000) while not live, `livePollMs` (default
  30 000) as a safety read while live; 0 turns either off. Failed reads double
  the wait per consecutive failure up to `maxBackoff` (≤ 5) times; a success
  resets it; with the cadence off a failure retries on `pollMs`. Polling pauses
  while the document is hidden (`useDocumentHidden`); becoming visible reads at
  once if a poll came due. Hints still read while hidden.
- **Lifetime.** A `channel` or `key` change starts over (data cleared, read at
  once). `enabled: false` reads and holds nothing. Unmount aborts the read in
  flight (`signal`) and clears every timer.

`createLiveRefresh({ read, isHint, coalesceMs, livePollMs, pollMs, maxBackoff,
now, timers })` is the framework-free core: drive it with `hint(frame?)`,
`setLive(bool)`, `setHidden(bool)`, `refresh()` and `dispose()`.

### Precedence vs `GatewaySocketProvider`

The two contexts are separate. `useLiveRefresh` uses its `socket` option when
given (`null` = no socket, poll only), else the nearest `SharedSocketProvider`,
else no socket (it polls). It never reads `GatewaySocketProvider` directly.
Inside a gateway provider, mount `<SharedSocketProvider fromGateway>` to put
that socket's shared transport in context. The feature hooks (`useChat`,
`usePipelineRunStatus` without a `transport`, …) keep reading
`GatewaySocketProvider` and ignore `SharedSocketProvider`. Channel holds are
refcounted among the shared transport's consumers only: do not hold one
channel both through the bridge and through a gateway feature hook that
sends its own subscribe.

