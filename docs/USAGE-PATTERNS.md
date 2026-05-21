# Usage Patterns — `@connorhoehn/realtime-modules`

Concrete per-subpath examples. For higher-level concerns (installation,
peer deps, manifest pattern, what's NOT included, version-pinning), see
`./ADOPTION-GUIDE.md`.

Each section: **What you get** → **Backend wire-up** → **Frontend hook**
(where applicable) → **Storage adapter sketch** (where pluggable) →
**Manifest**. All code uses real type signatures from the source.

---

## `./server` — CRDT collaborative documents

Y.js-based collaborative-document orchestrator lifted from
gateway's `src/realtime-fanout/crdt/`.

### What you get

From `realtime-modules/src/server/index.ts`:

- `CRDTService` — orchestrator. Dispatches via
  `handleAction(clientId, action, data)` to per-channel hydration,
  subscribe, update, awareness, snapshot, and disconnect handlers.
- `SnapshotManager` — gzip-on-write + Redis-cache + DDB-persist path.
- `DocumentMetadataService` — doc CRUD wrapper around `MetadataStore`.
- `DocumentPresenceService` — who's-in-this-doc tracking (distinct from
  the standalone `./presence` subpath).
- `AwarenessCoalescer` — debounces awareness fan-out so 60fps cursor
  moves don't blow up the WS layer.
- `IdleEvictionManager` — flushes Y.Docs out of memory after the idle
  window.
- Store contracts: `SnapshotStore`, `MetadataStore`, `HotCache`,
  `MessageRouterContract`, plus orchestrator-widened
  `OrchestratorMessageRouter`.
- Default in-memory stores: `MemorySnapshotStore`, `MemoryMetadataStore`,
  `MemoryHotCache`.
- `config` namespace — `SNAPSHOT_INTERVAL_MS`,
  `OPERATION_BATCH_WINDOW_MS`, eviction windows.
- `crdtManifest`.

### Backend wire-up

```ts
import {
  CRDTService,
  MemorySnapshotStore,
  MemoryMetadataStore,
  MemoryHotCache,
  type CRDTServiceOpts,
  type OrchestratorMessageRouter,
} from '@connorhoehn/realtime-modules/server';

const messageRouter: OrchestratorMessageRouter = createMyRouter();

const crdt = new CRDTService({
  messageRouter,
  snapshotStore: new MemorySnapshotStore(),
  metadataStore: new MemoryMetadataStore(),
  hotCache: new MemoryHotCache(),         // optional; null disables it
  logger: console,
  authz: (clientId, channel, svc) => isAllowed(clientId, channel),
} satisfies CRDTServiceOpts);

await crdt.handleAction(clientId, action, data);
```

`OrchestratorMessageRouter` extends the narrow `MessageRouterContract`
with optional `subscribeToChannel` / `unsubscribeFromChannel` /
`sendToClient`. If your router exposes those, CRDT uses them for
per-client subscribe management.

### Bring-your-own storage — SQLite snapshots

```ts
import type {
  SnapshotStore,
  VersionMeta,
} from '@connorhoehn/realtime-modules/server';
import type Database from 'better-sqlite3';

export class SqliteSnapshotStore implements SnapshotStore {
  constructor(private db: Database.Database) {}

  async putSnapshot(
    channelId: string,
    gzippedBytes: Buffer,
    meta: { timestamp: number; versionName?: string },
  ): Promise<void> {
    this.db.prepare(
      `INSERT INTO snapshots (channel_id, ts, name, bytes) VALUES (?, ?, ?, ?)`,
    ).run(channelId, meta.timestamp, meta.versionName ?? null, gzippedBytes);
  }

  async getLatestSnapshot(channelId: string) {
    const row = this.db.prepare(
      `SELECT ts, name, bytes FROM snapshots
        WHERE channel_id = ? ORDER BY ts DESC LIMIT 1`,
    ).get(channelId) as { ts: number; name: string | null; bytes: Buffer } | undefined;
    return row
      ? { bytes: row.bytes, timestamp: row.ts, versionName: row.name ?? undefined }
      : null;
  }

  async listVersions(channelId: string, limit: number): Promise<VersionMeta[]> {
    const rows = this.db.prepare(
      `SELECT ts, name, length(bytes) AS size FROM snapshots
        WHERE channel_id = ? ORDER BY ts DESC LIMIT ?`,
    ).all(channelId, limit) as Array<{ ts: number; name: string | null; size: number }>;
    return rows.map((r) => ({
      channelId, timestamp: r.ts, versionName: r.name ?? undefined, size: r.size,
    }));
  }

  async getVersion(channelId: string, timestamp: number): Promise<Buffer | null> {
    const row = this.db.prepare(
      `SELECT bytes FROM snapshots WHERE channel_id = ? AND ts = ?`,
    ).get(channelId, timestamp) as { bytes: Buffer } | undefined;
    return row?.bytes ?? null;
  }
}
```

Contract reminder: bytes are **gzipped at the boundary** — SnapshotManager
hands you compressed buffers, your store round-trips them byte-for-byte.
`MetadataStore` and `HotCache` follow the same implement-the-interface
pattern; references at `src/server/stores/MemoryStore.ts`.

### Manifest

```ts
import { crdtManifest } from '@connorhoehn/realtime-modules/server';
```

---

## `./client` — CRDT client + transport

React surface for the gateway WS protocol. Editor-agnostic — no Tiptap
or ProseMirror imports.

### What you get

From `realtime-modules/src/client/index.ts`:

- `GatewayProvider` — Y.js `Observable` bridging the gateway's
  `crdt:update` / `crdt:snapshot` / `crdt:awareness` protocol. Owns
  the local-edit forwarder + awareness debounce (50 ms).
- `useYjsDoc(opts)` — lifecycle hook: `Y.Doc` + `GatewayProvider` +
  subscribe / unsubscribe / `crdt:doc-replaced` rebuild.
- `useCRDT(opts)` — single-Y.Text content hook for `SharedTextEditor`.
- `useAwarenessState(provider, initial)` — single source of truth for
  awareness writes (merge-not-overwrite).
- `useIdleDetector({ timeoutMs })`.
- `useWebSocket(opts)` — transport hook. Reconnect, session handshake,
  auto-resubscribe.
- `SharedTextEditor` — `contentEditable` rich-text surface.
- Contract types: `ConnectionState`, `GatewayError`, `GatewayMessage`,
  `UseWebSocketReturn`.

### Frontend hook usage

```tsx
import {
  useWebSocket,
  useYjsDoc,
  useAwarenessState,
  SharedTextEditor,
  type GatewayMessage,
} from '@connorhoehn/realtime-modules/client';

const listeners = new Set<(m: GatewayMessage) => void>();

export function CollabDoc({ documentId, authToken }: {
  documentId: string;
  authToken: string;
}) {
  const ws = useWebSocket({
    url: 'wss://gateway.example.com/ws',
    authToken,
    onMessage: (msg) => listeners.forEach((fn) => fn(msg)),
  });

  // useYjsDoc wants a multi-subscriber bus; wrap useWebSocket's
  // single-callback option in a tiny shim.
  const onMessage = useCallback((handler: (m: GatewayMessage) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  }, []);

  const { ydoc, provider, synced } = useYjsDoc({ documentId, ws, onMessage });

  useAwarenessState(provider, {
    userId: 'me',
    displayName: 'Connor',
    color: '#ff6b6b',
    mode: 'edit',
    currentSectionId: null,
  });

  if (!synced || !ydoc || !provider) return <div>Loading...</div>;
  return <YourEditor ydoc={ydoc} provider={provider} />;
}
```

Text-only variant: drop `useYjsDoc` and use
`useCRDT({ sendMessage, onMessage, currentChannel, connectionState })`
directly, then render `<SharedTextEditor content={content}
applyLocalEdit={applyLocalEdit} hasConflict={hasConflict}
onDismissConflict={dismissConflict} />`.

**Caveat:** `useWebSocket` exposes a one-shot `onMessage` option but no
multi-subscriber bus. The shim above is the pattern until that gap
closes.

### Manifest

None — this is client-only surface. Manifests live with server modules.

---

## `./adapters/tiptap` — Tiptap editor

Tiptap-coupled subpath. Isolated so Monaco / CodeMirror / contentEditable
consumers never see `@tiptap/*` or ProseMirror in their bundle.

### What you get

From `realtime-modules/src/adapters/tiptap/index.ts`:

- `TiptapEditor` — editor bound to a Y.js `XmlFragment` with custom
  React cursor overlay (bypasses the broken `CollaborationCursor`
  extension).
- `EditorToolbar`.
- Types: `TiptapEditorProps`, `CollaborationProvider` (`{ awareness:
  Awareness }`).

### Frontend usage

```tsx
import { TiptapEditor, type CollaborationProvider }
  from '@connorhoehn/realtime-modules/adapters/tiptap';
import { useYjsDoc, useAwarenessState }
  from '@connorhoehn/realtime-modules/client';

export function RichDoc({ documentId, ws }: { documentId: string; ws: any }) {
  const { ydoc, provider } = useYjsDoc({ documentId, ws, onMessage });
  const { updateCursorInfo } = useAwarenessState(provider, {
    userId: 'me', displayName: 'Connor', color: '#06b6d4',
    mode: 'edit', currentSectionId: null,
  });

  if (!ydoc || !provider) return null;
  const fragment = ydoc.getXmlFragment('prosemirror');

  return (
    <TiptapEditor
      fragment={fragment}
      ydoc={ydoc}
      provider={provider as CollaborationProvider}  // structural match
      user={{ name: 'Connor', color: '#06b6d4' }}
      placeholder="Start writing..."
      onUpdateCursorInfo={updateCursorInfo}
    />
  );
}
```

Peer deps: `react`, `yjs`, `y-protocols`, plus the full `@tiptap/*` set
(`react`, `starter-kit`, `extension-collaboration`,
`extension-task-list`, `extension-task-item`, `extension-placeholder`,
`y-tiptap`).

### Manifest

None — covered by `crdtManifest` from `./server`.

---

## `./agent-streaming` — AG-UI v0.1.x server emitter

Server-side SSE emitter for the AG-UI agent-event protocol. Pairs with
`@connorhoehnslalom/ui-components/agents` on the client.

### What you get

From `realtime-modules/src/agent-streaming/index.ts`:

- `AgentStreamImpl` — class with one method per AG-UI event
  (`runStarted`, `runFinished`, `textMessageChunk`, `toolCallChunk`,
  `stateSnapshot`, `stateDelta`, `reasoning*`, etc.).
- `createAgentStream(res, opts)` — bind to an Express `Response`. SSE
  headers + initial ping + heartbeat.
- `agentStreamMiddleware(handler, opts)` — Express `RequestHandler`
  factory. Runs the handler with an `AbortSignal`; maps throws to
  `runError`; auto-emits `runFinished` if the handler doesn't.
- `validateJsonPatch(patch)` — JSON-Patch validator used by `stateDelta`.
- Full AG-UI event type set (see `agent-streaming/types.ts`).
- `agentStreamingManifest` (also re-exported as
  `AgentStreamingManifest`).

### Backend wire-up — middleware

```ts
import {
  agentStreamMiddleware,
  type AgentStreamHandler,
} from '@connorhoehn/realtime-modules/agent-streaming';

const handler: AgentStreamHandler = async (req, stream, signal) => {
  const runner = await getAgentRunner(req.params.agentId);
  for await (const evt of runner.stream(req.body, { signal })) {
    if (signal.aborted) break;
    if (evt.type === 'text') {
      stream.textMessageChunk({
        messageId: evt.messageId, role: 'assistant', delta: evt.text,
      });
    } else if (evt.type === 'tool') {
      stream.toolCallChunk({
        toolCallId: evt.toolCallId,
        toolCallName: evt.toolName,
        delta: JSON.stringify(evt.args),
      });
    }
  }
};

app.post('/api/agents/:agentId/stream', agentStreamMiddleware(handler, {
  heartbeatMs: 25_000,
  onHandlerError: (err) => metrics.recordError(err),
}));
```

For manual control (run-id / thread-id derivation outside the request),
use `createAgentStream(res, opts)` directly and call
`stream.runStarted()` / `stream.runFinished()` / `stream.close()`
yourself.

### Frontend

Not in this package. Use `@connorhoehnslalom/ui-components/agents`:

```tsx
import { AgentStreamConsumer } from '@connorhoehnslalom/ui-components/agents';
<AgentStreamConsumer endpoint={`/api/agents/${id}/stream`} onEvent={render} />;
```

### Manifest

```ts
import { agentStreamingManifest }
  from '@connorhoehn/realtime-modules/agent-streaming';
```

---

## `./presence` — in-process presence tracking

Per-client status + per-channel presence broadcast. Lifted from gateway
in Wave 2.

### What you get

From `realtime-modules/src/presence/index.ts`:

- `PresenceService` — `set` / `get` / `subscribe` / `unsubscribe` /
  `heartbeat` actions. Owns heartbeat sweep, stale-client cleanup,
  disconnect grace window.
- Types: `PresenceConfig`, `PresenceEntry`,
  `PresenceStatus` (`'online' | 'away' | 'busy' | 'offline'`),
  `PresenceUpdate`, `PresenceMessageRouter`, `PresenceLogger`.
- `PresenceManifest`.

Not lifted (stays in gateway): DC `EntityRegistry` dual-write,
ownership-cleanup-coordinator integration, Redis pub/sub adapter.

### Backend wire-up

```ts
import { PresenceService, type PresenceMessageRouter }
  from '@connorhoehn/realtime-modules/presence';

const router: PresenceMessageRouter = {
  sendToClient: (id, msg) => wsConns.get(id)?.send(JSON.stringify(msg)),
  sendToChannel: (channel, msg, exclude) => fanout(channel, msg, exclude),
  subscribeToChannel: (id, ch) => subscribe(id, ch),
  unsubscribeFromChannel: (id, ch) => unsubscribe(id, ch),
  nodeId: process.env.NODE_ID ?? 'local',
};

const presence = new PresenceService(router, logger, {
  heartbeatIntervalMs: 30_000,
  presenceTimeoutMs: 60_000,
  staleThresholdMs: 90_000,
  disconnectDelayMs: 5_000,
  maxMetadataKeys: 20,
  maxMetadataSize: 4096,
  authorizeChannel: (clientId, channel) => isAllowed(clientId, channel),
});

await presence.handleAction(clientId, action, data);
```

**API quirk:** the constructor is positional `(messageRouter, logger,
config?)`, matching gateway's original. The other Wave 2 services use
the newer `opts` bag convention; presence is the odd one out.

### Storage

In-process only. Horizontal scale comes from the router's cross-node
fan-out, not from a shared store.

### Manifest

```ts
import { PresenceManifest } from '@connorhoehn/realtime-modules/presence';
```

---

## `./chat` — channel chat with persistence

Per-channel chat fan-out with pluggable history store. Lifted from
gateway's `chat-service.ts` in Wave 2 / Cut 2.

### What you get

From `realtime-modules/src/chat/index.ts`:

- `ChatService` — `handleAction` dispatches join / leave / send /
  history / typing. LRU per channel in front of the store.
- `InMemoryChatStore` — default fallback.
- `SubscriptionTracker` — utility reused by sibling services.
- Types: `ChatServiceOpts`, `ChatMessageRouter`, `ChatLogger`,
  `ChatStore`, `ChatMessage`, `ChatHistoryQuery`.
- `ChatManifest`.

### Backend wire-up

```ts
import {
  ChatService,
  InMemoryChatStore,
  type ChatServiceOpts,
} from '@connorhoehn/realtime-modules/chat';

const chat = new ChatService({
  messageRouter,
  logger,
  chatStore: new InMemoryChatStore(),      // default if omitted
  authz: (clientId, channel) => isAllowed(clientId, channel),
  maxMessageLength: 4_000,
  maxMessagesPerChannel: 500,
  defaultHistoryLimit: 50,
} satisfies ChatServiceOpts);

await chat.handleAction(clientId, action, data);
```

### Bring-your-own storage — DynamoDB

```ts
import type { ChatStore, ChatMessage }
  from '@connorhoehn/realtime-modules/chat';

export class DdbChatStore implements ChatStore {
  constructor(private ddb: DynamoDBDocumentClient, private table: string) {}

  async putMessage(message: ChatMessage): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: {
        channelId: message.channel,
        messageId: message.id,
        clientId: message.clientId,
        message: message.message,
        timestamp: message.timestamp,
        metadata: message.metadata ? JSON.stringify(message.metadata) : null,
        ttl: Math.floor(Date.now() / 1000) + 90 * 86_400,    // 90d
      },
    }));
  }

  async listMessages(channel: string, limit: number): Promise<ChatMessage[]> {
    const res = await this.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'channelId = :c',
      ExpressionAttributeValues: { ':c': channel },
      Limit: limit,
      ScanIndexForward: false,                              // newest first
    }));
    // ChatService expects chronological — reverse the DDB result.
    return (res.Items ?? []).reverse().map((it) => ({
      id: it.messageId,
      channel: it.channelId,
      clientId: it.clientId,
      message: it.message,
      timestamp: it.timestamp,
      metadata: it.metadata ? JSON.parse(it.metadata) : undefined,
    }));
  }
}
```

### Manifest

```ts
import { ChatManifest } from '@connorhoehn/realtime-modules/chat';
```

---

## `./reactions` — emoji-reaction fan-out

In-memory emoji-reaction broadcast with per-channel history ring buffer.
Pure ephemeral.

### What you get

From `realtime-modules/src/reactions/index.ts`:

- `ReactionService` — `handleAction` for `subscribe` / `unsubscribe` /
  `send` / `getAvailable`.
- `DEFAULT_AVAILABLE_REACTIONS` — frozen 12-emoji catalog with paired
  effect tokens (heart, laugh, thumbs-up, party, fire, ...).
- `DEFAULT_ERROR_CODE` = `'SERVICE_INTERNAL_ERROR'`.
- Types: `Reaction`, `AvailableReaction`, `ReactionConfig`,
  `ReactionMessageRouter`, `ReactionLogger`,
  `ReactionMetricsCollector`, `ReactionServiceOptions`,
  `ReactionErrorFrame`.
- `ReactionsManifest`.

### Backend wire-up

```ts
import {
  ReactionService,
  DEFAULT_AVAILABLE_REACTIONS,
  type ReactionServiceOptions,
} from '@connorhoehn/realtime-modules/reactions';

const reactions = new ReactionService({
  messageRouter,                          // null for local-only mode
  logger,
  metricsCollector: { recordError: (code) => metrics.inc(code) },
  config: {
    maxHistorySize: 50,
    maxChannelNameLength: 50,
    // Override REPLACES; spread to preserve defaults.
    availableReactions: {
      ...DEFAULT_AVAILABLE_REACTIONS,
      '\u{1F344}': { name: 'mushroom', effect: 'wiggle-purple' },
    },
    authorizeChannel: (clientId, channel) => isAllowed(clientId, channel),
  },
} satisfies ReactionServiceOptions);

await reactions.handleAction(clientId, 'send', {
  channel: 'room:42',
  emoji: '\u{1F525}',
  position: { x: 0.4, y: 0.7 },
  metadata: { displayName: 'Connor' },
});

// Hook ownership-cleanup-coordinator from your room layer:
coordinator.onLost('room:42', () => reactions.cleanupRoom('room:42'));
```

### Storage

None — pure in-memory ring buffer per channel. Buffer lifecycle is
bound to `cleanupRoom(roomId)`, wired from your own room-eviction
signal.

### Manifest

```ts
import { ReactionsManifest } from '@connorhoehn/realtime-modules/reactions';
```

---

## `./typed-documents` — typed-document WS subscriptions

WS subscribe / unsubscribe surface for typed document events
(comments, reviews, items, workflows). **Subscription management only**
— persistence + CRUD stay in the host service.

### What you get

From `realtime-modules/src/typed-documents/index.ts`:

- `DocumentEventsService` — `handleAction('subscribe' | 'unsubscribe')`
  manages subscriptions to `doc-comments:{documentId}` and
  `doc:{documentId}` channels.
- Types: `DocumentSubscriptionFrame`, `DocumentErrorFrame`,
  `DocumentEventsConfig`, `DocumentEventsMessageRouter`,
  `DocumentEventsLogger`, `DocumentEventsMetricsCollector`,
  `DocumentEventsServiceOptions`.
- `TypedDocumentsManifest`.

Publishing is the consumer's job — social-api / platform-api push
events directly to those channels.

### Backend wire-up

```ts
import {
  DocumentEventsService,
  type DocumentEventsServiceOptions,
} from '@connorhoehn/realtime-modules/typed-documents';

const docEvents = new DocumentEventsService({
  messageRouter,                          // null disables I/O
  logger,
  config: { maxDocumentIdLength: 100 },
} satisfies DocumentEventsServiceOptions);

await docEvents.handleAction(clientId, action, data);
await docEvents.handleDisconnect(clientId);   // sweep subscriptions
```

### Storage

None at this layer.

### Manifest

```ts
import { TypedDocumentsManifest }
  from '@connorhoehn/realtime-modules/typed-documents';
```

---

## `./ingest` — ingest event fan-out

WS-side subscription fan-out for the platform-api ingest engine. The
actual events arrive via consumer-owned bridge / relay code.

### What you get

From `realtime-modules/src/ingest/index.ts`:

- `IngestService` — `handleAction('subscribe' | 'unsubscribe')` plus
  `emitEvent(channel, event)` for the bridge to call.
- Types: `IngestConfig`, `IngestEvent`, `IngestEventChannel`
  (`'ingest:progress' | \`ingest:source:${string}\``), `IngestFrame`,
  `IngestLogger`, `IngestMessageRouter`, `IngestMetricsCollector`,
  `IngestServiceOptions`.
- `IngestManifest`.
- Static back-compat: `IngestService.VALID_CHANNELS` and
  `IngestService.MAX_CHANNEL_LENGTH`.

### Backend wire-up

```ts
import {
  IngestService,
  type IngestEvent,
  type IngestServiceOptions,
} from '@connorhoehn/realtime-modules/ingest';

const ingest = new IngestService({
  messageRouter,                          // null for local mode
  logger,
  config: { maxChannelLength: 100 },
} satisfies IngestServiceOptions);

await ingest.handleAction(clientId, 'subscribe', {
  channel: 'ingest:source:gh-abc123',
});

bus.on('item.materialized', async (event: IngestEvent) => {
  await ingest.emitEvent(`ingest:source:${event.sourceId}`, event);
});
```

### Storage

None — per-instance subscription map.

### Manifest

```ts
import { IngestManifest } from '@connorhoehn/realtime-modules/ingest';
```

---

## `./activity` — activity feed + history

Activity-feed broadcast with pluggable history store.
`activity:broadcast` plus per-channel subscriptions.

### What you get

From `realtime-modules/src/activity/index.ts`:

- `ActivityService` — `handleAction('subscribe' | 'unsubscribe' |
  'publish' | 'getHistory')`. Static
  `ActivityService.BROADCAST_CHANNEL = 'activity:broadcast'`.
- `InMemoryActivityHistoryStore` — default fallback. Newest-first ring
  buffer per channel (matches Redis LPUSH + LTRIM semantics).
- Types: `ActivityServiceOpts`, `ActivityMessageRouter`,
  `ActivityLogger`, `ActivityHistoryStore`, `ActivityEvent`,
  `ActivityEventConfig`.
- `ActivityManifest`.

Not lifted: EventCatalog `setEventCatalog` setter + the durable
`activity.recorded` publish-with-retry path; Redis-backed history store
(lives in gateway).

### Backend wire-up

```ts
import {
  ActivityService,
  InMemoryActivityHistoryStore,
  type ActivityServiceOpts,
} from '@connorhoehn/realtime-modules/activity';

const activity = new ActivityService({
  messageRouter,                          // null → local-only fallback
  logger,
  historyStore: new InMemoryActivityHistoryStore(200),
  config: { maxHistoryItems: 200, maxChannelIdLength: 100 },
} satisfies ActivityServiceOpts);

await activity.handleAction(clientId, action, data);
```

### Bring-your-own storage — Redis history

```ts
import type {
  ActivityHistoryStore,
  ActivityEvent,
} from '@connorhoehn/realtime-modules/activity';
import type { RedisClientType } from 'redis';

export class RedisActivityHistoryStore implements ActivityHistoryStore {
  constructor(private redis: RedisClientType, private maxItems = 200) {}

  async append(channelId: string, event: ActivityEvent): Promise<void> {
    const key = `activity:history:${channelId}`;
    try {
      await this.redis.multi()
        .lPush(key, JSON.stringify(event))
        .lTrim(key, 0, this.maxItems - 1)
        .expire(key, 7 * 86_400)                          // 7-day TTL
        .exec();
    } catch (err) {
      // Best-effort — log only, never throw into the WS handler.
      logger.warn('activity append failed', err);
    }
  }

  async list(channelId: string, limit: number): Promise<ActivityEvent[]> {
    try {
      const rows = await this.redis.lRange(
        `activity:history:${channelId}`, 0, Math.max(0, limit) - 1,
      );
      return rows.map((r) => JSON.parse(r) as ActivityEvent);
    } catch {
      return [];
    }
  }
}
```

### Manifest

```ts
import { ActivityManifest } from '@connorhoehn/realtime-modules/activity';
```

---

## `./server-ws` — server-side WS handler factory

Thin wrapper around `ws.Server` that wires the package's service classes
onto an `http.Server` upgrade event. Lazy-requires `ws`.

### What you get

From `realtime-modules/src/server-ws/index.ts`:

- `createWsHandler(opts) → WsHandlerHandle`.
- Types: `WsService` (structural — anything with `handleAction(clientId,
  action, data)` satisfies it), `WsAuthFn`, `WsAuthContext`,
  `WsHandlerOptions`, `WsHandlerHandle`, `WsHttpServer`.

Wire protocol — inbound `{ service, action, ...data }` →
`services[service].handleAction(clientId, action, data)`. Session
handshake on connect: `{ type: 'session', status: 'connected',
clientId, timestamp }`.

### Backend wire-up

```ts
import { createServer } from 'http';
import { createWsHandler } from '@connorhoehn/realtime-modules/server-ws';
import { ChatService } from '@connorhoehn/realtime-modules/chat';
import { PresenceService } from '@connorhoehn/realtime-modules/presence';

const http = createServer(/* express app */);
const chat = new ChatService({ messageRouter, logger });
const presence = new PresenceService(messageRouter, logger);

const handle = createWsHandler({
  server: http,
  services: { chat, presence },
  auth: async (req) => {
    const userId = await verify(extractToken(req));
    if (!userId) throw new Error('unauthorized');         // → 401
    return { userId };
  },
  pingIntervalMs: 30_000,
  path: '/ws',
  onConnect: (clientId, ctx) => logger.info({ clientId, ctx }, 'ws connect'),
  onDisconnect: (clientId) => logger.info({ clientId }, 'ws close'),
});

http.listen(3000);

handle.sendToClient(clientId, { type: 'notice', text: 'maintenance soon' });
await handle.dispose();                                   // graceful shutdown
```

Peer dep: `ws` (consumer-installed).

### Manifest

None — transport binding, not a domain feature.

### Cross-reference

Frontend counterpart: `./client`'s `useWebSocket`. The handshake frame
(`type: 'session'`) and inbound frame shape (`{ service, action, ... }`)
are matched on both ends.

---

## Where the package leaves you on your own

(See `./ADOPTION-GUIDE.md` §7 for the full rationale.)

- **HTTP routes for CRDT operations** — `./server` ships service
  classes only. `agentStreamMiddleware` is the only Express-aware
  export anywhere in the package.
- **Cross-node fan-out transport** — every `*MessageRouter` interface
  is a contract; consumers supply the Redis pub/sub or DC peer-transport
  implementation.
- **Authn** — `auth` runs at the upgrade in `createWsHandler`. The
  `authz` callbacks on `CRDTService` / `ChatService` / `PresenceService` /
  `ReactionService` are per-channel; defaults are permissive.
- **DDB / Redis client lifecycle** — adapters own their clients.
  Reference gateway adapters at
  `websocket-gateway/src/realtime-fanout/crdt/adapters/`.
- **`useWebSocket` fan-out subscriber** — only a one-shot `onMessage`
  option ships; wire your own listener registry on top (see `./client`).
