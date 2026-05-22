# @connorhoehn/realtime-modules

Client-side realtime collaboration toolkit. React hooks, an SSE
agent-streaming surface, a Tiptap editor adapter, and a typed REST
proxy client — everything an app needs to consume a
`websocket-gateway` deployment.

**Status.** Used by `websocket-gateway`'s built-in admin frontend and
by OrgIQ middleware/portal in production. Pre-1.0 (`0.x`) — subpath
shapes may shift; pin exact tags.

**v0.6.0 — server-side modules removed.** Earlier releases shipped
service classes (`ChatService`, `PresenceService`, `CRDTService`,
`ReactionService`, …) under `./server`, `./chat`, `./presence`,
`./cursor`, `./activity`, `./reactions`, `./ingest`, `./pipeline`,
`./social`, `./call`, `./typed-documents`. Those now live **in-tree
in the `websocket-gateway` repo** and are no longer reusable libraries.
This package is now client-only.

See **[Migration from v0.5.x](#migration-from-v05x)** below if you
were a server-side consumer.

## Live demo

A runnable showcase that exercises all six feature hooks is in the `demo/` directory.

```bash
cd demo && npm install && npm run dev   # → http://localhost:5173
```

Set `VITE_GATEWAY_URL=ws://localhost:4000` (and optionally `VITE_AUTH_TOKEN`) in
`demo/.env.local`. See [`demo/README.md`](./demo/README.md) for full instructions.

| Hook | What the demo shows |
|---|---|
| `useChat` | Message list, compose form, load-history |
| `usePresence` | Roster, status dropdown, metadata editor |
| `useReactions` | Emoji palette with aggregated counts, live stream |
| `useActivity` | Typed event feed, load-history |
| `useFileUpload` | Drag-and-drop, XHR progress bars, AV scan states |
| `useVideoHangout` | Start/join/leave, participant list, video/audio toggle, join-token display |

## Quick Start

```tsx
import {
  GatewaySocketProvider,
  useChat,
  usePresence,
  useCRDT,
} from '@connorhoehn/realtime-modules/client';

function App() {
  return (
    <GatewaySocketProvider
      url="wss://gateway.example.com/ws"
      authToken={() => getJwt()}
      features={['chat', 'presence', 'crdt']}
    >
      <Room channelId="room:42" documentId="doc:hello" />
    </GatewaySocketProvider>
  );
}

function Room({ channelId, documentId }: { channelId: string; documentId: string }) {
  const { messages, send } = useChat({ channel: channelId });
  const { peers } = usePresence({ channel: channelId });
  const { content, applyLocalEdit } = useCRDT({ documentId });

  return (
    <>
      <header>{peers.length} online</header>
      <main>{content}</main>
      <footer>
        {messages.map((m) => <div key={m.id}>{m.message}</div>)}
        <button onClick={() => send({ message: 'hi' })}>send</button>
      </footer>
    </>
  );
}
```

The provider owns the single `useWebSocket` connection. Child hooks
read context via `useGateway()` and never re-establish their own WS.

## Install

The package is **not on npm** and lives in its own standalone GitHub
repo at `github:connorhoehn/realtime-modules`. Install via a git tag
pin:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.6.0"
  }
}
```

The repo ships a pre-built `dist/` so consumers do not need to run
the TypeScript build themselves.

For local development against a sibling checkout:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

Run `npm run build` inside the clone once after pulling to refresh
`dist/`; `file:` consumers pick up changes on the next `npm install`.

Peer-deps (`react`, `express`, `ws`, `y-protocols`, `@tiptap/*`) are
all **optional** — install only what the subpaths you import require.

## TypeScript requirements

Add the following to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  }
}
```

- **`skipLibCheck: true`** — required to suppress transitive type
  conflicts from `yjs` and `lru-cache` that surface under TypeScript
  5.x/6.x.
- **`moduleResolution: "bundler"` (or `"node16"`/`"nodenext"`)** —
  required for subpath imports like
  `@connorhoehn/realtime-modules/client/ws` to resolve. Classic
  `"node"` mode does not support package `exports` subpath maps.

## Subpaths

The package ships six subpath entry points:

| Subpath | Purpose |
| --- | --- |
| `./client` | React surface: `GatewaySocketProvider`, `useGateway`, `useFeatures`, `useWebSocket`, `useCRDT`, `useYjsDoc`, `useAwarenessState`, `useIdleDetector`, `useAgentStream`, `SharedTextEditor`, `GatewayProvider`. Sibling hooks `useChat` / `usePresence` / `useReactions` / `useActivity` ship through the provider as they land. |
| `./client/ws` | Yjs-free `useWebSocket` only. Use this from apps that don't touch CRDT — keeps `yjs` and `y-protocols` out of the bundle entirely. |
| `./server-ws` | `createWsHandler` — thin `ws.Server` factory for hosts that want to mount a local WS surface (e.g. tests, fixtures). Lazy-requires `ws`. |
| `./agent-streaming` | Server-side AG-UI v0.1.x SSE emitter: `createAgentStream`, `agentStreamMiddleware`, full AG-UI event type tree. Pairs with `useAgentStream` on the client. |
| `./agent-streaming/client` | Browser-only `streamAgentRequest` helper — fetch + parse SSE; no Express dependency. |
| `./adapters/tiptap` | `TiptapEditor` + toolbar bound to a Yjs `XmlFragment`. Isolated so non-Tiptap consumers don't pull in ProseMirror. |
| `./proxy-client` | `GatewayProxyClient` — typed REST shim for Lambda / SSR callers that talk to the gateway over HTTP instead of WebSocket. |

The root entry (`@connorhoehn/realtime-modules`) re-exports `./client`,
`./agent-streaming`, and `./server-ws` for ergonomic single-import
access. Prefer subpath imports for tree-shaking.

## Transport tiers

Two runtime tiers based on the transport each subpath assumes:

**Lambda lane** (HTTP / SSE): `./agent-streaming`,
`./agent-streaming/client`, `./proxy-client`. Works in AWS Lambda via
[aws-lambda-web-adapter] with a Function URL and
`AWS_LWA_INVOKE_MODE=response_stream`. **Not compatible with API
Gateway** (REST or HTTP API) — those buffer responses and break SSE.
Function URL streaming is GA across all regions as of April 2026.

**Persistent-WS lane**: `./client`, `./client/ws`, `./server-ws`,
`./adapters/tiptap`. Assume a long-lived WebSocket connection to a
`websocket-gateway` deployment (or any host running `createWsHandler`).
**Don't try WS-on-Lambda via API Gateway WebSocket API** — the
per-message invocation model destroys client-side reconnect heuristics
and gateway-side in-process subscription tables.

**Lambda apps that need persistent-WS features** consume them via
gateway over HTTP through `./proxy-client`. The gateway exposes
publish/history/presence endpoints over plain REST so SSR + Lambda
callers can drive the same features without holding a socket.

### proxy-client — automatic HMAC signing (v0.7.1+)

The gateway's REST routes require a valid `X-Service-Auth` header.
Provide `serviceAuthSecret` + `serviceAuthClientId` and the client
signs every request automatically:

```ts
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

const client = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET,
  serviceAuthClientId: 'my-lambda-app',
});

// X-Service-Auth header computed automatically on every call.
await client.publishToChannel('chat:general', { type: 'message', text: 'hello' });
const { users } = await client.getPresence('chat:general');
const messages  = await client.getChatHistory('chat:general', { limit: 50 });
```

The wire format (`v1.<id>.<ts>.<mac>`) is identical to
`@connorhoehn/service-runtime`'s `signEnvelope`. The algorithm is
inlined (Node built-in `crypto`) so there is no extra runtime dep.
When both signing options are omitted the client operates in legacy
mode with no auth header.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

## FeatureManifest

`FeatureManifest` (declared in `src/feature-manifest/types.ts`) is the
shared contract between features and the host. Feature manifests now
live alongside the in-tree implementations in `websocket-gateway`;
this package re-exports the type so app code and host code share a
single declaration.

## Migration from v0.5.x

If you depended on a server-side subpath in v0.5.x or earlier, the
service class you imported now lives in `websocket-gateway/src/`. The
canonical fix is to **delete the import and consume the feature
through gateway** — either over WS (using the client hooks) or over
HTTP (using `./proxy-client`).

| Removed (v0.6.0) | Replacement |
| --- | --- |
| `import { ChatService } from '@connorhoehn/realtime-modules/chat'` | `useChat()` over WS, or `proxy.history.chat()` over HTTP |
| `import { PresenceService } from '@connorhoehn/realtime-modules/presence'` | `usePresence()` over WS, or `proxy.history.presence()` over HTTP |
| `import { ReactionService } from '@connorhoehn/realtime-modules/reactions'` | `useReactions()` over WS |
| `import { ActivityService } from '@connorhoehn/realtime-modules/activity'` | `useActivity()` over WS, or `proxy.history.activity()` over HTTP |
| `import { CRDTService } from '@connorhoehn/realtime-modules/server'` | `useCRDT()` / `useYjsDoc()` over WS |
| `import { CursorService } from '@connorhoehn/realtime-modules/cursor'` | gateway-internal; consume cursor updates through `useAwarenessState` |
| `import { ... } from '@connorhoehn/realtime-modules/{ingest,pipeline,social,call,typed-documents}'` | gateway-internal; no library entry point |

There is no separately-published "server-side toolkit" replacement. If
you have a non-gateway host that needs to run these services, fork
the implementations out of the gateway repo or talk to the operator.

## Versioning + stability

`0.x` is unstable. Pin to exact git tags (e.g. `#v0.6.0`). Subpath
shapes and hook signatures can change in any minor release. `1.0`
will mean stable client subpath exports and stable AG-UI mapping.

## Links

- [docs/ADOPTION-GUIDE.md](./docs/ADOPTION-GUIDE.md) — full adoption walkthrough.
- [docs/USAGE-PATTERNS.md](./docs/USAGE-PATTERNS.md) — common wiring patterns.
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./docs/USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps.
- [CHANGELOG.md](./CHANGELOG.md).
- [LICENSE](./LICENSE) — MIT.
