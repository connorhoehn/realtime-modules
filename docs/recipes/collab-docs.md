# Recipe: Collaborative documents (CRDT)

> Plug `collab-docs` into an app you already have. Three steps + a graduation path.

Yjs document sync with snapshots, versions, awareness, presence and idle
eviction. As of v0.20.0 this is a first-class attach feature — no manual
CRDTService wiring. Wire frames address `service: "crdt"` (`subscribe`,
`update`, `awareness`, `getSnapshot`, `saveVersion`, `restoreSnapshot`, …).

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, collabDocs } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [collabDocs()],
    auth: async (req) => ({ userId: await verifyToken(req) }),   // presence names/colors
});
httpServer.listen(3000);
```

`realtime.dispose()` shuts the document stack down cleanly (snapshot flush
included) before detaching the WS listener.

## 2 — Client (React hook)

```tsx
import { useGateway, useCRDT } from '@connorhoehn/realtime-modules/client';

function SharedNote({ channel }: { channel: string }) {
  const gateway = useGateway();

  // useCRDT takes an options object, NOT a channel string.
  const { content, applyLocalEdit, hasConflict, dismissConflict } = useCRDT({
    sendMessage: gateway.send,
    onMessage: gateway.onMessage,
    currentChannel: channel,
    connectionState: gateway.connectionState,
  });

  return (
    <>
      {hasConflict && <button onClick={dismissConflict}>dismiss conflict</button>}
      <textarea value={content} onChange={(e) => applyLocalEdit(e.target.value)} />
    </>
  );
}
```

That is the single-Y.Text surface. For a rich-text document use `useYjsDoc`
plus the editor adapter below, which binds the Y.Doc directly.

## 3 — UI (ui-components)

Use **TiptapEditor via `@connorhoehn/realtime-modules/adapters/tiptap`** —
it bootstraps the Y.Doc + provider stack internally. Per the frontend
discipline: if a needed editor composite is missing, add it to
ui-components first.

## Graduate to production

Zero-config uses the in-memory store trio (single process, non-durable):

```ts
collabDocs({
    snapshotStore: myDurableSnapshotStore,   // SnapshotStore — the gateway's DdbSnapshotStore is the reference
    metadataStore: myMetadataStore,          // MetadataStore — DdbMetadataStore pattern
    hotCache: myRedisHotCache,               // HotCache | null — RedisHotCache pattern
    authz: (clientId, channel, svc) => canAccess(clientId, channel),
})
```

Multi-node? Swap the transport, not the feature: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })`.
