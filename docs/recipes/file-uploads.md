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
    auth: async (req) => {
        const claims = await verifyToken(req);
        return { userId: claims.sub, exp: claims.exp };   // exp: the token's expiry, in seconds
    },
    // Required since 0.147.0: judges every channel read (`subscribe`) and write (`publish`).
    authorize: ({ kind, channel, ctx }) => !!ctx && canUseChannel(ctx, channel, kind),
    // Browser upgrades from any other Origin are refused with 403.
    allowedOrigins: ['https://app.example.com'],
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

## 2 — Client (React hook)

```tsx
import { useFileUpload, useAttachmentSrc } from '@connorhoehn/realtime-modules/client';

function Dropzone({ channel }: { channel: string }) {
  // `uploads` is yours; `transfers` is everyone’s, so a peer’s progress shows too.
  const { uploads, transfers, upload, cancel } = useFileUpload(channel);

  return (
    <input
      type="file"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void upload(file);
      }}
    />
  );
}
```

Bytes ride a plain HTTP PUT to a presigned URL, not the socket. Rendering an
attachment needs `useAttachmentSrc` — the download route wants a bearer header
and an `<img>` cannot send one.

Since 0.146.0 a chat message names its attachments by the id the upload was
issued (`fileupload:complete`'s `transferId`); the server writes each
`metadata.attachments[].url` from that id, and a send whose attachment carries
any other URL is refused with `CHAT_BAD_ATTACHMENT`. `useAttachmentSrc` sends
the bearer header only to a bare `/api/uploads/<id>` path or to that path on
the page's origin; a gateway on another origin must be listed in
`trustedOrigins`, or its images are fetched without the token (and 401).

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **WrappedFileUploadDrop / FileUploadDrop**.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
fileUploads({ metadataStore, blobStore, authz })  // DDB-style metadata store + your blob backend + your channel authz — the gateway's FileUploadMetadataRepository is the reference; ALSO mount HTTP PUT/GET routes for the bytes (see the gateway's upload-routes.ts)
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.
