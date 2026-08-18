# Adoption Guide — `@connorhoehn/realtime-modules`

Operator-facing guide for installing the realtime-modules toolkit into
a new app and wiring its subpath exports.

**v0.17.0+:** this package is **full-stack** again. Server-side
service classes (`CRDTService`, `ChatService`, `PresenceService`, etc.)
are supported first-class surface — v0.6.0's "client-only" turn was
never completed (the gateway kept consuming these subpaths throughout)
and was reversed in v0.17.0. See the README's "What to use where"
table for the layer map.

---

## 1. What `realtime-modules` is

`@connorhoehn/realtime-modules` is a **client toolkit** for building
realtime experiences — chat, presence, reactions, activity, file
upload, video hangouts, notifications, collaborative documents, and
agent streaming — on top of a running `websocket-gateway` deployment.

It ships:

- **React hooks and providers** for WS connection management, CRDT
  documents, awareness, and feature-gated subscriptions.
- **AG-UI / SSE emitter** for server-side agent streaming, plus a
  matching client hook (`useAgentStream`).
- **Tiptap adapter** for rich-text collaborative editing.
- **HTTP proxy client** for Lambda / SSR callers that talk to the
  gateway over REST instead of WebSocket.

---

## 2. Installation

The package is **not on npm** — install via a git tag pin:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.7.4"
  }
}
```

The repo ships a pre-built `dist/` so consumers do not need to run the
TypeScript build.

For local development against a sibling checkout:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

Run `npm run build` once after pulling to refresh `dist/`.

### Pin recommendation

| Scenario | Recommended pin |
|---|---|
| Production consumer | Exact git tag: `#v0.7.4` |
| Local feature development | `file:../realtime-modules` |
| CI against main HEAD | `github:connorhoehn/realtime-modules#<sha>` |

Treat `main` HEAD the way the platform treats `distributed-core` —
freely usable when you control both ends of the upgrade, never trusted
as a long-term production pin.

### TypeScript requirements

```json
{
  "compilerOptions": {
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  }
}
```

- **`skipLibCheck: true`** — suppress transitive type conflicts from
  `yjs` / `lru-cache` under TypeScript 5.x/6.x.
- **`moduleResolution: "bundler"` (or `"node16"` / `"nodenext"`)** —
  required for subpath imports like `./client/ws` to resolve. Classic
  `"node"` mode does not support package `exports` maps.

### Peer dependencies

All peer deps are marked **optional** — install only what your chosen
subpaths need:

| Subpath | Required peer deps |
| --- | --- |
| `./client` | `react`, `yjs`, `y-protocols` |
| `./client/ws` | `react` only — no Yjs |
| `./adapters/tiptap` | `react`, `yjs`, `y-protocols`, full `@tiptap/*` set |
| `./agent-streaming` | `express` (server side only) |
| `./agent-streaming/client` | `react` |
| `./server-ws` | `ws` |
| `./proxy-client` | none |

---

## 3. Subpaths overview

| Subpath | Provides | Use when |
| --- | --- | --- |
| `./client` | `GatewaySocketProvider`, all hooks (`useGateway`, `useWebSocket`, `useChat`, `usePresence`, `useReactions`, `useActivity`, `useFileUpload`, `useVideoHangout`, `useNotifications`, `useCRDT`, `useYjsDoc`, `useAwarenessState`, `useIdleDetector`, `useAgentStream`, `SharedTextEditor`, `GatewayProvider`) | Browser apps with full feature set |
| `./client/ws` | `useWebSocket` only — no Yjs in bundle | Browser apps that don't use CRDT |
| `./server-ws` | `createWsHandler` — thin `ws.Server` factory | Tests, fixtures, standalone WS servers |
| `./agent-streaming` | AG-UI v0.1.x SSE emitter: `createAgentStream`, `agentStreamMiddleware`, full AG-UI event type tree | Express / Lambda backends streaming AI responses |
| `./agent-streaming/client` | `useAgentStream` React hook — no Express / Yjs dependency | Browser apps consuming agent streams |
| `./adapters/tiptap` | `TiptapEditor` + `EditorToolbar` bound to Yjs `XmlFragment` | Collaborative rich-text editing |
| `./proxy-client` | `GatewayProxyClient` — typed REST shim with optional HMAC signing | Lambda / SSR / service-to-service callers |

The root entry (`@connorhoehn/realtime-modules`) re-exports `./client`,
`./agent-streaming`, and `./server-ws` for ergonomic single-import
access. Prefer explicit subpath imports for tree-shaking.

---

## 4. Browser app — full feature set

### 4.1 Provider setup

Mount `GatewaySocketProvider` once near the tree root:

```tsx
// app/App.tsx
import {
  GatewaySocketProvider,
  useChat,
  usePresence,
  useNotifications,
} from '@connorhoehn/realtime-modules/client';

export function App() {
  return (
    <GatewaySocketProvider
      url="wss://gateway.example.com/ws"
      token={getAuthToken()}
      features={['presence', 'chat', 'reactions', 'activity']}
    >
      <NotificationBell />
      <Room channelId="room:42" />
    </GatewaySocketProvider>
  );
}
```

### 4.2 Channel hooks

All channel-scoped hooks subscribe / unsubscribe automatically when
their `channel` argument changes:

```tsx
function Room({ channelId }: { channelId: string }) {
  const { messages, sendMessage, loadHistory } = useChat(channelId);
  const { roster, setStatus }                  = usePresence(channelId);
  const { reactions, react }                   = useReactions(channelId);
  const { events }                             = useActivity(channelId);

  return (/* ... */);
}
```

### 4.3 Notifications (user-scoped)

`useNotifications()` is not channel-scoped — it listens for
`notification:*` frames from the gateway regardless of the current
channel:

```tsx
function NotificationBell() {
  const { notifications, unreadCount, markAsRead, markAllRead, clearAll } =
    useNotifications();

  return (
    <button onClick={markAllRead}>
      Bell ({unreadCount} unread)
    </button>
  );
}
```

Read state is persisted in `localStorage` under
`'rmn:notifications:read'` so a page refresh does not lose marks.

### 4.4 File upload

```tsx
import { useFileUpload } from '@connorhoehn/realtime-modules/client';

function UploadPanel({ channelId }: { channelId: string }) {
  const { uploads, upload, cancel, removeCompleted } = useFileUpload(channelId);

  return (
    <div>
      <input
        type="file"
        onChange={(e) => e.target.files && upload(e.target.files[0])}
      />
      {uploads.map((u) => (
        <div key={u.id}>
          {u.filename} — {u.status} {u.progress != null && `${u.progress}%`}
          {u.status === 'uploading' && (
            <button onClick={() => cancel(u.id)}>cancel</button>
          )}
        </div>
      ))}
    </div>
  );
}
```

### 4.5 Video hangout

```tsx
import { useVideoHangout } from '@connorhoehn/realtime-modules/client';

function HangoutPanel({ channelId }: { channelId: string }) {
  const {
    session, participants, joinToken,
    start, join, leave, end,
    toggleVideo, toggleAudio,
  } = useVideoHangout(channelId);

  if (!session) {
    return <button onClick={() => start()}>Start video call</button>;
  }

  return (
    <div>
      <p>{participants.length} participants — token: {joinToken}</p>
      <button onClick={leave}>Leave</button>
      <button onClick={end}>End call</button>
      <button onClick={() => toggleVideo(!session.videoOn)}>Toggle video</button>
    </div>
  );
}
```

### 4.6 CRDT + Tiptap collaborative document

```tsx
import { useGateway, useYjsDoc, useAwarenessState }
  from '@connorhoehn/realtime-modules/client';
import { TiptapEditor, type CollaborationProvider }
  from '@connorhoehn/realtime-modules/adapters/tiptap';

// Must be inside a GatewaySocketProvider.
function CollabDoc({ documentId }: { documentId: string }) {
  const ws = useGateway();
  const { ydoc, provider, synced } = useYjsDoc({ documentId, ws });
  useAwarenessState(provider, {
    userId: 'me',
    displayName: 'Connor',
    color: '#06b6d4',
    mode: 'edit',
    currentSectionId: null,
  });

  if (!synced || !ydoc || !provider) return <div>Loading...</div>;

  return (
    <TiptapEditor
      fragment={ydoc.getXmlFragment('prosemirror')}
      ydoc={ydoc}
      provider={provider as CollaborationProvider}
      user={{ name: 'Connor', color: '#06b6d4' }}
    />
  );
}
```

### 4.7 Agent streaming

```tsx
import { useAgentStream } from '@connorhoehn/realtime-modules/client';

function AgentChat() {
  const { messages, streamingText, isStreaming, sendMessage } = useAgentStream({
    endpoint: '/api/agents/default/stream',
  });

  return (
    <>
      {messages.map((m) => <p key={m.id}>{m.content}</p>)}
      {isStreaming && <p>{streamingText}</p>}
      <button onClick={() => sendMessage({ content: 'hello' })}>Ask</button>
    </>
  );
}
```

---

## 5. Lambda / Server-to-server — proxy-client

Apps running in AWS Lambda or behind a CDN edge can call gateway REST
endpoints via `GatewayProxyClient` instead of holding a WebSocket.

### 5.1 Automatic HMAC signing (recommended)

```ts
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

const proxy = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET,   // shared HMAC secret
  serviceAuthClientId: 'my-lambda-app',                 // must be in gateway's ALLOWED_SERVICES
  timeout: 5_000,
});

// X-Service-Auth header computed automatically on every call.
await proxy.publishToChannel('room:42', { type: 'notice', text: 'hello' });

const { messages } = await proxy.getChatHistory('room:42', { limit: 50 });
const { users }    = await proxy.getPresence('room:42');
const { events }   = await proxy.getActivityHistory('room:42', { limit: 20 });
```

The envelope wire format is `v1.<serviceId>.<unixTsSec>.<base64url-hmac>`,
compatible with `@connorhoehn/service-runtime`'s `signEnvelope` /
`verifyEnvelope`. The algorithm is inlined in the proxy-client using
Node's built-in `crypto` — no extra runtime dep.

**Gateway-side setup:** ensure `SERVICE_AUTH_SECRET` is set and your
service id appears in `SERVICE_AUTH_ALLOWED_SERVICES`.

### 5.2 Manual / legacy mode

Omit both signing options to send requests without auth headers:

```ts
const proxy = new GatewayProxyClient({
  gatewayUrl: 'http://localhost:4000',
});
await proxy.publishToChannel('room:42', { type: 'test', text: 'hello' });
```

Errors throw `ProxyClientHttpError` / `ProxyClientNetworkError` /
`ProxyClientTimeoutError` — all extend `ProxyClientError`.

**Lambda + SSE note:** `./agent-streaming` works in Lambda via
[aws-lambda-web-adapter] with `AWS_LWA_INVOKE_MODE=response_stream`
and a **Function URL**. Do not use API Gateway (REST or HTTP) — it
buffers responses and breaks SSE.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

---

## 6. Backend — AG-UI agent streaming

Mount `agentStreamMiddleware` on any Express server (or Lambda via
aws-lambda-web-adapter + Function URL):

```ts
import express from 'express';
import { agentStreamMiddleware } from '@connorhoehn/realtime-modules/agent-streaming';

const app = express();
app.use(express.json());

app.post('/api/agents/:agentId/stream', agentStreamMiddleware(
  async (req, stream, signal) => {
    const runner = await getAgentRunner(req.params.agentId);
    for await (const evt of runner.stream(req.body, { signal })) {
      if (signal.aborted) break;
      if (evt.type === 'text') {
        stream.textMessageChunk({
          messageId: evt.messageId,
          role: 'assistant',
          delta: evt.text,
        });
      }
    }
  },
  { heartbeatMs: 25_000 },
));

app.listen(3000);
```

---

## 7. ui-components composition

When `@connorhoehn/ui-components/integrations/realtime-modules` ships,
it will re-export pre-composed components (e.g. `<ChatPanel>`,
`<PresenceAvatarStack>`) that wire the hooks automatically. Until then,
compose directly against the hooks:

```tsx
// Manual adapter pattern — build your own composed component.
import { useChat, usePresence } from '@connorhoehn/realtime-modules/client';

export function ChatPanel({ channelId }: { channelId: string }) {
  const { messages, sendMessage } = useChat(channelId);
  const { roster }                = usePresence(channelId);

  return (
    <div className="chat-panel">
      <header>{roster.length} online</header>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => sendMessage({ message: 'hi' })}>send</button>
    </div>
  );
}
```

---

## 8. The `FeatureManifest` pattern

`FeatureManifest` (in `src/feature-manifest/types.ts`) is the shared
contract between features and the host. The `agentStreamingManifest`
is exported from `./agent-streaming`. Read it at boot to assert
required env vars:

```ts
import { agentStreamingManifest }
  from '@connorhoehn/realtime-modules/agent-streaming';

for (const [key, meta] of Object.entries(agentStreamingManifest.envVars ?? {})) {
  if (meta.required && !process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}
```

---

## 9. What's NOT included

- **Server-side service classes.** `CRDTService`, `ChatService`,
  `PresenceService`, `ReactionService`, `ActivityService`, etc. all
  live in `websocket-gateway/src/`. Consume them through the gateway
  WS protocol (client hooks) or HTTP (`./proxy-client`).
- **Express routes** (beyond `agentStreamMiddleware`). All other
  features are plain service classes in the gateway.
- **Auth / authz.** `createWsHandler` accepts an `auth` callback;
  `GatewaySocketProvider` forwards a `token`; the rest is your
  application's concern.
- **A CLI installer.** `npx realtime-modules add <feature>` is a
  future aspiration.

---

## 10. Operational notes

### Peer dependency handling

npm will not warn about missing optional peers — a missing peer shows
up as `ERR_MODULE_NOT_FOUND` at import time. If you see
`Cannot find module 'y-protocols'`, install the peer.

### Version pinning

Pin consumers to **tags**, e.g. `#v0.7.4`. Treat `main` HEAD the way
the platform treats `distributed-core` — freely usable when you
control both ends of the upgrade, never trusted as a long-term pin.

Run `npm run typecheck` across each consumer before publishing a new
tag — the package's subpath exports are not API-stable yet and
breakages surface as TS errors, not runtime crashes.

---

## Migration from v0.5.x

If you depended on a server-side subpath in v0.5.x or earlier, the
service class now lives in `websocket-gateway/src/`. The canonical fix
is to **delete the import** and consume the feature through gateway —
either via WS (client hooks) or HTTP (`./proxy-client`).

| Removed in v0.6.0 | Replacement |
| --- | --- |
| `import { ChatService } from '…/chat'` | `useChat(channel)` over WS, or `proxy.getChatHistory()` over HTTP |
| `import { PresenceService } from '…/presence'` | `usePresence(channel)` over WS, or `proxy.getPresence()` over HTTP |
| `import { ReactionService } from '…/reactions'` | `useReactions(channel)` over WS |
| `import { ActivityService } from '…/activity'` | `useActivity(channel)` over WS, or `proxy.getActivityHistory()` over HTTP |
| `import { CRDTService } from '…/server'` | `useCRDT(channel)` / `useYjsDoc()` over WS |
| `import { CursorService } from '…/cursor'` | gateway-internal; consume cursor updates via `useAwarenessState` |
| `import { … } from '…/{ingest,pipeline,social,call,typed-documents}'` | gateway-internal; no library replacement |

There is no separately-published "server-side toolkit" replacement. If
you have a non-gateway host that needs these services, fork the
implementations out of the gateway repo.
