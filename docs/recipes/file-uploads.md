# Recipe: File uploads

> Plug `file-uploads` into an app you already have. Three steps + a graduation path.

WS-negotiated uploads scoped to a channel (request → PUT bytes over HTTP → complete → broadcast). The WS side is this feature; the HTTP byte route is yours to mount.

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, fileUploads } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [fileUploads()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // optional but recommended
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
// useFileUpload
```

Point the client at the same origin (`/realtime` by default). All hooks share
one WebSocket via the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedFileUploadDrop / FileUploadDrop**. Per the frontend discipline: never hand-roll the surface —
if a composite is missing, add it to ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
fileUploads({ metadataStore, blobStore, authz })  // DDB-style metadata store + your blob backend + your channel authz — the gateway's FileUploadMetadataRepository is the reference; ALSO mount HTTP PUT/GET routes for the bytes (see the gateway's upload-routes.ts)
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
