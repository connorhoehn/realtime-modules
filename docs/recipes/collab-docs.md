# Recipe: Collaborative documents (CRDT)

> Plug `collab-docs` into an app you already have. Three steps + a graduation path.

Yjs document sync with snapshots, awareness, presence and idle eviction. The one capability not yet packaged as an attach feature — wire CRDTService from `./server` alongside attachRealtime (they share the router); see the swarm-server pattern in websocket-gateway/scripts/ws-swarm-server.js.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [/* CRDT: see below — wired via ./server, not a built-in yet */],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// useCRDT / useYjsDoc, and adapters/tiptap for a drop-in editor
```

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **TiptapEditor via @connorhoehn/realtime-modules/adapters/tiptap**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
new CRDTService({ snapshotStore, hotCache, metadataStore, … })  // in-memory versions ship in ./server's inMemoryAdapters()
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
