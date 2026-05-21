# @connorhoehn/realtime-modules

Realtime feature toolkit — UI hooks, backend services, and `FeatureManifest`
declarations packaged as feature triples (chat, presence, CRDT, cursors,
reactions, agent-streaming, and more). Consumers wire a transport + storage
adapters; the package provides the fan-out logic and channel contracts.

**Status.** Used by `websocket-gateway` in production. OrgIQ adoption in
progress. Pre-1.0 (`0.x`) — subpath shapes and storage contracts are
unstable; pin exact tags.

## Install

The package is **not on npm** and lives inside the `websocket-gateway` repo
as a subdirectory. Use a `file:` pin pointing at a sibling clone — same
pattern the gateway uses for its own consumption of this package and for
its `distributed-core` pin.

**Canonical: `file:` pin (sibling consumers)**

Gateway (in-tree, consumes its own subdirectory):

```json
{ "dependencies": { "@connorhoehn/realtime-modules": "file:./realtime-modules" } }
```

OrgIQ / other sibling consumers (parallel clone of `websocket-gateway`):

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules":
      "file:../../websocket-gateway/realtime-modules"
  }
}
```

This works because `realtime-modules/package.json` declares the package
name and entry points; npm resolves directly to the subdirectory and
respects the `dist/` build output. Run `npm run build` inside
`realtime-modules/` once after pulling — `file:` consumers see updates on
next install.

**Does NOT work: git-tag pin**

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules":
      "github:connorhoehn/websocket-gateway#realtime-modules-v0.1.0"
  }
}
```

npm clones the gateway repo root, where `package.json` is the gateway's,
not the library's. npm has no native subpath-in-git-URL support, so the
install resolves to the wrong package. **Verified broken by OrgIQ
adoption 2026-05-19.** The `realtime-modules-v0.1.0` tag exists for
provenance only; do not use it as an install source.

**Non-sibling consumers** (no parallel `websocket-gateway` checkout
available) have two options, both out of scope for v0.1.0/v0.2.0:
1. Git sparse-checkout workaround (manual, not npm-native).
2. Eventual npm publish (future work — no timeline).

Peer-deps (`react`, `express`, `ws`, `yjs`, `y-protocols`, `@tiptap/*`) are
all **optional** — install only what the subpaths you import require.

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
  token: () => getAuthToken(),
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

`0.x` is unstable. Pin to exact git tags (`#realtime-modules-v0.1.0`).
Breaking changes can land in any minor release; storage contracts and WS
frame shapes count as load-bearing surface. `1.0` will mean stable
storage contracts and stable WS protocol.

## Links

- [docs/ADOPTION-GUIDE.md](./docs/ADOPTION-GUIDE.md) — full adoption walkthrough.
- [docs/USAGE-PATTERNS.md](./docs/USAGE-PATTERNS.md) — common wiring patterns.
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./docs/USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps.
- [CHANGELOG.md](./CHANGELOG.md).
- [LICENSE](./LICENSE) — MIT.
