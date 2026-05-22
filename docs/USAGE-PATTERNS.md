# Usage Patterns — `@connorhoehn/realtime-modules`

Concrete per-subpath examples. For installation, peer deps, version
pinning, and migration, see `./ADOPTION-GUIDE.md`.

Each section: **What you get** → **Usage** → **Notes** (where
applicable). All code uses real type signatures from the source.

---

## `./client` — React realtime surface

The main client subpath. Editor-agnostic — no Tiptap or ProseMirror
imports.

### What you get

From `src/client/index.ts`:

- `GatewaySocketProvider` — React context provider that owns a single
  `useWebSocket` connection. Mount once near the tree root; child
  components read context via `useGateway()`. Accepts `url`, `token`,
  `features`, `channel` props.
- `useGateway()` — access the WS connection and `onMessage` bus from
  any descendant.
- `useFeatures()` — read the active `FeatureName[]` from context.
- `useWebSocket(opts)` — low-level transport hook. Handles reconnect,
  session handshake, auto-resubscribe. Use directly when you can't
  mount a provider (e.g. testing).
- `GatewayProvider` — Y.js `Observable` bridging the gateway's
  `crdt:update` / `crdt:snapshot` / `crdt:awareness` protocol.
- `useYjsDoc(opts)` — lifecycle hook: `Y.Doc` + `GatewayProvider` +
  subscribe / unsubscribe / `crdt:doc-replaced` rebuild.
- `useCRDT(opts)` — single-Y.Text content hook for `SharedTextEditor`.
- `useAwarenessState(provider, initial)` — merge-not-overwrite
  awareness writes.
- `useIdleDetector({ timeoutMs })`.
- `useAgentStream(opts)` — fetch + parse an AG-UI SSE stream.
- `SharedTextEditor` — `contentEditable` rich-text surface, no editor
  dependency.
- Channel feature hooks: `useChat`, `usePresence`, `useReactions`,
  `useActivity`, `useFileUpload`, `useVideoHangout`.
- `useNotifications()` — user-scoped notification inbox.
- Contract types: `ConnectionState`, `GatewayError`, `GatewayMessage`,
  `UseWebSocketReturn`, `GatewayContextValue`.

### Provider + channel hooks

```tsx
import {
  GatewaySocketProvider,
  useChat,
  usePresence,
  useReactions,
  useActivity,
  useFileUpload,
  useVideoHangout,
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

function NotificationBell() {
  const { unreadCount, markAllRead } = useNotifications();
  return <button onClick={markAllRead}>Bell ({unreadCount})</button>;
}

function Room({ channelId }: { channelId: string }) {
  const { messages, sendMessage }      = useChat(channelId);
  const { roster }                     = usePresence(channelId);
  const { reactions, react }           = useReactions(channelId);
  const { events }                     = useActivity(channelId);
  const { uploads, upload }            = useFileUpload(channelId);
  const { session, start, join, leave } = useVideoHangout(channelId);

  return (
    <>
      <header>{roster.length} online</header>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => sendMessage({ message: 'hi' })}>send</button>
      <button onClick={() => react('\u{1F525}')}>fire</button>
      <input type="file" onChange={(e) => e.target.files && upload(e.target.files[0])} />
      {!session
        ? <button onClick={() => start()}>Start video</button>
        : <button onClick={leave}>Leave</button>
      }
    </>
  );
}
```

### Per-entity reactions (v0.7.6)

`useReactions` accepts an optional `{ targetId }` to scope reactions to a
specific entity (message, article, comment, …). `react()` forwards the id to
the gateway; `reactionsFor()` lets you filter on demand from the full channel
list without a second subscription.

```tsx
import { useReactions } from '@connorhoehn/realtime-modules/client';

// Scoped hook — only reactions for this article are returned.
function ArticleReactions({ articleId }: { articleId: string }) {
  const { reactions, react } = useReactions('articles', { targetId: articleId });

  return (
    <div>
      {['👍', '❤️', '😂', '😮', '😢'].map((emoji) => (
        <button key={emoji} onClick={() => react(emoji)}>
          {emoji} {reactions.filter((r) => r.emoji === emoji).length}
        </button>
      ))}
    </div>
  );
}

// Channel-level hook with on-demand per-entity filter.
function CommentList({ comments }: { comments: Array<{ id: string; text: string }> }) {
  const { reactionsFor, react } = useReactions('comments');

  return (
    <ul>
      {comments.map((c) => (
        <li key={c.id}>
          {c.text}
          <button onClick={() => react('👍', { targetId: c.id })}>
            👍 {reactionsFor(c.id).filter((r) => r.emoji === '👍').length}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

> **Gateway note.** The `targetId` field passes through the gateway's
> `ReactionService` opaquely. Server-side persistence and per-entity querying
> require a corresponding gateway-side change — track in websocket-gateway.

### CRDT document + awareness

```tsx
import {
  useGateway,
  useYjsDoc,
  useAwarenessState,
  SharedTextEditor,
} from '@connorhoehn/realtime-modules/client';

// Must be inside a GatewaySocketProvider.
export function CollabDoc({ documentId }: { documentId: string }) {
  const ws = useGateway();

  const { ydoc, provider, synced } = useYjsDoc({ documentId, ws });

  useAwarenessState(provider, {
    userId: 'me',
    displayName: 'Connor',
    color: '#ff6b6b',
    mode: 'edit',
    currentSectionId: null,
  });

  if (!synced || !ydoc || !provider) return <div>Loading...</div>;
  return <SharedTextEditor ydoc={ydoc} provider={provider} />;
}
```

### Low-level: `useWebSocket` without a provider

For test fixtures or non-React entry points:

```tsx
import {
  useWebSocket,
  type GatewayMessage,
} from '@connorhoehn/realtime-modules/client';

export function StandalonePanel({ token }: { token: string }) {
  const ws = useWebSocket({
    url: 'wss://gateway.example.com/ws',
    authToken: token,
  });

  // ws.connectionState, ws.clientId, ws.sessionToken, ws.sendMessage …
  return <pre>{ws.connectionState}</pre>;
}
```

### `useCapability` — CRD-derived infrastructure toggles (v0.7.5)

`useCapability` discovers whether a named capability is provisioned for the
current context via the gateway's control plane. Capabilities are driven by
CRDs — they represent infrastructure-level availability questions ("has the
operator enabled chat for this tenant?").

```tsx
import { useCapability } from '@connorhoehn/realtime-modules/client';

function ChatPanel({ channel }: { channel: string }) {
  const { enabled, isLoading } = useCapability('chat');

  if (isLoading) return <Spinner />;
  if (!enabled)  return <ChatNotAvailable />;
  return <ChatRoom channel={channel} />;
}
```

- Falls back to `enabled=true` when the `/api/capabilities` endpoint is not yet
  deployed (404 → optimistic pass-through).
- Reacts to `capability:updated` push frames so CRD toggles take effect without
  a page refresh.
- Optional `channel` arg for channel-scoped capability lookups.

### `useFeatureFlag` — app-level boolean/variant toggles (v0.7.7)

`useFeatureFlag` is the orthogonal companion to `useCapability`. Use it for
A/B tests, gradual rollouts, and kill-switches — decisions that live in the
app layer, not the infrastructure/CRD layer.

**Boolean toggle (kill-switch / gradual rollout)**

```tsx
import { useFeatureFlag } from '@connorhoehn/realtime-modules/client';

function CheckoutButton() {
  const { enabled, isLoading } = useFeatureFlag('new-checkout-ui');

  if (isLoading) return <Spinner />;
  return enabled ? <NewCheckoutButton /> : <LegacyCheckoutButton />;
}
```

**Variant pattern (A/B test)**

```tsx
import { useFeatureFlag } from '@connorhoehn/realtime-modules/client';

function CheckoutFlow() {
  const { variant } = useFeatureFlag('checkout-flow');

  if (variant === 'variant-a') return <CheckoutFlowA />;
  if (variant === 'variant-b') return <CheckoutFlowB />;
  return <CheckoutFlowControl />;
}
```

**vs `useCapability`**

| | `useCapability` | `useFeatureFlag` |
|---|---|---|
| Source of truth | CRD / control-plane | App-level flag store |
| Question | Is this capability provisioned? | Should this user see X? |
| Default (no endpoint) | Optimistic `true` | Caller-supplied `defaultValue` (default `false`) |
| Push frame | `capability:updated` | `feature-flag:updated` |
| Scoping | Optional channel scope | Flag name only |

Falls back gracefully to `defaultValue` (default `false`) when:
- No REST surface is wired (non-WS callers without `GatewayProxyClient`), or
- The `/api/feature-flags` endpoint has not yet landed on the gateway (404 or
  any error is swallowed silently).

Reacts to `feature-flag:updated` push frames so rollout changes take effect
without a page refresh.

---

## `./client/ws` — Yjs-free WebSocket hook

`useWebSocket` only. Use from apps that don't touch CRDT — keeps `yjs`
and `y-protocols` out of the bundle entirely.

```tsx
import { useWebSocket } from '@connorhoehn/realtime-modules/client/ws';

function StatusBar() {
  const { connectionState, clientId } = useWebSocket({
    url: 'wss://gateway.example.com/ws',
    authToken: getToken(),
  });
  return <span>{connectionState} — {clientId}</span>;
}
```

---

## `./agent-streaming` — AG-UI SSE emitter (server)

Server-side emitter for the AG-UI v0.1.x agent-event protocol. Use on
any Express server (or Lambda behind aws-lambda-web-adapter with
Function URL streaming enabled).

### What you get

From `src/agent-streaming/index.ts`:

- `AgentStreamImpl` — one method per AG-UI event: `runStarted`,
  `runFinished`, `textMessageChunk`, `toolCallChunk`, `stateSnapshot`,
  `stateDelta`, `reasoning*`, `runError`, `close`.
- `createAgentStream(res, opts)` — bind to an Express `Response`. Sets
  SSE headers, emits initial ping, starts heartbeat.
- `agentStreamMiddleware(handler, opts)` — Express `RequestHandler`
  factory. Runs the async `handler` with an `AbortSignal`; maps throws
  to `runError`; auto-emits `runFinished` on handler return.
- `validateJsonPatch(patch)` — JSON-Patch validator used by `stateDelta`.
- Full AG-UI event type set (see `agent-streaming/types.ts`).
- `agentStreamingManifest`.

### Middleware usage (recommended)

```ts
import {
  agentStreamMiddleware,
  type AgentStreamHandler,
} from '@connorhoehn/realtime-modules/agent-streaming';

const handler: AgentStreamHandler = async (req, stream, signal) => {
  const runner = await getAgentRunner(req.params.agentId);
  for await (const evt of runner.stream(req.body, { signal })) {
    if (signal.aborted) break;
    switch (evt.type) {
      case 'text':
        stream.textMessageChunk({
          messageId: evt.messageId,
          role: 'assistant',
          delta: evt.text,
        });
        break;
      case 'tool':
        stream.toolCallChunk({
          toolCallId: evt.toolCallId,
          toolCallName: evt.toolName,
          delta: JSON.stringify(evt.args),
        });
        break;
    }
  }
};

app.post(
  '/api/agents/:agentId/stream',
  agentStreamMiddleware(handler, {
    heartbeatMs: 25_000,
    onHandlerError: (err) => metrics.recordError(err),
  }),
);
```

### Manual stream control

```ts
import { createAgentStream }
  from '@connorhoehn/realtime-modules/agent-streaming';

app.post('/api/run', (req, res) => {
  const stream = createAgentStream(res, { heartbeatMs: 30_000 });
  stream.runStarted({ runId: crypto.randomUUID(), threadId: req.body.threadId });
  // … emit events …
  stream.runFinished({ runId: '…' });
  stream.close();
});
```

---

## `./agent-streaming/client` — browser SSE helper

Browser-only fetch + SSE parser. No Express or Yjs dependency.

```ts
import { streamAgentRequest }
  from '@connorhoehn/realtime-modules/agent-streaming/client';

for await (const event of streamAgentRequest('/api/agents/default/stream', {
  body: { userMessage: 'hello' },
  signal: abortController.signal,
})) {
  if (event.type === 'TEXT_MESSAGE_CONTENT') {
    appendText(event.delta);
  }
}
```

Alternatively, use the `useAgentStream` hook from `./client` which
wraps this pattern in React state.

---

## `./adapters/tiptap` — rich-text collaborative editor

Tiptap-coupled subpath. Isolated so Monaco / CodeMirror /
contentEditable consumers never see `@tiptap/*` or ProseMirror in
their bundle.

### What you get

From `src/adapters/tiptap/index.ts`:

- `TiptapEditor` — editor bound to a Yjs `XmlFragment` with custom
  React cursor overlay (bypasses the broken `CollaborationCursor`
  extension).
- `EditorToolbar`.
- Types: `TiptapEditorProps`, `CollaborationProvider`.

### Usage

```tsx
import { TiptapEditor, type CollaborationProvider }
  from '@connorhoehn/realtime-modules/adapters/tiptap';
import { useGateway, useYjsDoc, useAwarenessState }
  from '@connorhoehn/realtime-modules/client';

export function RichDoc({ documentId }: { documentId: string }) {
  const ws = useGateway();
  const { ydoc, provider } = useYjsDoc({ documentId, ws });
  const { updateCursorInfo } = useAwarenessState(provider, {
    userId: 'me',
    displayName: 'Connor',
    color: '#06b6d4',
    mode: 'edit',
    currentSectionId: null,
  });

  if (!ydoc || !provider) return null;

  return (
    <TiptapEditor
      fragment={ydoc.getXmlFragment('prosemirror')}
      ydoc={ydoc}
      provider={provider as CollaborationProvider}
      user={{ name: 'Connor', color: '#06b6d4' }}
      placeholder="Start writing..."
      onUpdateCursorInfo={updateCursorInfo}
    />
  );
}
```

Peer deps: `react`, `yjs`, `y-protocols`, plus the `@tiptap/*` set
(`react`, `starter-kit`, `extension-collaboration`,
`extension-task-list`, `extension-task-item`, `extension-placeholder`,
`y-tiptap`).

---

## `./proxy-client` — HTTP REST shim

Typed REST client for Lambda / SSR callers that talk to the gateway
over HTTP instead of WebSocket.

### What you get

From `src/proxy-client/index.ts`:

- `GatewayProxyClient` — class with typed methods for all gateway REST
  endpoints.
- `ProxyClientError` and subtypes: `ProxyClientHttpError`,
  `ProxyClientNetworkError`, `ProxyClientTimeoutError`.
- Types: `ProxyClientOptions`, `ChatMessage`, `PresenceEntry`,
  `PresenceStatus`, `ActivityEvent`, and gateway response shapes.

### Usage with automatic HMAC signing (v0.7.1+)

```ts
import {
  GatewayProxyClient,
  ProxyClientHttpError,
} from '@connorhoehn/realtime-modules/proxy-client';

const proxy = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET,
  serviceAuthClientId: 'my-lambda-app',
  timeout: 5_000,
});

// All calls automatically include X-Service-Auth header.
await proxy.publishToChannel('room:42', { type: 'notice', text: 'hello' });

const { messages } = await proxy.getChatHistory('room:42', { limit: 50 });
const { users }    = await proxy.getPresence('room:42');
const { events }   = await proxy.getActivityHistory('room:42', { limit: 20 });

// Gateway health + stats (no auth required).
const health = await proxy.getHealth();
const stats  = await proxy.getStats();

// Error handling.
try {
  await proxy.publishToChannel('room:42', { type: 'test' });
} catch (err) {
  if (err instanceof ProxyClientHttpError) {
    console.error('HTTP error', err.statusCode, err.message);
  }
}
```

### Lambda + SSE compatibility note

`./proxy-client` (pure HTTP/REST) works in any Lambda configuration.
`./agent-streaming` (SSE emitter) works in Lambda **only** via
[aws-lambda-web-adapter] with `AWS_LWA_INVOKE_MODE=response_stream`
and a **Function URL** — API Gateway buffers responses and breaks SSE.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

---

## `./server-ws` — server-side WS handler factory

Thin wrapper around `ws.Server` for hosts that want a local WebSocket
surface (tests, fixtures, standalone servers). The gateway itself does
not use this subpath in production.

### What you get

From `src/server-ws/index.ts`:

- `createWsHandler(opts) → WsHandlerHandle`.
- Types: `WsService`, `WsAuthFn`, `WsAuthContext`, `WsHandlerOptions`,
  `WsHandlerHandle`, `WsHttpServer`.

Wire protocol — inbound frames: `{ service, action, ...data }` →
`services[service].handleAction(clientId, action, data)`. Session
handshake on connect: `{ type: 'session', status: 'connected',
clientId, timestamp }`. Unknown service → `SERVICE_NOT_AVAILABLE`
error frame.

### Usage

```ts
import { createServer } from 'http';
import { createWsHandler } from '@connorhoehn/realtime-modules/server-ws';

const http = createServer(/* your express app */);

const handle = createWsHandler({
  server: http,
  services: {
    // Any object with handleAction(clientId, action, data) satisfies WsService.
    myService: {
      async handleAction(clientId, action, data) {
        console.log('action', action, 'from', clientId);
      },
    },
  },
  auth: async (req) => {
    const userId = await verifyToken(extractToken(req));
    if (!userId) throw new Error('unauthorized');   // → 401
    return { userId };
  },
  pingIntervalMs: 30_000,
  path: '/ws',
  onConnect: (clientId, ctx) => console.log('connect', clientId, ctx),
  onDisconnect: (clientId) => console.log('disconnect', clientId),
});

http.listen(3000);

// Imperative helpers.
handle.sendToClient(clientId, { type: 'notice', text: 'maintenance soon' });
const clients = handle.listClients();
await handle.dispose();   // graceful shutdown
```

Peer dep: `ws` (consumer-installed).

The `useWebSocket` hook in `./client` speaks the same protocol — the
`{ service, action, ... }` inbound shape and the `{ type: 'session' }`
handshake frame are matched on both ends.

---

## Where the package leaves you on your own

- **Server-side service classes** — `CRDTService`, `ChatService`,
  `PresenceService`, `ReactionService`, `ActivityService` all live in
  `websocket-gateway/src/`. Consume them through the gateway WS
  protocol (client hooks) or REST (`./proxy-client`).
- **Cross-node fan-out** — every `*MessageRouter` interface in the
  gateway is a contract; the gateway supplies its own Redis pub/sub
  implementations.
- **Auth / authz** — `createWsHandler` accepts an `auth` callback;
  `GatewaySocketProvider` forwards a `token`; gateway routes check
  service-auth headers. The rest is application logic.
- **DDB / Redis client lifecycle** — gateway adapters own their
  clients. Reference implementations at
  `websocket-gateway/src/realtime-fanout/crdt/adapters/`.
