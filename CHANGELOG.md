# Changelog

All notable changes to `@connorhoehn/realtime-modules` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package remains on the `0.x` line, all releases are considered
**unstable**: APIs, subpath export shapes, and storage-contract interfaces
may change between minor versions. Consumers should pin to exact tags and
re-run `npm run typecheck` on every bump.

---

## [Unreleased]

## [0.3.0] — 2026-05-19

### Fixed

- **`GatewayProxyClient` doc-comments** — removed "will 404" warnings
  on channel-publish / presence-query / chat-history / activity-history
  methods. Gateway HTTP API routes shipped in websocket-gateway commit
  `a62195c` (Wave 6); methods now work, gated by service-auth HMAC.
  Doc-comments updated to reflect the new requirement
  (`SERVICE_AUTH_SECRET` wired in helm before methods activate).

### Changed

- Verified `useAgentStream` is discoverable from package root in
  addition to `./client` and `./agent-streaming/client` subpaths.
  No change required; already exported via `export * from './client'`
  in `src/index.ts`.

## [0.2.1] — 2026-05-19

### Fixed

- **`useAgentStream` bundling failure for non-CRDT consumers** — added
  `./agent-streaming/client` subpath that exports `useAgentStream`
  without transitively importing Yjs/y-protocols. The `/client` barrel
  re-exports `GatewayProvider` which imports `y-protocols/awareness`
  at module top; consumers like OrgIQ portal that don't have Yjs
  installed failed to bundle under Vite. The new subpath bypasses
  the Yjs-bound exports. Pairs with the server-side
  `./agent-streaming` middleware.
- **Release process** — added `prepublishOnly` script and `RELEASE.md`
  recipe to prevent the v0.2.0 issue (tag created without running
  `npm run build`; dist/ missing useAgentStream.{js,d.ts}). file:
  consumers were saved by `prepare` hook on install, but
  `git tag` checkouts would have shipped incomplete dist.

## [0.2.0] — 2026-05-19

Wave 5 — Lambda-app enablement.

### Added

- **`./proxy-client` subpath** — `GatewayProxyClient` class for
  Lambda-native apps (OrgIQ, future App #3) to USE gateway-hosted
  realtime features over HTTP without speaking WebSocket. Wraps the
  gateway's existing ops endpoints (`/health`, `/cluster`, `/stats`,
  `/metrics`, `/hooks/pipeline/:path`) and pins URL shapes for the
  strategic channel/presence/chat/activity surface (those routes
  will 404 until gateway ships matching HTTP endpoints — documented
  as gateway-side follow-up). Includes `ProxyClientError` taxonomy
  (`Network` / `Http` / `Timeout`). +20 tests.
- **`useAgentStream` React hook in `./client`** — pairs with the
  server-side `agentStreamMiddleware` (`./agent-streaming`) for full
  FE adoption of AG-UI v0.1.x. Returns `{messages, streamingText,
  activeToolCalls, sessionId, isStreaming, error, sendMessage,
  reset, loadHistory}`. Replaces hand-rolled per-app hooks (OrgIQ's
  `useAgUiStream.ts` ~188 LOC) with a single library import. Handles
  CUSTOM `session` and `tool_call_result` events internally for
  AG-UI spec-gap interop. +13 tests.

### Fixed

- **README install path** — git-tag pin pattern
  (`github:owner/repo#tag`) was documented but doesn't work (npm
  clones gateway repo root, not the `realtime-modules/` subdirectory).
  README now documents `file:` sibling pin as canonical.
- **Subpath polish** — dropped `SubscriptionTracker` leak from `./chat`
  barrel (no external consumers, verified).

### Documentation

- **Transport-tiers section** added to README: Lambda lane
  (`/agent-streaming` only; HTTP+SSE via AWS Lambda Web Adapter on
  Function URL with `AWS_LWA_INVOKE_MODE=response_stream`) vs ECS
  lane (13 subpaths assuming persistent WebSocket via
  `MessageRouterContract`). Calls out the WS-on-Lambda-via-API-Gateway
  trap for cross-app shared state.

### Known gaps (documented, not blocking)

- Gateway-side HTTP endpoints for channel publish / presence query /
  chat history / activity history don't exist yet — `proxy-client`
  pins URL shapes but those methods return 404 until gateway ships
  matching routes.
- AG-UI v0.1.x spec gaps (sessionId on RUN_STARTED, result on
  TOOL_CALL_END) handled via CUSTOM events in `useAgentStream`.

---

## 0.1.0 — 2026-05-19

First public version. 16 subpaths shipped (server/client primitives + 10
fan-out services + agent-streaming + FeatureManifest contract). Gateway
is the reference consumer; OrgIQ adoption underway. 0.x is unstable —
pin exact tags; storage contracts are load-bearing.

### Added

- **`./client` — `useWebSocket` hook (Wave 3 fill).** Lifts the
  transport/reconnect/session logic currently duplicated in the
  gateway frontend (`frontend/src/hooks/useWebSocket.ts`) into a
  shared hook satisfying the existing `UseWebSocketReturn` contract.
- **`./client` — `useWebSocket` v2 (gateway swap-unblock).** Closes the
  five gaps documented in `docs/USEWEBSOCKET-GAP-vs-GATEWAY.md` so the
  gateway can drop its in-tree hook:
    - `persist?: { storage, keyPrefix? }` — opt-in sessionStorage
      persistence for `sessionToken` / `clientId` across page reloads.
    - `maxRetries?: number` (default `Infinity`) — when finite,
      exhausted retries transition to `disconnected` and emit a
      terminal `RECONNECT_EXHAUSTED` `GatewayError`.
    - `defaultChannel?: string` — seeds `currentChannel` on first
      render so feature hooks observe a non-empty channel.
    - Stale-socket guards on every handler (`onopen` / `onmessage` /
      `onerror` / `onclose`) — drops late events from sockets that
      React StrictMode's double-mount has already superseded.
    - `autoResubscribe?: boolean` (default `false`) — auto-replay of
      tracked channels on reconnect is now opt-in. Default matches
      gateway's pull model where feature hooks own subscribe lifecycle.
    - All five behaviors are opt-in / backward-compatible; existing
      consumers continue to work without changes.
- **`./server` — WebSocket handler factory (Wave 3 fill).** Server-side
  counterpart so consumers no longer have to hand-roll WS wiring around
  `CRDTService` + `MessageRouterContract`.

#### Scaffold + core (commit `61496b7`)

- Package skeleton: `@connorhoehn/realtime-modules`, MIT license,
  optional peer-deps for `react`, `express`, `yjs`, `y-protocols`,
  `@tiptap/*` so subpaths can be cherry-picked without pulling
  unrelated runtimes.
- Build + test toolchain: `tsc`, `jest` with `ts-jest`, `jsdom`
  environment for React-tier tests, `prepare` script so `file:` pins
  rebuild on install.
- **`FeatureManifest` type contract** (root export) — the shape every
  feature ships alongside its UI + backend triple: `name`, `version`,
  `envVars`, `channels`, `declarations`, `dependencies`, and
  `install.{backendRoutes,frontendImport}` hooks for the future CLI.

#### `./server` — CRDT (Cut 1, commit `ac3940b`)

Lifted from gateway's collaborative-documents stack:

- **`CRDTService`** — orchestrator for collaborative document state.
  Options-bag constructor accepting `messageRouter`, `snapshotStore`,
  `metadataStore`, `hotCache`, `logger`, and an optional `authz`
  callback (default permissive).
- **`SnapshotManager`** — parameterized over the `SnapshotStore` and
  `HotCache` contracts. Owns gzip snapshotting + restore.
- **`DocumentMetadataService`** — parameterized over the `MetadataStore`
  contract. Owns document-level metadata (titles, version names, etc.).
- **`DocumentPresenceService`**, **`AwarenessCoalescer`**, and
  **`IdleEvictionManager`** — awareness-state coalescing + idle-room
  eviction.
- **Store contracts**: `SnapshotStore`, `MetadataStore`, `HotCache`,
  `MessageRouterContract` — the entire pluggable-storage surface area.
  Snapshot bytes are gzipped at the contract boundary; stores
  round-trip them byte-for-byte.
- **In-memory store implementations**: `MemorySnapshotStore`,
  `MemoryMetadataStore`, `MemoryHotCache` — what the test suite uses
  and what zero-config consumers get out of the box.
- **`config` namespace** export — tuning knobs (snapshot intervals,
  eviction windows, operation batch window) as module-level constants.
- **`crdtManifest`** — `FeatureManifest` export for the CRDT feature.

#### `./client` — CRDT client (Cut 1, commit `ac3940b`)

- **`GatewayProvider`** — editor-agnostic Y.js provider. Bridges any
  `UseWebSocketReturn`-shaped transport to a `Y.Doc`.
- **Hooks**: `useYjsDoc`, `useAwarenessState`, `useCRDT`,
  `useIdleDetector`.
- **`SharedTextEditor`** — `contentEditable`-based fallback editor so
  consumers can render collaborative text without pulling in Tiptap,
  Monaco, or CodeMirror.
- **`UseWebSocketReturn` type contract** — `client/types.ts`. Now paired
  with a shipped `useWebSocket` implementation (see Wave 3 fill above).

#### `./adapters/tiptap` — Tiptap integration (commit `ac3940b`)

- **`TiptapEditor`** + **`EditorToolbar`** — wired against `Y.Doc` +
  `GatewayProvider`. Lives in a dedicated subpath so Monaco / CodeMirror
  / `contentEditable` consumers don't pay for Tiptap or ProseMirror.

#### `./agent-streaming` — AG-UI v0.1.x server emitter (commit `ac3940b`)

- **`AgentStreamImpl`** — server-side emitter implementing all 28 AG-UI
  v0.1.x event types with correct field naming (text, tool calls,
  reasoning, state, activity, lifecycle, etc.).
- **`createAgentStream`** — factory that opens an SSE response with
  keepalive heartbeat.
- **`agentStreamMiddleware`** — Express `RequestHandler` factory for
  `POST /…/stream` endpoints. The only Express-aware export in the
  package today.
- **`agentStreamingManifest`** — `FeatureManifest` export.
- Pairs with `@connorhoehnslalom/ui-components/agents` on the client.

#### `./presence` — Wave 2 (commit `74fd725`)

- **`PresenceService`** — in-process presence tracking with
  `subscribe`, `get`, `set`, and `heartbeat`. Configurable heartbeat /
  eviction timeouts and a pluggable `authorize` hook for per-channel
  access control.
- **`presenceManifest`** — `FeatureManifest` export.

#### `./chat` — Wave 2 (commit `74fd725`)

- **`ChatService`** — channel `join` / `leave` / `send` / `history`
  with an LRU-backed per-channel message cache.
- **`ChatStore` interface** + **`InMemoryChatStore`** reference
  implementation — the bring-your-own-storage seam for chat history.
- **`chatManifest`** — `FeatureManifest` export.

#### `./reactions` — Wave 2 (commit `74fd725`)

- **`ReactionService`** — emoji reactions tracked in a per-channel
  ring-buffer history.
- **Default reaction catalog** — 12 built-in emoji reactions out of
  the box.
- **`reactionsManifest`** — `FeatureManifest` export.

#### Docs (commit `74fd725`)

- `docs/ADOPTION-GUIDE.md` — operator-facing guide covering install,
  subpath overview, end-to-end "agent dashboard" example,
  bring-your-own-storage adapter recipe, `FeatureManifest` pattern,
  what's-not-included, and operational notes (peer-dep handling,
  cross-consumer pinning, logging/metrics, config overrides).

### Planned (post-extraction)

- **`realtime-modules` CLI** — `npx realtime-modules add <feature>`
  scaffolder that reads `FeatureManifest.install.{backendRoutes,frontendImport}`
  and wires the consumer's app. Aspirational; deferred until the package
  is extracted to its own repo.

### Known gaps at 0.1.0

- **No Express route mounters.** Features (other than
  `agentStreamMiddleware`) ship as service classes; backend route
  mounting is the consumer's responsibility.
- **No `realtime-modules` CLI.** `npx realtime-modules add <feature>`
  is aspirational.
- **`FeatureManifest` exports are partial.** All subpath manifests
  (`crdtManifest`, `agentStreamingManifest`, `presenceManifest`,
  `chatManifest`, `reactionsManifest`) are present, but platform
  tooling that consumes them (gateway / edge-gateway boot-time
  validation, channel pre-registration, event-catalog wiring) is not
  yet wired end-to-end.

### Stability

Every public API in `0.1.0` is **unstable** under the `0.x` contract.
Storage interfaces (`SnapshotStore`, `MetadataStore`, `HotCache`,
`ChatStore`, `MessageRouterContract`) are load-bearing — breaking
changes to those shapes will bump the minor version and be called out
explicitly in release notes so consumer adapter implementations can be
updated in lockstep.

[Unreleased]: https://github.com/connorhoehn/realtime-modules/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/connorhoehn/realtime-modules/releases/tag/v0.1.0
