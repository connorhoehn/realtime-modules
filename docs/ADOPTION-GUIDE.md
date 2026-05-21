# Adoption Guide — `@connorhoehn/realtime-modules`

Operator-facing guide for installing the realtime-modules toolkit into
a new app and wiring its subpath exports.

---

## 1. What `realtime-modules` is

`@connorhoehn/realtime-modules` is a **toolkit** (not a framework) for
building realtime experiences — collaborative documents, presence,
chat, reactions, agent streaming — out of reusable **feature triples**:

1. **UI** — React components and hooks the consumer mounts into its app.
2. **Backend** — Service classes the consumer wires into its server.
3. **Manifest** — a `FeatureManifest` declaring env vars, WS channel
   patterns, event-catalog declarations, dependencies, and install
   hooks so platform tooling (`gateway`, `edge-gateway`,
   `realtime-fanout`) can discover which channels and events to expect.

Storage adapters are **pluggable**: every feature talks to one or more
storage interfaces (`SnapshotStore`, `MetadataStore`, `HotCache`,
`MessageRouterContract`) so consumers bring their own backend (DDB,
Postgres, SQLite, in-memory) without forking the package. Pick what
you want — subpath exports keep your bundle small.

---

## 2. Installation

### Inside this monorepo

`realtime-modules` currently lives at `websocket-gateway/realtime-modules/`.
Apps in the same workspace can depend on it via a file pin:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

After `npm install`, the package's `prepare` script runs `tsc` so the
`dist/` artifacts are in place before the consumer compiles.

### Once extracted to its own GitHub repo

When realtime-modules graduates to a standalone repository, pin to a
released tag:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "github:connorhoehn/realtime-modules#v0.3.0"
  }
}
```

Pin to **immutable tags**, not branches. The package follows the same
"main HEAD or tagged release, never floating branch" rule applied to
`distributed-core` and `event-catalog`.

### Peer dependencies

All peer deps are marked **optional** so subpaths can be cherry-picked.
Install only what your chosen subpaths require:

| Subpath | Required peer deps |
| --- | --- |
| `./server` | `yjs`, `y-protocols` |
| `./client` | `react`, `yjs`, `y-protocols` |
| `./adapters/tiptap` | `react`, `yjs`, plus the full `@tiptap/*` set |
| `./agent-streaming` | `express` (server only) |

---

## 3. Subpaths overview

The package ships these entry points (see `package.json#exports`):

| Subpath | Provides |
| --- | --- |
| `@connorhoehn/realtime-modules` (root) | `FeatureManifest` type + re-exports of `./agent-streaming`, `./client`, `./server` for ergonomic single-import access. Prefer dedicated subpaths for tree-shaking. |
| `@connorhoehn/realtime-modules/server` | `CRDTService` (orchestrator), `SnapshotManager`, `DocumentMetadataService`, `DocumentPresenceService`, `AwarenessCoalescer`, `IdleEvictionManager`, store contracts (`SnapshotStore`, `MetadataStore`, `HotCache`, `MessageRouterContract`), and the in-memory store implementations (`MemorySnapshotStore`, `MemoryMetadataStore`, `MemoryHotCache`). Includes `config` namespace for overriding windows. |
| `@connorhoehn/realtime-modules/client` | `GatewayProvider` (editor-agnostic Y.js bridge), `useYjsDoc`, `useCRDT`, `useAwarenessState`, `useIdleDetector`, and `SharedTextEditor` (`contentEditable`-based, no editor dependency). |
| `@connorhoehn/realtime-modules/adapters/tiptap` | `TiptapEditor` + `EditorToolbar`. Separated so Monaco / CodeMirror / contentEditable consumers don't pull in Tiptap or ProseMirror. |
| `@connorhoehn/realtime-modules/agent-streaming` | AG-UI v0.1.x server-side emitter: `AgentStreamImpl`, `createAgentStream`, `agentStreamMiddleware`, and the full AG-UI event type set (text, tool calls, reasoning, state, activity, etc.). Pairs with `@connorhoehnslalom/ui-components/agents` on the client. |

### Wave 2 subpaths (in flight)

The package layout reserves these subpath directories. The exports map
in `package.json` does not yet include them — track Wave 2 PRs for
when they go live:

- `./presence` — `PresenceService` + `MessageRouterContract` (extraction in progress, task #31).
- `./chat` — `ChatService` + `ChatStore` interface + `InMemoryChatStore` (task #32).
- `./reactions` — `ReactionService` (task #33).

Until those land, presence/chat/reactions consumers must continue
calling the gateway's HTTP/WS APIs directly.

---

## 4. Concrete example — building a hypothetical "agent dashboard" app

An Express + React app that wants three features:

1. **WS connection management** (from `./client`).
2. **Presence** (would consume `./presence`, *blocked* on Wave 2 — see gap below).
3. **AG-UI streaming chat** (from `./agent-streaming` server + the matching client emitter package).

### 4.1 `package.json`

```json
{
  "name": "agent-dashboard",
  "private": true,
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules",
    "@connorhoehnslalom/ui-components": "^1.0.0",
    "express": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "yjs": "^13.6.0",
    "y-protocols": "^1.0.7"
  }
}
```

### 4.2 Backend wiring — Express boot

```ts
// server/index.ts
import express from 'express';
import { agentStreamMiddleware } from '@connorhoehn/realtime-modules/agent-streaming';
import {
  CRDTService,
  MemorySnapshotStore,
  MemoryMetadataStore,
  MemoryHotCache,
  type MessageRouterContract,
} from '@connorhoehn/realtime-modules/server';

const app = express();
app.use(express.json());

// 1. CRDT service for collaborative documents.
//    Plug in your own MessageRouter implementation that bridges to
//    your WS transport — this app uses a thin in-process router.
const messageRouter: MessageRouterContract = createInProcessRouter();

const crdt = new CRDTService({
  messageRouter,
  snapshotStore: new MemorySnapshotStore(),
  metadataStore: new MemoryMetadataStore(),
  hotCache: new MemoryHotCache(),
  logger: console,
  // Optional authz hook. Default is permissive.
  authz: (clientId, channel) => isAllowed(clientId, channel),
});

// 2. AG-UI streaming chat. Mount POST + SSE handler.
app.post('/api/agents/:agentId/stream', agentStreamMiddleware(
  async (req, stream, signal) => {
    const runner = await getAgentRunner(req.params.agentId);
    for await (const evt of runner.stream(req.body, { signal })) {
      // Dispatch each AG-UI event onto the stream.
      switch (evt.type) {
        case 'text': stream.textMessageChunk({ delta: evt.text }); break;
        case 'tool': stream.toolCallChunk(evt.payload); break;
        // ... etc
      }
    }
  },
  { heartbeatMs: 25_000 }
));

app.listen(3000);
```

Note: the app **wires its own Express routes** for CRDT. The package
ships service classes, not route mounters (see §7).

### 4.3 Frontend — React component imports

```tsx
// app/components/CollabDoc.tsx
import { useYjsDoc, useAwarenessState, SharedTextEditor }
  from '@connorhoehn/realtime-modules/client';
import type { UseWebSocketReturn }
  from '@connorhoehn/realtime-modules/client';

export function CollabDoc({
  ws,
  documentId,
}: {
  ws: UseWebSocketReturn;       // satisfies the contract (see gap below)
  documentId: string;
}) {
  const { ydoc, provider, synced } = useYjsDoc({
    documentId,
    ws,
    onMessage: ws.onMessage,    // adapter on the consumer side
  });

  const awareness = useAwarenessState(provider, {
    userId: 'me',
    color: '#ff6b6b',
  });

  if (!synced) return <div>Loading document...</div>;

  return <SharedTextEditor ydoc={ydoc!} provider={provider!} />;
}
```

```tsx
// app/components/AgentChat.tsx
import { AgentStreamConsumer }
  from '@connorhoehnslalom/ui-components/agents';

export function AgentChat({ agentId }: { agentId: string }) {
  return (
    <AgentStreamConsumer
      endpoint={`/api/agents/${agentId}/stream`}
      onEvent={(evt) => { /* render */ }}
    />
  );
}
```

### Gap surfaced by this example

**There is no `useWebSocket` hook exported from `./client`.** The
subpath exports only the **type contract** `UseWebSocketReturn`
(in `client/types.ts`) — consumers must supply a hook that satisfies
that shape (`connectionState`, `sessionToken`, `clientId`,
`currentChannel`, `switchChannel`, `sendMessage`, `disconnect`,
`reconnect`). The original `useWebSocket` lives in gateway frontend
(`frontend/src/hooks/useWebSocket.ts`) and has not yet been lifted.
**TODO (Wave 3):** extract `useWebSocket` into `./client` so apps
don't have to reimplement transport, reconnect, and session handling.

---

## 5. Bring-your-own storage adapters

Every store the server module needs is defined as a TypeScript
interface in `src/server/stores/`. To target a different backend,
implement the interface — that's the entire contract.

### Reference: `MemorySnapshotStore`

```ts
import type {
  SnapshotStore,
  VersionMeta,
} from '@connorhoehn/realtime-modules/server';

export class SqliteSnapshotStore implements SnapshotStore {
  constructor(private db: import('better-sqlite3').Database) {}

  async putSnapshot(
    channelId: string,
    gzippedBytes: Buffer,
    meta: { timestamp: number; versionName?: string }
  ): Promise<void> {
    this.db.prepare(
      `INSERT INTO snapshots (channel_id, ts, name, bytes)
       VALUES (?, ?, ?, ?)`
    ).run(channelId, meta.timestamp, meta.versionName ?? null, gzippedBytes);
  }

  async getLatestSnapshot(channelId: string) {
    const row = this.db.prepare(
      `SELECT ts, name, bytes FROM snapshots
        WHERE channel_id = ? ORDER BY ts DESC LIMIT 1`
    ).get(channelId);
    return row
      ? { bytes: row.bytes, timestamp: row.ts, versionName: row.name ?? undefined }
      : null;
  }

  async listVersions(channelId: string, limit: number): Promise<VersionMeta[]> {
    const rows = this.db.prepare(
      `SELECT ts, name, length(bytes) AS size FROM snapshots
        WHERE channel_id = ? ORDER BY ts DESC LIMIT ?`
    ).all(channelId, limit);
    return rows.map((r: any) => ({
      channelId, timestamp: r.ts, versionName: r.name ?? undefined, size: r.size,
    }));
  }

  async getVersion(channelId: string, timestamp: number): Promise<Buffer | null> {
    const row = this.db.prepare(
      `SELECT bytes FROM snapshots WHERE channel_id = ? AND ts = ?`
    ).get(channelId, timestamp);
    return row ? row.bytes : null;
  }
}
```

Then plug it into `CRDTService`:

```ts
const crdt = new CRDTService({
  messageRouter,
  snapshotStore: new SqliteSnapshotStore(db),
  metadataStore: new SqliteMetadataStore(db),
  hotCache: null,           // hot cache is optional
  logger,
});
```

`MetadataStore` and `HotCache` follow the same pattern.
`MemoryMetadataStore` and `MemoryHotCache` (in
`src/server/stores/MemoryStore.ts`) are working references — they're
what the test suite uses and what zero-config consumers get out of the
box.

**Contract notes that matter** (from `SnapshotStore.ts`):

- Snapshot bytes are **gzipped at the contract boundary**. The store
  must round-trip them byte-for-byte; the caller does the gzip /
  gunzip itself.
- `timestamp` is a millisecond-epoch sort key that doubles as the
  version id surfaced in restore APIs.
- `VersionMeta.size` may be `0` for legacy rows that predate the field.

---

## 6. The `FeatureManifest` pattern

Every feature ships (or will ship) a `FeatureManifest`. Today only
`AgentStreamingManifest` is exported (`./agent-streaming`), but the
contract is the same for chat, presence, document-sharing, etc.

```ts
export interface FeatureManifest {
  name: string;                // 'chat' | 'presence' | 'document-sharing' | ...
  version: string;             // independent of the package semver
  envVars?: Record<string, {
    required?: boolean;
    default?: string;
    description: string;
  }>;
  channels?: string[];         // WS channel patterns this feature uses
  declarations?: string;       // module path to EventDeclaration[] export
  dependencies?: string[];     // other feature names required first
  install?: {
    backendRoutes?: string;    // module path to (app) => void route mounter
    frontendImport?: string;   // suggested frontend import path
  };
}
```

### Why apps care

- **Validation.** Platform tooling can fail-fast on missing env vars
  by reading `manifest.envVars`.
- **Channel registration.** Gateway / edge-gateway can pre-declare
  WS channel patterns from `manifest.channels` so a feature that
  doesn't broadcast on a registered channel is caught at boot.
- **Event-catalog wiring.** The `declarations` path points at a list
  the event-catalog publisher / consumer can register.
- **Future `npx realtime-modules add chat` CLI.** *(Not yet
  implemented — Wave 3+ work.)* The CLI will read `install.backendRoutes`
  and `install.frontendImport` to scaffold the consumer's wiring.

For now, host applications can read manifests in code (`import {
AgentStreamingManifest } from '@connorhoehn/realtime-modules/agent-streaming'`)
to assert env-var presence at boot and to feed manifest metadata into
their own telemetry.

---

## 7. What's NOT included

Treat realtime-modules as a **toolkit**, not a framework. It explicitly
does **not** ship:

- **Express routes.** The server module exports service classes
  (`CRDTService`, etc.) but no `mountCrdtRoutes(app)` helper. Apps
  wire their own router. The only Express-aware export today is
  `agentStreamMiddleware` (a single `RequestHandler` factory).
- **WebSocket transport.** Consumers bring their own WS server +
  connection manager + auth. The package only specifies the
  `MessageRouterContract` shape it talks to.
- **A `useWebSocket` hook on the client.** Only the
  `UseWebSocketReturn` *contract type* is exported (see §4 gap).
- **Auth / authz.** `CRDTService` accepts an optional `authz` callback;
  default is permissive pass-through. Real authn lives in the host.
- **AWS-SDK / Redis client wiring.** Storage adapters own their
  client lifecycle; the package depends only on the abstract store
  interfaces.
- **A CLI installer.** `npx realtime-modules add <feature>` is a
  future deliverable, currently aspirational.

---

## 8. Operational notes

### Peer-dependency handling

All peer deps are marked `optional` in `peerDependenciesMeta`.
Consequences for consumers:

- Install **only** the peers your chosen subpaths use. Pure
  `./server` consumers can skip `react` and the `@tiptap/*` family.
- npm will not warn about missing optional peers, so a missing peer
  shows up as an `ERR_MODULE_NOT_FOUND` at import time. If you see
  `Cannot find module 'y-protocols'`, you forgot a peer install.
- Lockfile drift across consumers is your responsibility — pin
  exact peer versions when reproducibility matters.

### Version pinning across consumers

Once realtime-modules extracts to its own GitHub repo:

- Pin consumers to **tags**, e.g. `github:connorhoehn/realtime-modules#v0.3.0`.
- Treat `main` HEAD the way the platform treats `distributed-core` —
  freely usable when you control both ends of the upgrade, never
  trusted as a long-term pin.
- When extracting, run the typecheck across each consumer
  (`npm run typecheck`) before publishing a new tag — the package's
  subpath exports are not API-stable yet and breakages will surface
  as TS errors, not runtime crashes.
- Plan for at least one drift hazard: storage-contract shapes
  (`SnapshotStore`, `MetadataStore`) are load-bearing. Bump the
  package's minor version on any breaking change to those interfaces
  and call it out in the release notes so consumer adapter
  implementations get updated in lockstep.

### Logging + metrics

`CRDTService` accepts `logger` (required) and `metricsCollector`
(optional). Logger is structural — anything with `info`, `warn`,
`error`, `debug` works (`pino` and `console` both satisfy). The metrics
collector contract is intentionally narrow (`recordError(code)`); pass
your own thin adapter.

### Config overrides

Tuning knobs (snapshot intervals, eviction windows, operation batch
window) live in `src/server/config.ts` and are exported under the
`config` namespace:

```ts
import { config } from '@connorhoehn/realtime-modules/server';
console.log(config.SNAPSHOT_INTERVAL_MS);
```

These are module-level constants today; runtime override hooks are a
Wave 2+ addition.

---

## Status snapshot

- **Package version:** `0.0.0` (skeleton stage — see `package.json`).
- **Stable subpaths:** `./`, `./server`, `./client`, `./adapters/tiptap`, `./agent-streaming`.
- **In-flight subpaths:** `./presence`, `./chat`, `./reactions` (Wave 2).
- **Reference consumer:** `websocket-gateway` (the host repo).
- **Known gaps:** `useWebSocket` hook not lifted (Wave 3); no Express
  route mounters; no CLI installer; manifests only exported for
  `agent-streaming` so far.
