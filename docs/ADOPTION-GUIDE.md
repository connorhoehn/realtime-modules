# Adoption Guide — `@connorhoehn/realtime-modules`

Operator-facing guide for installing the realtime-modules toolkit into
a new app and wiring its subpath exports.

**v0.6.0 note:** this package is now **client-only**. Server-side
service classes (`CRDTService`, `ChatService`, `PresenceService`, etc.)
were removed and live in-tree in the `websocket-gateway` repo. If you
were a server-side consumer, see
[Migration from v0.5.x](#migration-from-v05x) at the bottom.

---

## 1. What `realtime-modules` is

`@connorhoehn/realtime-modules` is a **client toolkit** for building
realtime experiences — collaborative documents, presence, chat,
reactions, agent streaming — on top of a running `websocket-gateway`
deployment. It ships:

- **React hooks and providers** for WS connection management, CRDT
  documents, awareness, and feature-gated subscriptions.
- **AG-UI / SSE emitter** for server-side agent streaming, plus a
  matching client hook (`useAgentStream`).
- **Tiptap adapter** for rich-text collaborative editing.
- **HTTP proxy client** for Lambda/SSR callers that talk to the gateway
  over REST instead of WebSocket.

---

## 2. Installation

The package is **not on npm** — install via a git tag pin:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.6.0"
  }
}
```

The repo ships a pre-built `dist/` so consumers do not need to run
the TypeScript build.

For local development against a sibling checkout:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

Run `npm run build` once after pulling to refresh `dist/`.

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
| `./agent-streaming/client` | none |
| `./server-ws` | `ws` |
| `./proxy-client` | none |

---

## 3. Subpaths overview

The package ships seven subpath entry points:

| Subpath | Provides |
| --- | --- |
| `./client` | React surface: `GatewaySocketProvider`, `useGateway`, `useFeatures`, `useWebSocket`, `GatewayProvider`, `useCRDT`, `useYjsDoc`, `useAwarenessState`, `useIdleDetector`, `useAgentStream`, `SharedTextEditor`. Sibling hooks `useChat` / `usePresence` / `useReactions` / `useActivity` compose on top of the provider as they land. |
| `./client/ws` | Yjs-free `useWebSocket` only — keeps `yjs` and `y-protocols` out of the bundle. Use from apps that don't touch CRDT. |
| `./server-ws` | `createWsHandler` — thin `ws.Server` factory for hosts that want a local WS surface (tests, fixtures, non-gateway servers). |
| `./agent-streaming` | Server-side AG-UI v0.1.x SSE emitter: `createAgentStream`, `agentStreamMiddleware`, full AG-UI event type tree. |
| `./agent-streaming/client` | Browser-only `streamAgentRequest` fetch + SSE parser. No Express dependency. |
| `./adapters/tiptap` | `TiptapEditor` + `EditorToolbar` bound to a Yjs `XmlFragment`. Isolated so non-Tiptap consumers don't pull in ProseMirror. |
| `./proxy-client` | `GatewayProxyClient` — typed REST shim for Lambda / SSR callers that talk to the gateway over HTTP. |

The root entry (`@connorhoehn/realtime-modules`) re-exports `./client`,
`./agent-streaming`, and `./server-ws` for ergonomic single-import
access. Prefer subpath imports for tree-shaking.

---

## 4. Concrete example — agent dashboard app

An Express + React app that wants:

1. **WS realtime features** (presence, chat) via `GatewaySocketProvider`.
2. **Collaborative document** via `useYjsDoc` + Tiptap.
3. **AG-UI streaming chat** via `agentStreamMiddleware` + `useAgentStream`.

### 4.1 `package.json`

```json
{
  "name": "agent-dashboard",
  "private": true,
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.6.0",
    "express": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "yjs": "^13.6.0",
    "y-protocols": "^1.0.7"
  }
}
```

### 4.2 Backend — AG-UI streaming endpoint

```ts
// server/index.ts
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
        stream.textMessageChunk({ messageId: evt.messageId, role: 'assistant', delta: evt.text });
      }
    }
  },
  { heartbeatMs: 25_000 },
));

app.listen(3000);
```

Server-side service classes (CRDT, Chat, Presence) are **not** in this
package — they run inside `websocket-gateway`. Your backend talks to the
gateway over REST via `GatewayProxyClient` or connects clients directly
to the gateway WS endpoint.

### 4.3 Frontend — React component tree

```tsx
// app/App.tsx
import {
  GatewaySocketProvider,
  useChat,       // lands when feature hook ships
  usePresence,   // lands when feature hook ships
  useAgentStream,
} from '@connorhoehn/realtime-modules/client';

export function App() {
  return (
    <GatewaySocketProvider
      url="wss://gateway.example.com/ws"
      token={getAuthToken()}
      features={['presence', 'chat']}
      channel="room:42"
    >
      <Room />
    </GatewaySocketProvider>
  );
}

function Room() {
  // These hooks read the WS context from GatewaySocketProvider —
  // no prop-drilling needed.
  const { messages, send } = useChat({ channel: 'room:42' });
  const { peers } = usePresence({ channel: 'room:42' });

  const { streamingText, sendMessage } = useAgentStream({
    endpoint: '/api/agents/default/stream',
  });

  return (
    <>
      <header>{peers.length} online</header>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => send({ message: 'hi' })}>send</button>
      <pre>{streamingText}</pre>
      <button onClick={() => sendMessage({ content: 'summarize' })}>ask agent</button>
    </>
  );
}
```

### 4.4 Collaborative document (CRDT + Tiptap)

```tsx
// app/components/CollabDoc.tsx
import { useGateway, useYjsDoc, useAwarenessState }
  from '@connorhoehn/realtime-modules/client';
import { TiptapEditor, type CollaborationProvider }
  from '@connorhoehn/realtime-modules/adapters/tiptap';

export function CollabDoc({ documentId }: { documentId: string }) {
  const ws = useGateway();   // from parent GatewaySocketProvider

  const { ydoc, provider, synced } = useYjsDoc({ documentId, ws });
  const { updateCursorInfo } = useAwarenessState(provider, {
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
      onUpdateCursorInfo={updateCursorInfo}
    />
  );
}
```

---

## 5. Lambda / SSR — proxy-client

Apps running in AWS Lambda or behind a CDN edge can call gateway REST
endpoints via `GatewayProxyClient` instead of holding a WebSocket:

```ts
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

const proxy = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  serviceToken: process.env.SERVICE_TOKEN,
  timeoutMs: 5_000,
});

// Publish an event to a channel.
await proxy.publishToChannel('room:42', { type: 'notice', text: 'hello' });

// Read history.
const { messages } = await proxy.getChatHistory('room:42', { limit: 50 });
const { users }    = await proxy.getPresence('room:42');
const { events }   = await proxy.getActivityHistory('room:42', { limit: 20 });
```

Errors throw `ProxyClientHttpError` / `ProxyClientNetworkError` /
`ProxyClientTimeoutError` from `./proxy-client` — all extend
`ProxyClientError`.

**Lambda + SSE note:** `./agent-streaming` works in Lambda via
[aws-lambda-web-adapter] with `AWS_LWA_INVOKE_MODE=response_stream`
and a **Function URL**. Do not use API Gateway (REST or HTTP) — it
buffers responses and breaks SSE.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

---

## 6. The `FeatureManifest` pattern

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

## 7. What's NOT included

- **Server-side service classes.** `CRDTService`, `ChatService`,
  `PresenceService`, `ReactionService`, `ActivityService`, etc. all
  live in `websocket-gateway/src/`. Consume them through the gateway
  WS protocol (client hooks) or HTTP (proxy-client).
- **Express routes.** Only `agentStreamMiddleware` mounts an Express
  handler. All other features are plain service classes in the gateway.
- **Auth / authz.** `createWsHandler` accepts an `auth` callback;
  `GatewaySocketProvider` forwards a `token`; the rest is your
  application's concern.
- **A CLI installer.** `npx realtime-modules add <feature>` is a
  future aspiration.

---

## 8. Operational notes

### Peer dependency handling

npm will not warn about missing optional peers — a missing peer shows
up as `ERR_MODULE_NOT_FOUND` at import time. If you see
`Cannot find module 'y-protocols'`, install the peer.

### Version pinning

Pin consumers to **tags**, e.g.
`github:connorhoehn/realtime-modules#v0.6.0`. Treat `main` HEAD the
way the platform treats `distributed-core` — freely usable when you
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
| `import { ChatService } from '…/chat'` | `useChat()` over WS, or `proxy.getChatHistory()` over HTTP |
| `import { PresenceService } from '…/presence'` | `usePresence()` over WS, or `proxy.getPresence()` over HTTP |
| `import { ReactionService } from '…/reactions'` | `useReactions()` over WS |
| `import { ActivityService } from '…/activity'` | `useActivity()` over WS, or `proxy.getActivityHistory()` over HTTP |
| `import { CRDTService } from '…/server'` | `useCRDT()` / `useYjsDoc()` over WS |
| `import { CursorService } from '…/cursor'` | gateway-internal; consume cursor updates via `useAwarenessState` |
| `import { … } from '…/{ingest,pipeline,social,call,typed-documents}'` | gateway-internal; no library replacement |

There is no separately-published "server-side toolkit" replacement. If
you have a non-gateway host that needs these services, fork the
implementations out of the gateway repo.
