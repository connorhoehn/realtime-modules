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
