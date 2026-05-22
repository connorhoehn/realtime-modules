# @connorhoehn/realtime-modules

Client-only realtime collaboration library for apps consuming a
`websocket-gateway` deployment. Ships React hooks for chat, presence,
reactions, activity, file upload, video hangouts, and notifications;
an AG-UI / SSE agent-streaming surface; a Tiptap collaborative editor
adapter; and a typed REST proxy client for Lambda / server-to-server
callers.

**Status.** Used by OrgIQ middleware/portal and by the gateway's admin
frontend. Pre-1.0 (`0.x`) — subpath shapes may shift between minors;
pin to exact git tags.

**v0.6.0 — server-side modules removed.** Earlier releases shipped
service classes (`ChatService`, `PresenceService`, `CRDTService`,
`ReactionService`, …) under `./server`, `./chat`, `./presence`,
`./cursor`, `./activity`, `./reactions`, `./ingest`, `./pipeline`,
`./social`, `./call`, `./typed-documents`. Those now live **in-tree in
the `websocket-gateway` repo** and are no longer reusable libraries.
This package is now client-only.

See **[Migration from v0.5.x](#migration-from-v05x)** below if you
were a server-side consumer.

---

## Quick Start

```tsx
import {
  GatewaySocketProvider,
  useChat,
  usePresence,
  useCRDT,
} from '@connorhoehn/realtime-modules/client';

function MyApp() {
  return (
    <GatewaySocketProvider
      url="wss://gateway.example.com/ws"
      token={getAuthToken()}
      features={['chat', 'presence', 'crdt']}
    >
      <ChatRoom channel="chat:general" />
    </GatewaySocketProvider>
  );
}

function ChatRoom({ channel }: { channel: string }) {
  const { messages, sendMessage } = useChat(channel);
  const { roster } = usePresence(channel);

  return (
    <>
      <header>{roster.length} online</header>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => sendMessage({ message: 'hi' })}>send</button>
    </>
  );
}
```

The provider owns the single WebSocket connection. Child hooks read
context via `useGateway()` and never re-establish their own socket.

**Composite pattern — `useChannel` (v0.7.8):**

```tsx
import { useChannel } from '@connorhoehn/realtime-modules/client';

function Room({ channel }: { channel: string }) {
  // All four features enabled by default; each value is T | null.
  const { chat, presence, reactions, activity } = useChannel(channel);

  return (
    <>
      <header>{presence?.roster.length ?? 0} online</header>
      <ul>{chat?.messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => chat?.sendMessage('hi')}>send</button>
      <button onClick={() => reactions?.react('\u{1F525}')}>fire</button>
    </>
  );
}

// Opt-out individual features:
const { chat } = useChannel(channel, {
  features: { presence: false, reactions: false, activity: false },
});
```

Granular hooks (`useChat`, `usePresence`, etc.) are still valid for
deeply-nested components that only need one feature.

---

## Install

The package is **not on npm** — install via a git tag pin:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.7.7"
  }
}
```

The repo ships a pre-built `dist/` so consumers do not need to run the
TypeScript build themselves.

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

Peer-deps (`react`, `express`, `ws`, `yjs`, `y-protocols`, `@tiptap/*`)
are all **optional** — install only what the subpaths you import
require.

### TypeScript requirements

```json
{
  "compilerOptions": {
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  }
}
```

- **`skipLibCheck: true`** — required to suppress transitive type
  conflicts from `yjs` and `lru-cache` under TypeScript 5.x/6.x.
- **`moduleResolution: "bundler"` (or `"node16"`/`"nodenext"`)** —
  required for subpath imports like `./client/ws` to resolve. Classic
  `"node"` mode does not support package `exports` subpath maps.

---

## Subpaths

| Subpath | Purpose | Use when |
|---|---|---|
| `./client` | React hooks + `GatewaySocketProvider` | Browser apps with full feature set |
| `./client/ws` | Yjs-free `useWebSocket`-only surface | Browser apps without CRDT |
| `./server-ws` | Generic WS handler factory (`createWsHandler`) | Service-side WS routing / test fixtures |
| `./adapters/tiptap` | `TiptapEditor` + `EditorToolbar` bound to Yjs | Collaborative rich-text editors |
| `./proxy-client` | `GatewayProxyClient` — typed REST shim with optional HMAC signing | Server-to-server / Lambda |
| `./agent-streaming` | AG-UI v0.1.x SSE emitter (`agentStreamMiddleware`) | Backends streaming AI responses |
| `./agent-streaming/client` | `useAgentStream` React hook — no Yjs dependency | Browser apps consuming agent streams |

The root entry (`@connorhoehn/realtime-modules`) re-exports `./client`,
`./agent-streaming`, and `./server-ws` for ergonomic single-import
access. Prefer explicit subpath imports for tree-shaking.

---

## Hook reference

All hooks except `useGateway`, `useWebSocket`, and `useNotifications`
are channel-scoped: they subscribe/unsubscribe automatically when the
`channel` argument changes.

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useGateway()` | `{ send, onMessage, onConnect, onDisconnect, state, … }` | No (provider context) |
| `useWebSocket(opts)` | Low-level WS state — `connectionState`, `clientId`, `sendMessage`, … | No |
| `useChannel(channel, opts?)` | `{ chat, presence, reactions, activity, channel }` — composite (v0.7.8) | Yes |
| `useChat(channel)` | `{ messages, sendMessage, loadHistory }` | Yes |
| `usePresence(channel)` | `{ roster, setStatus, updateMetadata }` | Yes |
| `useReactions(channel, opts?)` | `{ reactions, react, reactionsFor }` | Yes |
| `useActivity(channel)` | `{ events, loadHistory }` | Yes |
| `useFileUpload(channel)` | `{ uploads, upload, cancel, removeCompleted }` | Yes |
| `useVideoHangout(channel)` | `{ session, participants, joinToken, start, join, leave, end, toggleVideo, toggleAudio }` | Yes |
| `useNotifications()` | `{ notifications, unreadCount, markAsRead, markAllRead, remove, clearAll }` | No (user-scoped) |
| `useCapability(name, channel?)` | `{ capability, enabled, isLoading, error }` | No (CRD-scoped) |
| `useFeatureFlag(name, defaultValue?)` | `{ enabled, isLoading, variant?, metadata? }` | No (flag-scoped) |
| `useCRDT(channel)` | `{ doc, awareness }` | Yes |
| `useAgentStream(opts)` | `{ messages, streamingText, activeToolCalls, isStreaming, sendMessage, … }` | Per-stream |

---

## Transport tiers

**Persistent-WS lane** (`./client`, `./client/ws`, `./server-ws`,
`./adapters/tiptap`): assumes a long-lived WebSocket to a
`websocket-gateway` deployment.

**Lambda lane** (`./agent-streaming`, `./agent-streaming/client`,
`./proxy-client`): HTTP / SSE only. `./agent-streaming` works in AWS
Lambda via [aws-lambda-web-adapter] with a Function URL and
`AWS_LWA_INVOKE_MODE=response_stream`. **Do not use API Gateway** —
it buffers responses and breaks SSE streaming.

Lambda apps that need persistent-WS features (chat history, presence,
channel publish) consume them via `GatewayProxyClient` over plain REST.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

---

## proxy-client — automatic HMAC signing (v0.7.1+)

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
const { users }    = await client.getPresence('chat:general');
const { messages } = await client.getChatHistory('chat:general', { limit: 50 });
```

The wire format (`v1.<id>.<ts>.<mac>`) is identical to
`@connorhoehn/service-runtime`'s `signEnvelope`. The algorithm is
inlined using Node's built-in `crypto` — no extra runtime dep.

---

## Live demo

A runnable showcase covering all six feature hooks is in `demo/`:

```bash
cd demo && npm install && npm run dev   # → http://localhost:5173
```

Set `VITE_GATEWAY_URL=ws://localhost:4000` (and optionally
`VITE_AUTH_TOKEN`) in `demo/.env.local`. See
[`demo/README.md`](./demo/README.md) for full instructions.

| Hook | What the demo shows |
|---|---|
| `useChat` | Message list, compose form, load-history |
| `usePresence` | Roster, status dropdown, metadata editor |
| `useReactions` | Emoji palette with aggregated counts, live stream |
| `useActivity` | Typed event feed, load-history |
| `useFileUpload` | Drag-and-drop, XHR progress bars, AV scan states |
| `useVideoHangout` | Start/join/leave, participant list, video/audio toggle, join-token display |

---

## Maturity

| Subpath / hook | Status |
|---|---|
| `./client` — `GatewaySocketProvider`, `useGateway`, `useWebSocket` | Stable (in use by gateway + OrgIQ) |
| `useChat`, `usePresence`, `useReactions`, `useActivity` | Stable (v0.7.0) |
| `useFileUpload` | Beta (v0.7.2 — gateway-side upload service not yet wired) |
| `useVideoHangout` | Beta (v0.7.2 — LVS signaling integration deferred) |
| `useNotifications` | Beta (v0.7.4 — gateway notification service not yet wired) |
| `useCapability` | Beta (v0.7.5 — /api/capabilities not yet on gateway; optimistic fallback active) |
| `useFeatureFlag` | Beta (v0.7.7 — /api/feature-flags not yet on gateway; falls back to defaultValue) |
| `useCRDT`, `useYjsDoc`, `useAwarenessState`, `useIdleDetector` | Stable |
| `useAgentStream` | Stable (v0.2.0) |
| `./proxy-client` | Stable (v0.2.0, HMAC signing v0.7.1) |
| `./agent-streaming` | Stable (v0.1.0) |
| `./agent-streaming/client` | Stable (v0.2.1) |
| `./adapters/tiptap` | Stable |
| `./client/ws` | Stable (v0.4.3) |
| `./server-ws` | Stable |

---

## FeatureManifest

`FeatureManifest` (declared in `src/feature-manifest/types.ts`) is the
shared contract between features and the host. Feature manifests now
live alongside the in-tree implementations in `websocket-gateway`;
this package re-exports the type so app code and host code share a
single declaration.

---

## Versioning + stability

`0.x` is unstable. Pin to exact git tags (e.g. `#v0.7.4`). Subpath
shapes and hook signatures can change in any minor release. `1.0`
will mean stable client subpath exports and stable AG-UI mapping.

---

## Migration from v0.5.x

If you depended on a server-side subpath in v0.5.x or earlier, the
service class you imported now lives in `websocket-gateway/src/`. The
canonical fix is to **delete the import and consume the feature
through gateway** — either over WS (using the client hooks) or over
HTTP (using `./proxy-client`).

| Removed (v0.6.0) | Replacement |
| --- | --- |
| `import { ChatService } from '@connorhoehn/realtime-modules/chat'` | `useChat(channel)` over WS, or `proxy.getChatHistory()` over HTTP |
| `import { PresenceService } from '@connorhoehn/realtime-modules/presence'` | `usePresence(channel)` over WS, or `proxy.getPresence()` over HTTP |
| `import { ReactionService } from '@connorhoehn/realtime-modules/reactions'` | `useReactions(channel)` over WS |
| `import { ActivityService } from '@connorhoehn/realtime-modules/activity'` | `useActivity(channel)` over WS, or `proxy.getActivityHistory()` over HTTP |
| `import { CRDTService } from '@connorhoehn/realtime-modules/server'` | `useCRDT(channel)` / `useYjsDoc()` over WS |
| `import { CursorService } from '@connorhoehn/realtime-modules/cursor'` | gateway-internal; consume cursor updates through `useAwarenessState` |
| `import { ... } from '@connorhoehn/realtime-modules/{ingest,pipeline,social,call,typed-documents}'` | gateway-internal; no library entry point |

---

## Links

- [docs/ADOPTION-GUIDE.md](./docs/ADOPTION-GUIDE.md) — full adoption walkthrough.
- [docs/USAGE-PATTERNS.md](./docs/USAGE-PATTERNS.md) — common wiring patterns.
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./docs/USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps.
- [CHANGELOG.md](./CHANGELOG.md).
- [LICENSE](./LICENSE) — MIT.
