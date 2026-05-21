# Feature Manifest Adoption Guide — `@connorhoehn/realtime-modules`

A developer should be able to follow this guide in under 30 minutes. Read
`docs/ADOPTION-GUIDE.md` for the full installation walkthrough; this guide
focuses specifically on the `FeatureManifest` pattern and how apps wire
features end-to-end.

---

## 1. What is a Feature Manifest?

Every feature module in this package (chat, presence, cursors, etc.) ships
a `FeatureManifest` — a plain object that declares **which env vars the
feature reads**, **which WebSocket channel patterns it touches**, and
**optional install hooks** (backend route path, frontend import path). Host
applications read these manifests at boot-time to build the platform's
channel and event contract without coupling to each feature's internals.

The manifest does not wire the feature for you; it is **documentation you can
execute** — validate env, enumerate channels to monitor, and print an
ops-ready summary — while remaining decoupled from implementation.

---

## 2. Available Features

| Feature | Subpath | Manifest export | WS channels | What it gives you |
|---|---|---|---|---|
| Chat | `./chat` | `ChatManifest` | `chat:*` | Message send/receive, history, typing indicators |
| Presence | `./presence` | `PresenceManifest` | `presence:*` | User join/leave, online/away/busy/offline status |
| Cursor | `./cursor` | `CursorManifest` | `cursor:*` | Real-time cursor position sharing with TTL sweep |
| Reactions | `./reactions` | `ReactionsManifest` | `reactions:*` | Emoji reactions with per-channel LRU history |
| Activity | `./activity` | `ActivityManifest` | `activity:*` | Activity-feed fan-out + history store contract |
| Social | `./social` | `SocialManifest` | `social:*` | Social-event WS subscription surface |
| Call | `./call` | `CallManifest` | _(none — user-to-user routing)_ | Hangout/call invite signaling |
| Ingest | `./ingest` | `IngestManifest` | `ingest:progress`, `ingest:source:*` | Ingest-progress subscription fan-out |
| Pipeline WS | `./pipeline` | `PipelineWsManifest` | `pipeline:run:*`, `pipeline:all`, `pipeline:approvals` | Pipeline event subscription + frame projection |
| Typed Documents | `./typed-documents` | `TypedDocumentsManifest` | `doc-comments:*`, `doc:*` | Subscribe/unsubscribe surface for doc events |
| CRDT (document-sharing) | `./server` | `crdtManifest` | `crdt:*`, `doc:*`, `activity:broadcast` | Collaborative CRDT document orchestrator |
| Agent Streaming | `./agent-streaming` | `agentStreamingManifest` | _(none — HTTP/SSE only)_ | AG-UI v0.1.x server-sent events emitter |

### FeatureManifest type

```ts
// src/feature-manifest/types.ts
export interface FeatureManifest {
  /** Stable feature identifier, e.g. 'chat', 'presence'. */
  name: string;

  /** Semver of the feature itself (independent of package version). */
  version: string;

  /** Env vars the feature reads. Used for validation + docs generation. */
  envVars?: Record<string, {
    required?: boolean;
    default?: string;
    description: string;
  }>;

  /** WS channel patterns the feature subscribes to or publishes on. */
  channels?: string[];

  /** Module path to an EventDeclaration[] export (event-catalog format). */
  declarations?: string;

  /** Other feature names this one requires to be installed first. */
  dependencies?: string[];

  /** Optional install hooks the host application can call. */
  install?: {
    backendRoutes?: string;
    frontendImport?: string;
  };
}
```

---

## 3. Server-side wiring (Express + WebSocket)

The `./server-ws` subpath exports `createWsHandler` — a thin factory that
attaches to a Node `http.Server`, runs an optional auth callback, and routes
inbound frames (`{ service, action, ...data }`) to the named service's
`handleAction(clientId, action, data)` method.

Every fan-out service class (`ChatService`, `PresenceService`,
`ReactionsService`, `CursorService`) satisfies the `WsService` interface
structurally — you plug them in by name.

```ts
import http from 'http';
import express from 'express';
import { createWsHandler } from '@connorhoehn/realtime-modules/server-ws';
import { ChatService, InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import { PresenceService } from '@connorhoehn/realtime-modules/presence';

// 1. Your message router — must implement sendToClient + sendToChannel etc.
//    In the gateway this is a full Redis-backed router; for a new app,
//    start with the minimal interface below and upgrade later.
const router = {
  nodeId: 'node-1',
  sendToClient(clientId: string, msg: unknown) { /* send to WS client */ },
  sendToChannel(channel: string, msg: unknown, exclude?: string) { /* fan-out */ },
  subscribeToChannel(clientId: string, channel: string) { /* track sub */ },
  unsubscribeFromChannel(clientId: string, channel: string) { /* remove sub */ },
};

const logger = {
  debug: console.debug.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

// 2. Instantiate the services you want.
const chatService = new ChatService({
  store: new InMemoryChatStore(),
  router,
  logger,
});

const presenceService = new PresenceService(router, logger);

// 3. Wire them into the WS handler.
const app = express();
const server = http.createServer(app);

const wsHandle = createWsHandler({
  server,
  services: {
    chat:     chatService,
    presence: presenceService,
    // add more services here — key = the `service` field in inbound frames
  },
  auth: async (req) => {
    // Extract userId from token in header / cookie / query string.
    // Throw to reject the upgrade with 401.
    return { userId: req.headers['x-user-id'] as string };
  },
  onConnect:    (clientId, ctx) => console.log('connected', clientId, ctx),
  onDisconnect: (clientId)      => console.log('disconnected', clientId),
});

server.listen(3000);

// Graceful shutdown:
// await wsHandle.dispose();
```

### Reading manifests at boot

Read manifests to validate env and log the channel contract your server owns:

```ts
import { ChatManifest }     from '@connorhoehn/realtime-modules/chat';
import { PresenceManifest } from '@connorhoehn/realtime-modules/presence';
import { CursorManifest }   from '@connorhoehn/realtime-modules/cursor';

const FEATURES = [ChatManifest, PresenceManifest, CursorManifest];

for (const m of FEATURES) {
  console.log(`[${m.name}@${m.version}] channels: ${m.channels?.join(', ')}`);

  for (const [key, def] of Object.entries(m.envVars ?? {})) {
    const val = process.env[key] ?? def.default ?? '(unset)';
    if (def.required && !process.env[key]) {
      throw new Error(`Missing required env var ${key} for feature ${m.name}`);
    }
    console.log(`  ${key}=${val} — ${def.description}`);
  }
}
```

---

## 4. Client-side (React)

Use `./client/ws` when you only need the WebSocket hook (no CRDT / Yjs
dependency). Use `./client` when you also need `GatewayProvider` for
collaborative editing — it pulls in `yjs` and `y-protocols`.

```tsx
// React component — chat room example
import { useWebSocket } from '@connorhoehn/realtime-modules/client/ws';
import type { GatewayMessage } from '@connorhoehn/realtime-modules/client/ws';

function ChatRoom({ roomId, authToken }: { roomId: string; authToken: string }) {
  const { connectionState, send, subscribe, unsubscribe, lastError } =
    useWebSocket({
      url: 'wss://gateway.example/ws',
      authToken,
      defaultChannel: `chat:${roomId}`,
      autoResubscribe: true,
      onMessage: (msg: GatewayMessage) => {
        if (msg.type === 'chat' && msg.action === 'message') {
          console.log('new message', msg);
        }
      },
    });

  // Subscribe to the room channel once connected.
  // autoResubscribe: true means the hook re-issues this on reconnect.
  const channel = `chat:${roomId}`;

  const sendMessage = (text: string) => {
    send({ service: 'chat', action: 'send', channel, content: text });
  };

  const joinPresence = () => {
    send({
      service: 'presence',
      action: 'set',
      status: 'online',
      channels: [channel],
    });
    subscribe(channel);
  };

  return (
    <div>
      <p>Status: {connectionState}</p>
      {lastError && <p>Error: {lastError.message}</p>}
      <button onClick={joinPresence}>Join</button>
      <button onClick={() => sendMessage('hello')}>Send hello</button>
    </div>
  );
}
```

### Hook return shape

`useWebSocket` returns:

| Field | Type | Description |
|---|---|---|
| `connectionState` | `'idle' \| 'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected'` | Current socket state |
| `sessionToken` | `string \| null` | Token from gateway session handshake |
| `clientId` | `string \| null` | Client ID assigned by gateway |
| `lastError` | `GatewayError \| null` | Most recent error frame |
| `send(frame)` | `(msg: Record<string, unknown>) => void` | Send any JSON frame |
| `subscribe(channel)` | `(channel: string) => void` | Subscribe + track for auto-resubscribe |
| `unsubscribe(channel)` | `(channel: string) => void` | Unsubscribe + stop tracking |
| `publish(channel, frame)` | `(channel, frame) => void` | Merge channel into frame and send |
| `disconnect()` | `() => void` | Intentional disconnect (clears persisted session) |
| `reconnect()` | `() => void` | Force reconnect, reset backoff |

### CRDT collaborative editing

For collaborative documents, use `GatewayProvider` from `./client`:

```tsx
import { GatewayProvider } from '@connorhoehn/realtime-modules/client';
import { useWebSocket }    from '@connorhoehn/realtime-modules/client/ws';
import * as Y from 'yjs';

function CollabEditor({ docId, authToken }: { docId: string; authToken: string }) {
  const ydoc = new Y.Doc();
  const { send } = useWebSocket({ url: 'wss://gateway.example/ws', authToken });

  const provider = new GatewayProvider(ydoc, `doc:${docId}`, send);
  // wire provider into your editor (Tiptap, CodeMirror, etc.)
}
```

---

## 5. Using GatewayProxyClient (non-gateway server)

Lambda functions and other backend services that do not speak WebSocket can
call gateway REST APIs via `./proxy-client`. These routes are gated by
`SERVICE_AUTH_SECRET` HMAC — the caller must supply the correct HMAC
signature header (`x-service-auth-signature`) before the gateway will accept
requests. See the gateway's `requireServiceAuthRawHttp` middleware for the
expected format.

```ts
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

const client = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  authToken: process.env.GATEWAY_SERVICE_TOKEN,  // Bearer token (optional)
  timeout: 5_000,
});

// Publish a message to all subscribers of a channel.
const { delivered } = await client.publishToChannel('chat:room-123', {
  type: 'chat',
  action: 'message',
  content: 'Hello from Lambda!',
});

// Query who is online in a presence channel.
const { users } = await client.getPresence('presence:room-123');

// Fetch chat history (latest 50 messages).
const messages = await client.getChatHistory('chat:room-123', { limit: 50 });

// Fetch activity history for a channel.
const events = await client.getActivityHistory('activity:room-123', { limit: 20 });

// Health check.
const health = await client.getHealth();
```

### Available gateway REST routes

| Method | Path | Proxy method | Auth required |
|---|---|---|---|
| `GET`  | `/health` | `getHealth()` | none |
| `GET`  | `/cluster` | `getClusterInfo()` | none |
| `GET`  | `/stats` | `getStats()` | none |
| `GET`  | `/metrics` | `getMetrics()` | none |
| `POST` | `/hooks/pipeline/:path` | `triggerPipelineWebhook()` | optional HMAC |
| `POST` | `/api/channels/:id/messages` | `publishToChannel()` | service-auth HMAC |
| `GET`  | `/api/presence/:channel` | `getPresence()` | service-auth HMAC |
| `GET`  | `/api/chat/:channel/history` | `getChatHistory()` | service-auth HMAC |
| `GET`  | `/api/activity/:channel/history` | `getActivityHistory()` | service-auth HMAC |

---

## 6. Adding a new feature module

Follow this checklist to add a new feature (example: `notifications`):

### Step 1 — Create the directory and core files

```
src/notifications/
  types.ts         # Public interfaces: NotificationEntry, NotificationConfig, etc.
  NotificationService.ts  # Service class implementing WsService
  manifest.ts      # FeatureManifest declaration
  index.ts         # Barrel export
```

### Step 2 — Define the manifest

```ts
// src/notifications/manifest.ts
import type { FeatureManifest } from '../feature-manifest/types';

export const NotificationsManifest: FeatureManifest = {
  name: 'notifications',
  version: '0.1.0',
  channels: ['notifications:*'],
  envVars: {
    NOTIFICATION_MAX_HISTORY: {
      required: false,
      default: '100',
      description: 'Max notifications retained per user in the LRU history.',
    },
  },
  dependencies: [],
};
```

### Step 3 — Implement the service class

The service must implement the `WsService` interface — `handleAction` is the
only required method; `onClientConnect` and `onClientDisconnect` are optional
lifecycle hooks:

```ts
// src/notifications/NotificationService.ts
import type { WsService } from '../server-ws/types';

export class NotificationService implements WsService {
  async handleAction(
    clientId: string,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    switch (action) {
      case 'subscribe':   await this.handleSubscribe(clientId, data);   break;
      case 'unsubscribe': await this.handleUnsubscribe(clientId, data); break;
      default:
        // Unknown action — surface an error frame back to the client.
    }
  }

  async onClientConnect(clientId: string): Promise<void> {
    // Optional: initialize client state.
  }

  async onClientDisconnect(clientId: string): Promise<void> {
    // Optional: clean up subscriptions and timers.
  }

  private async handleSubscribe(clientId: string, data: Record<string, unknown>) {
    // Implementation.
  }

  private async handleUnsubscribe(clientId: string, data: Record<string, unknown>) {
    // Implementation.
  }
}
```

### Step 4 — Write the barrel export

```ts
// src/notifications/index.ts
export { NotificationService } from './NotificationService';
export { NotificationsManifest } from './manifest';
export type { NotificationEntry, NotificationConfig } from './types';
```

### Step 5 — Register the subpath export in package.json

Add an entry to `exports` in `package.json`:

```json
"./notifications": {
  "types": "./dist/notifications/index.d.ts",
  "default": "./dist/notifications/index.js"
}
```

### Step 6 — Wire the service into the gateway (or host app)

```ts
import { NotificationService }  from '@connorhoehn/realtime-modules/notifications';
import { NotificationsManifest } from '@connorhoehn/realtime-modules/notifications';

const notificationService = new NotificationService(/* deps */);

// Add to createWsHandler services map:
const wsHandle = createWsHandler({
  server,
  services: {
    chat:          chatService,
    presence:      presenceService,
    notifications: notificationService,  // <-- new
  },
  auth,
});

// Read the manifest for env-var validation at boot:
console.log('Notifications channels:', NotificationsManifest.channels);
```

### Step 7 — Write tests

Add tests alongside the service. For a quick sanity check:

```ts
import { NotificationService } from '@connorhoehn/realtime-modules/notifications';

describe('NotificationService', () => {
  it('handles subscribe action', async () => {
    const svc = new NotificationService(/* mock deps */);
    await expect(
      svc.handleAction('client-1', 'subscribe', { channel: 'notifications:user-1' })
    ).resolves.not.toThrow();
  });
});
```

---

## 7. Environment variables

These are the env vars currently declared across all feature manifests. All
are optional with the shown defaults unless marked required.

### Presence (`./presence`)

| Var | Default | Description |
|---|---|---|
| `PRESENCE_HEARTBEAT_INTERVAL_MS` | `30000` | How often the stale-presence sweep runs (ms) |
| `PRESENCE_TIMEOUT_MS` | `60000` | Inactivity threshold before auto-offline (ms) |
| `PRESENCE_STALE_THRESHOLD_MS` | `90000` | Idle-client eviction TTL (ms) |
| `PRESENCE_CLEANUP_INTERVAL_MS` | `30000` | How often the stale-client sweep runs (ms) |
| `PRESENCE_DISCONNECT_DELAY_MS` | `5000` | Grace period after disconnect before purge (ms) |
| `PRESENCE_MAX_METADATA_KEYS` | `20` | Max key count on presence.metadata |
| `PRESENCE_MAX_METADATA_SIZE` | `4096` | Max serialized size of presence.metadata (bytes) |

### Chat (`./chat`)

| Var | Default | Description |
|---|---|---|
| `DYNAMODB_CHAT_TABLE` | `chat-messages` | DDB table for persisted messages (gateway adapter reads this) |

### Cursor (`./cursor`)

| Var | Default | Description |
|---|---|---|
| `CURSOR_THROTTLE_INTERVAL_MS` | `250` | Min interval between accepted cursor updates per client (ms) |
| `CURSOR_TTL_MS` | `30000` | Cursor TTL — older cursors are evicted and broadcast as removed (ms) |
| `CURSOR_CLEANUP_INTERVAL_MS` | `10000` | How often the stale-cursor sweep runs (ms) |

### Reactions (`./reactions`)

| Var | Default | Description |
|---|---|---|
| `REACTION_MAX_HISTORY` | `50` | Max reactions retained per channel in the LRU history |
| `REACTION_MAX_CHANNEL_NAME_LENGTH` | `50` | Hard cap on channel name length |
| `REACTION_AVAILABLE_OVERRIDE` | _(unset)_ | JSON object replacing the built-in 12-emoji catalog |

### Activity (`./activity`)

| Var | Default | Description |
|---|---|---|
| `REDIS_URL` | _(unset)_ | Backing store for the Redis activity-history adapter |
| `EVENT_CATALOG_URL` | _(unset)_ | Durable-publish target for `activity.recorded` events |

### Social (`./social`)

| Var | Default | Description |
|---|---|---|
| `SOCIAL_MAX_CHANNEL_ID_LENGTH` | `100` | Hard cap on channelId length |

### Ingest (`./ingest`)

| Var | Default | Description |
|---|---|---|
| `INGEST_MAX_CHANNEL_LENGTH` | `100` | Hard cap on channel name length |

### Pipeline WS (`./pipeline`)

| Var | Default | Description |
|---|---|---|
| `PIPELINE_MAX_CHANNEL_LENGTH` | `100` | Hard cap on channel name length |

### Typed Documents (`./typed-documents`)

| Var | Default | Description |
|---|---|---|
| `DOCUMENT_EVENTS_MAX_DOCUMENT_ID_LENGTH` | `100` | Hard cap on documentId length |

### CRDT / document-sharing (`./server`)

| Var | Default | Description |
|---|---|---|
| `DYNAMODB_CRDT_TABLE` | `crdt-snapshots` | DDB table for CRDT snapshots |
| `DYNAMODB_DOCUMENTS_TABLE` | `crdt-documents` | DDB table for document metadata |
| `DDB_TABLE_PREFIX` | _(unset)_ | Optional prefix applied to DDB table names |
| `SNAPSHOT_DEBOUNCE_MS` | `5000` | Debounce window before writing a snapshot after last update (ms) |
| `SNAPSHOT_INTERVAL_MS` | `300000` | Interval for periodic snapshot sweeps (ms) |
| `IDLE_EVICTION_MS` | `600000` | Grace period before evicting an idle Y.Doc from memory (ms) |
| `EVENT_BUS_NAME` | `social-events` | EventBridge bus name (informational, for EventBridge adapter) |

### Agent Streaming (`./agent-streaming`)

| Var | Default | Description |
|---|---|---|
| `AGENT_STREAM_HEARTBEAT_MS` | `25000` | SSE heartbeat interval (ms). Lower to keep aggressive proxies alive |

---

## See also

- [docs/ADOPTION-GUIDE.md](./ADOPTION-GUIDE.md) — full installation walkthrough and subpath guide
- [docs/USAGE-PATTERNS.md](./USAGE-PATTERNS.md) — common wiring patterns
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps
- `src/feature-manifest/types.ts` — `FeatureManifest` type definition
- `src/server-ws/types.ts` — `WsService`, `WsHandlerOptions`, `WsHandlerHandle` types
