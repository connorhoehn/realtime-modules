# @connorhoehn/realtime-modules

Realtime feature toolkit — UI hooks, backend services, and `FeatureManifest`
declarations packaged as feature triples (chat, presence, CRDT, cursors,
reactions, agent-streaming, and more). Consumers wire a transport + storage
adapters; the package provides the fan-out logic and channel contracts.

**Status.** Used by `websocket-gateway` in production. OrgIQ adoption in
progress. Pre-1.0 (`0.x`) — subpath shapes and storage contracts are
unstable; pin exact tags.

## Quick Start

Wire presence + chat into a Node server in five steps:

```ts
import http from 'http';
import { createWsHandler }                       from '@connorhoehn/realtime-modules/server-ws';
import { ChatService, InMemoryChatStore }         from '@connorhoehn/realtime-modules/chat';
import { PresenceService, PresenceManifest }      from '@connorhoehn/realtime-modules/presence';
import { ChatManifest }                           from '@connorhoehn/realtime-modules/chat';

// 1. Implement the minimal MessageRouter your services need.
const router = {
  nodeId: 'node-1',
  sendToClient:         (id, msg)            => { /* send JSON frame to WS client */ },
  sendToChannel:        (ch, msg, exclude)   => { /* fan-out to channel subscribers */ },
  subscribeToChannel:   (id, ch)             => { /* track subscription */ },
  unsubscribeFromChannel: (id, ch)           => { /* remove subscription */ },
};
const logger = { debug: console.debug, info: console.info,
                 warn: console.warn, error: console.error };

// 2. Instantiate feature services.
const chatService     = new ChatService({ store: new InMemoryChatStore(), router, logger });
const presenceService = new PresenceService(router, logger);

// 3. Attach to an HTTP server.
const server = http.createServer();
const wsHandle = createWsHandler({
  server,
  services: { chat: chatService, presence: presenceService },
  auth: async (req) => ({ userId: req.headers['x-user-id'] as string }),
});
server.listen(3000);

// 4. Read manifests to validate env + log the channel contract.
for (const m of [ChatManifest, PresenceManifest]) {
  console.log(`[${m.name}@${m.version}] channels: ${m.channels?.join(', ')}`);
}

// 5. React client — connect and subscribe.
//    import { useWebSocket } from '@connorhoehn/realtime-modules/client/ws';
//    const { send, subscribe } = useWebSocket({ url: 'ws://localhost:3000', authToken });
//    subscribe('chat:room-1');
//    send({ service: 'chat', action: 'send', channel: 'chat:room-1', content: 'hello' });
```

For the full walkthrough see
**[docs/FEATURE-MANIFEST-GUIDE.md](./docs/FEATURE-MANIFEST-GUIDE.md)** — covers
all 12 feature modules, client hooks, `GatewayProxyClient` for Lambda/backend
callers, and a step-by-step guide to adding your own feature module.

## Install

The package is **not on npm** and lives in its own standalone GitHub repo
at `github:connorhoehn/realtime-modules`. Install via a git tag pin:

**Canonical: GitHub tag pin**

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.4.3"
  }
}
```

The repo ships a pre-built `dist/` so no local build step is needed.
`npm install` resolves the tag, clones the repo root (which is the
library's own `package.json`), and uses the pre-built output directly.

**`file:` pin for local development / sibling checkouts**

If you have a local clone at a known path, a `file:` pin works too:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

Run `npm run build` inside the clone once after pulling to refresh `dist/`.
`file:` consumers pick up changes on the next `npm install`.

Peer-deps (`react`, `express`, `ws`, `yjs`, `y-protocols`, `@tiptap/*`) are
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

- **`skipLibCheck: true`** — required to suppress transitive type conflicts
  from `yjs` and `lru-cache` that surface under TypeScript 5.x/6.x. Without
  this, consumers see errors from the library's own type declarations even
  when they never import those subpaths.
- **`moduleResolution: "bundler"` (or `"node16"`/`"nodenext"`)** — required
  for subpath imports (e.g. `@connorhoehn/realtime-modules/client/ws`) to
  resolve correctly. The classic `"node"` mode does not support package
  `exports` subpath maps.

## Subpaths

Server primitives:

- `/server` — CRDT orchestrator (`CRDTService`, `SnapshotManager`,
  `DocumentMetadataService`, `DocumentPresenceService`, store contracts +
  memory impls).
- `/server-ws` — `createWsHandler` factory pairing with the `/client`
  `useWebSocket` hook; lazy-loads `ws`.

Client primitives:

- `/client` — `useWebSocket`, `useCRDT`, `useYjsDoc`, `useAwarenessState`,
  `useIdleDetector`, `GatewayProvider`, `SharedTextEditor` (editor-agnostic).
- `/adapters/tiptap` — Tiptap-specific `TiptapEditor` + toolbar; isolated
  so non-Tiptap consumers don't pull ProseMirror.

Fan-out services (WS subscription + frame routing; pure in-memory unless
you wire a store):

- `/chat` — `ChatService` + `ChatStore` contract + `InMemoryChatStore`.
- `/presence` — in-process `PresenceService` with status tracking.
- `/reactions` — emoji fan-out with per-channel LRU history.
- `/cursor` — cursor-position broadcast with TTL sweep.
- `/social` — social-event WS subscription surface.
- `/call` — hangout/call invite signaling (no WebRTC media plane).
- `/activity` — activity-feed fan-out + `ActivityHistoryStore` contract.
- `/ingest` — WS-side ingest subscription fan-out.
- `/pipeline` — pipeline event subscription + `BusEvent` → frame projection.
- `/typed-documents` — subscribe/unsubscribe surface for typed-document
  events (persistence stays in gateway / platform-api).

Agent:

- `/agent-streaming` — server-side AG-UI v0.1.x emitter: `createAgentStream`,
  `agentStreamMiddleware`, full AG-UI event type tree.

Root entry (`@connorhoehn/realtime-modules`) re-exports the `FeatureManifest`
type plus `/agent-streaming`, `/client`, `/server`, and all fan-out services
for convenience; subpath imports are preferred for tree-shaking.

## Transport tiers

Subpaths split into two runtime tiers based on the transport assumption
each makes. Choose your deployment target accordingly.

**Lambda lane** (1 subpath today): `/agent-streaming` — pure HTTP + SSE.
Works in AWS Lambda via [aws-lambda-web-adapter] with a Function URL and
`AWS_LWA_INVOKE_MODE=response_stream`. **NOT compatible with API Gateway**
(REST or HTTP API) — those buffer responses and break SSE. Function URL
streaming is GA across all regions as of April 2026.

**ECS lane** (13 subpaths): `/chat`, `/presence`, `/cursor`, `/reactions`,
`/social`, `/call`, `/typed-documents`, `/ingest`, `/activity`,
`/pipeline`, `/server`, `/server-ws`, `/client`, `/adapters/tiptap` —
assume a persistent WebSocket runtime via `MessageRouterContract`. These
services hold in-process state (subscription tables, eviction timers,
CRDT documents) and need long-lived connections. **websocket-gateway is
the canonical WS runtime.** Other ECS/Fargate/EC2 hosts work too as long
as connections persist for the lifetime of the process.

**WS-on-Lambda via API Gateway WebSocket API is a trap.** The per-message
Lambda invocation model destroys shared-memory primitives — every frame
gets a cold container, so `SubscriptionTracker`, `EvictionTimer`, and CRDT
state cannot survive between messages. Don't try.

**Lambda apps that need ECS-lane features** should consume them via
gateway over HTTP. The `/proxy-client` subpath planned for v0.2.0 will
wrap the gateway's HTTP surface for SSR/Lambda callers.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

## Quick start

Backend chat with an in-memory store:

```ts
import { ChatService, InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';

const chat = new ChatService({
  store: new InMemoryChatStore(),
  router: myMessageRouter,
});
```

Client WebSocket hook:

```ts
import { useWebSocket } from '@connorhoehn/realtime-modules/client';

const { state, send, lastMessage } = useWebSocket({
  url: 'wss://gateway.example/ws',
  authToken: () => getAuthToken(),
});
```

Server-side AG-UI SSE stream:

```ts
import { createAgentStream } from '@connorhoehn/realtime-modules/agent-streaming';

app.post('/agent/run', (req, res) => {
  const stream = createAgentStream({ res });
  stream.runStarted({ runId: 'r1', threadId: 't1' });
  stream.textMessageChunk({ messageId: 'm1', delta: 'hi' });
  stream.runFinished({ runId: 'r1' });
});
```

## Pluggable storage

Each persistent service takes a store via DI. Contracts live alongside
the service; in-memory defaults ship for tests/dev:

- `ChatStore` — `InMemoryChatStore` default.
- `SnapshotStore`, `MetadataStore`, `HotCache` — `MemorySnapshotStore`,
  `MemoryMetadataStore`, `MemoryHotCache` defaults.
- `ActivityHistoryStore` — `InMemoryActivityHistoryStore` default.

Production consumers (e.g. gateway) wire Redis / DynamoDB / S3 adapters
that satisfy these interfaces. The store contracts are load-bearing —
changes are breaking.

## FeatureManifest

Every feature exports a `*Manifest` declaring the env vars it reads, the
WS channel patterns it subscribes/publishes on, the event-catalog
declarations it emits, and any feature dependencies. Host applications
read manifests at boot to build the platform's channel/event contract
without per-feature glue. See `src/feature-manifest/types.ts`.

## Versioning + stability

`0.x` is unstable. Pin to exact git tags (e.g. `#v0.4.3`).
Breaking changes can land in any minor release; storage contracts and WS
frame shapes count as load-bearing surface. `1.0` will mean stable
storage contracts and stable WS protocol.

## Links

- [docs/ADOPTION-GUIDE.md](./docs/ADOPTION-GUIDE.md) — full adoption walkthrough.
- [docs/USAGE-PATTERNS.md](./docs/USAGE-PATTERNS.md) — common wiring patterns.
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./docs/USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps.
- [CHANGELOG.md](./CHANGELOG.md).
- [LICENSE](./LICENSE) — MIT.
