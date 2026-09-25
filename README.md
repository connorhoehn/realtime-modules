# @connorhoehn/realtime-modules

Full-stack realtime collaboration library — the "webstack" layer apps
build on. Server-side services (`ChatService`, `PresenceService`,
`CRDTService`, `ReactionService`, `ActivityService`, …) plus React
hooks for chat, presence, reactions, activity, file upload, video
hangouts, and notifications; an AG-UI / SSE agent-streaming surface; a
Tiptap collaborative editor adapter; and a typed REST proxy client for
Lambda / server-to-server callers.

**Status.** Powers `websocket-gateway` (server + frontend), OrgIQ
middleware/portal (aws-agentcore), and live-video-streaming's UI.
Pre-1.0 (`0.x`) — subpath shapes may shift between minors; pin to an
exact published version (GitHub Packages) or git SHA.

## Recipes

**[docs/recipes/](./docs/recipes/README.md)** — one page per capability:
attach on the server (3 lines), one client hook, one ui-components surface,
and the graduation path from in-memory defaults to production stores. The
composition layer is `attachRealtime` + `defineFeature` from `./server`;
features compose à la carte (every one works alone and in any pair —
enforced by the attach test matrix).

## What to use where

| You are building… | Use |
|---|---|
| A server that terminates WebSockets and runs realtime features | `./server-ws` (WS handler factory) + the service subpaths: `./chat`, `./presence`, `./activity`, `./cursor`, `./reactions`, `./social`, `./call`, `./ingest`, `./pipeline`, `./typed-documents`, `./server` (CRDT/doc stack), `./room`, `./notification`, `./fileupload` |
| A React app on top of a gateway deployment | `./client` hooks (+ `@connorhoehn/ui-components` for the UI layer, which wraps these hooks) |
| Video hangouts (WHIP/WHEP against an SFU) | `./client/video`, `./client/hangout-rooms` |
| Agent / LLM streaming UX | `./agent-streaming` (server), `./agent-streaming/client` |
| Lambda / server-to-server calls into a gateway | `./proxy-client` |
| Durable persistence behind the services | Implement the store interfaces (`ChatStore`, `MetadataStore`, `SnapshotStore`, `HotCache`) in YOUR app — in-memory defaults ship here; DynamoDB/Redis adapters live with the app that owns those tables (see websocket-gateway's `realtime-fanout/*/adapters`) |

Layering: `ui-components → realtime-modules → (service-runtime,
event-catalog)`. Apps (websocket-gateway, live-video-streaming,
aws-agentcore) sit on top and contribute deployment glue + persistence
adapters, not service logic.

**History note (v0.6.0–v0.16.x).** v0.6.0 declared this package
"client-only" and deleted the server-side sources, intending to move
them in-tree to websocket-gateway. The move never completed: the
compiled output stayed here, the gateway kept importing the subpaths,
and for ten minor versions the server surface shipped WITHOUT source.
v0.17.0 restored the sources from history (with the three fixes that
had been patched into `dist/` directly: chat publisher authz, presence
mode plumbing, presence color derivation) and made the build
self-cleaning so `dist/` can never outlive `src/` again. The server
modules are a supported, first-class surface.

---

## Quick Start

```tsx
import {
  GatewaySocketProvider,
  useChat,
  usePresence,
  useCRDT,
} from '@connorhoehn/realtime-modules/client';

function MyApp() {
  return (
    <GatewaySocketProvider
      url="wss://gateway.example.com/ws"
      token={getAuthToken()}
      features={['chat', 'presence', 'crdt']}
    >
      <ChatRoom channel="chat:general" />
    </GatewaySocketProvider>
  );
}

function ChatRoom({ channel }: { channel: string }) {
  const { messages, sendMessage } = useChat(channel);
  const { roster } = usePresence(channel);

  return (
    <>
      <header>{roster.length} online</header>
      <ul>{messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => sendMessage('hi')}>send</button>
    </>
  );
}
```

The provider owns the single WebSocket connection. Child hooks read
context via `useGateway()` and never re-establish their own socket.

**Composite pattern — `useChannel` (v0.7.8):**

```tsx
import { useChannel } from '@connorhoehn/realtime-modules/client';

function Room({ channel }: { channel: string }) {
  // All four features enabled by default; each value is T | null.
  const { chat, presence, reactions, activity } = useChannel(channel);

  return (
    <>
      <header>{presence?.roster.length ?? 0} online</header>
      <ul>{chat?.messages.map((m) => <li key={m.id}>{m.message}</li>)}</ul>
      <button onClick={() => chat?.sendMessage('hi')}>send</button>
      <button onClick={() => reactions?.react('\u{1F525}')}>fire</button>
    </>
  );
}

// Opt-out individual features:
const { chat } = useChannel(channel, {
  features: { presence: false, reactions: false, activity: false },
});
```

Granular hooks (`useChat`, `usePresence`, etc.) are still valid for
deeply-nested components that only need one feature.

---

## Install

The package is published to **GitHub Packages** under the
`@connorhoehn` scope. Add the registry to your `.npmrc`:

```
@connorhoehn:registry=https://npm.pkg.github.com
```

then pin the current version:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "0.16.0"
  }
}
```

Server-to-server / SHA-pinned consumers (e.g. the gateway) may also
pin via a git SHA — `github:connorhoehn/realtime-modules#<sha>` — when
they need a commit ahead of the latest published version.

The repo ships a pre-built `dist/` so consumers do not need to run the
TypeScript build themselves.

For local development against a sibling checkout:

```json
{
  "dependencies": {
    "@connorhoehn/realtime-modules": "file:../realtime-modules"
  }
}
```

Run `npm run build` inside the clone once after pulling to refresh
`dist/`; `file:` consumers pick up changes on the next `npm install`.

Peer-deps (`react`, `express`, `ws`, `yjs`, `y-protocols`, `@tiptap/*`)
are all **optional** — install only what the subpaths you import
require.

### TypeScript requirements

```json
{
  "compilerOptions": {
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  }
}
```

- **`skipLibCheck: true`** — required to suppress transitive type
  conflicts from `yjs` and `lru-cache` under TypeScript 5.x/6.x.
- **`moduleResolution: "bundler"` (or `"node16"`/`"nodenext"`)** —
  required for subpath imports like `./client/ws` to resolve. Classic
  `"node"` mode does not support package `exports` subpath maps.

---

## Subpaths

Every subpath in `package.json` `exports` appears here — `verify-exports`
fails the build if one does not, because a published surface nobody can find
is the same as an unpublished one.

**Browser**

| Subpath | Purpose | Use when |
|---|---|---|
| `.` | Root re-export of `./client` + `./agent-streaming` + `./server-ws` | Single-import ergonomics over tree-shaking |
| `./client` | React hooks + `GatewaySocketProvider` | Browser apps with full feature set |
| `./client/ws` | Yjs-free `useWebSocket`-only surface | Browser apps without CRDT |
| `./client/video` | Camera/mic capture + publishing primitives | Surfaces that publish video |
| `./client/media-effects` | Blur, virtual backgrounds, face sprites — lazy MediaPipe engine | Camera surfaces wanting effects |
| `./client/voice` | Ambient push-to-talk capture + `ContextFrame` (where an utterance attaches) | Dictation / spoken remarks outside a call |
| `./client/hangout-rooms` | Hangout room hooks + the REST functions behind them | Multi-room video apps |
| `./client/pipelines` | `usePipelineRunStatus` — live run status merged from `pipeline:event` frames and a REST snapshot; `usePipelineCatalog` — the pipelines directory (work-type/kind enum, last-run rollups kept current from `pipeline:all`, `statusPillFor`, `generatePipelineDraft`); pure helpers for SSR/scripts | Rendering a pipeline-run card or the pipelines page |
| `./client/documents` | `useDocumentWork` — one document's work fields (status, points, owner, priority, outcome, criteria, links) with optimistic PATCH and 409 rollback; `useWorkList` — the Work column grouped by work status ("Not planned" for none) with the header rollup and live run status; `useRunDraft` — save / dispatch / stop a run draft with a stable request id; `useRunEstimate` — cost and duration range, `null` = "No prior runs"; pure REST helpers for scripts. Live from the gateway's id-only `doc-work:*` signals (re-read the one record; no polling) | The Documents four-pane Work / detail / Run draft view |
| `./agent-streaming/client` | `useAgentStream` React hook — no Yjs dependency | Browser apps consuming agent streams |
| `./adapters/tiptap` | `TiptapEditor` + `EditorToolbar` bound to Yjs | Collaborative rich-text editors |
| `./adapters/excalidraw` | Excalidraw ⇄ Yjs binding, typed structurally (no Excalidraw dependency) | Collaborative diagramming |

**Server**

| Subpath | Purpose | Use when |
|---|---|---|
| `./server-ws` | Generic WS handler factory (`createWsHandler`) | Service-side WS routing / test fixtures |
| `./server` | CRDT/document stack — `CRDTService`, snapshots, awareness, `attachRealtime` | Hosting collaborative documents |
| `./agent-streaming` | AG-UI v0.1.x SSE emitter (`agentStreamMiddleware`) | Backends streaming AI responses |
| `./proxy-client` | `GatewayProxyClient` — typed REST shim with optional HMAC signing | Server-to-server / Lambda |
| `./work-graph` | Dependency-free work-event, sharing, viewer, cursor, reference, and collaboration contracts | Producers, API hosts, gateways, and clients composing the Active now work graph |
| `./work-graph/server` | Shared signed work-graph snapshot/replay cursor issuer and verifier | Platform API and gateway server runtimes |

**Feature services** — each pairs with the hook named in [Hook reference](#hook-reference); wire them into `createWsHandler`'s `services` map.

| Subpath | Purpose | Client half |
|---|---|---|
| `./chat` | `ChatService` — history, membership, read receipts, pins | `useChat` |
| `./presence` | `PresenceService` — roster + status | `usePresence` |
| `./reactions` | `ReactionService` — ephemeral and durable reactions | `useReactions` |
| `./activity` | `ActivityService` — app-wide event log; live events fan out globally, history is per-channel | `useActivity` |
| `./cursor` | `CursorService` — in-memory cursor fan-out with a TTL sweep | `useCursor` |
| `./notification` | `NotificationService` — user-scoped inbox, optional Redis store | `useNotifications` |
| `./fileupload` | `FileUploadService` + `FileBlobStore` (local-fs default) | `useFileUpload` |
| `./call` | `CallService` — invites, call state stores, lobby channel | none yet — frames via `useGateway()` |
| `./room` | `RoomService` — room lifecycle + state store | `./client/hangout-rooms` |
| `./pipeline` | `PipelineWsRouter` — pipeline subscription fan-out + frame projection | `./client/pipelines` |
| `./social` | `SocialService` — social-event fan-out | none yet — frames via `useGateway()` |
| `./ingest` | `IngestService` — ingest subscription fan-out | none yet — frames via `useGateway()` |
| `./typed-documents` | `DocumentEventsService` — comments / reviews / items / workflows | none yet — frames via `useGateway()` |

The root entry (`@connorhoehn/realtime-modules`) re-exports `./client`,
`./agent-streaming`, and `./server-ws` for ergonomic single-import
access. Prefer explicit subpath imports for tree-shaking.

---

## Hook reference

Every hook exported from `./client` has a row here — `verify-exports` fails
the build if one does not. Channel-scoped hooks subscribe and unsubscribe
automatically when the `channel` argument changes.

"Channel-scoped" here means what the hook RECEIVES is scoped to the channel,
not merely that it subscribes with one. `useActivity` is the exception worth
knowing about, and its row says so.

**Connection**

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useGateway()` | `{ send, onMessage, onConnect, onDisconnect, state, … }` | No (provider context) |
| `useGatewayOptional()` | The same context value, or `null` outside a provider — the non-throwing read a provider-optional hook needs | No (provider context) |
| `useFeatures()` | `FeatureName[]` declared by the nearest provider; `[]` outside one | No (provider context) |
| `useWebSocket(opts)` | `{ send, subscribe, unsubscribe, publish }` plus the state of `UseWebSocketReturn` — `connectionState`, `clientId`, `sessionToken`, `switchChannel`, … `subscribe`/`unsubscribe` address the generic multiplexer, which `attachRealtime` always registers. Takes `opts.webSocketImpl` to supply the constructor (Node, React Native, tests) | No |
| `usePipelineRunStatus(runs, opts)` | `(runId) => PipelineRunStatus \| undefined` — phase, step label, detail, suggestion/review, expandable `details`; `pipeline:event` frames merged with the run snapshot (also under `./client/pipelines`) | Per run (`pipeline:run:<id>` + `pipeline:all`) |
| `usePipelineCatalog(opts)` | `{ entries, summaries, groups(by), loading, error, refresh }` — `GET /api/pipelines/defs?include=rollup`, rollups kept current from `pipeline:all` run frames, one refresh per reconnect; `statusPillFor` / `groupByWorkType` / `generatePipelineDraft` beside it (also under `./client/pipelines`) | `pipeline:all` |
| `useDocumentWork(documentId, opts)` | `{ work, tracked, update(edit), pending, conflict, clearConflict, loading, error, refresh }` — `GET/PATCH /api/documents/:id/work`, edits applied optimistically and rolled back on failure; re-reads on `doc:work_updated` and once per reconnect (also under `./client/documents`) | `doc-work:<documentId>` |
| `useWorkList(scope, opts)` | `{ rows, rollup, groups(opts), loading, error, refresh }` — `GET /api/document-work?scope=`, a scope signal moves the row and re-reads that one record; `activeRun` follows `pipeline:all` (also under `./client/documents`) | `doc-work-scope:<scope>` + `pipeline:all` |
| `useRunDraft(documentId, opts)` | `{ draft, phase, draftId, save, dispatch, stop, busy, conflict, loading, error, refresh }` — the draft id is the request id, minted once per draft; concurrent dispatches share one request (also under `./client/documents`) | `doc-work:<documentId>` |
| `useRunEstimate(pipelineId, model, opts)` | `{ estimate, noPriorRuns, loading, error, refresh }` — `GET /api/pipelines/:id/estimate?model=`, cached per page until a run of that pipeline completes (also under `./client/documents`) | `pipeline:all` |

**Channel features**

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useChannel(channel, opts?)` | `{ channel, chat, presence, reactions, activity }` — composite (v0.7.8) | Yes |
| `useChat(channel, opts?)` | `{ messages, sendMessage, loadHistory, typingUsers, setTyping, editMessage, deleteMessage }` | Yes |
| `useChatMembers(channel, opts?)` | `{ members, open, loading, addMembers, removeMember, refresh, isMember, removed }` | Yes |
| `useChatReadReceipts(channel, opts?)` | `{ receipts, enabled, reason, limit, loading, markRead, readersOf, readCountOf, refresh }` | Yes |
| `usePins(channel, opts?)` | `{ pins, pinnedIds, pin, unpin, refresh, isLoading, error }` | Yes |
| `usePresence(channel)` | `{ roster, setStatus, updateMetadata }` | Yes |
| `useReactions(channel, opts?)` | `{ reactions, react, reactionsFor, unreact, toggle }` | Yes |
| `useActivity(channel)` | `{ events, loadHistory, publish }` — `publish(eventType, detail?)` records one; the server stamps identity. **Live events are global, not per-channel** — the server broadcasts every one to a single `activity:broadcast` channel every client is auto-subscribed to, and no frame carries a channel to filter on. `channel` scopes `loadHistory` only | History only |
| `useCursor(channel, opts?)` | `{ cursors, move, refresh }` — live cursors, client-throttled | Yes |
| `useFileUpload(channel)` | `{ uploads, transfers, upload, cancel, cancelTransfer, removeCompleted }` | Yes |
| `useAttachmentSrc(opts?)` | `{ srcFor }` — bearer-authenticated download URL to a renderable object URL | No (per-attachment) |
| `useVideoHangout(channel)` | `{ session, participants, joinToken, start, join, leave, end, toggleVideo, toggleAudio }`. Addresses `service: 'videohangout'` — a live-video-streaming deployment, **not** this package's `calls()` | Yes |

**Documents (CRDT)**

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useCRDT(opts)` | `{ content, applyLocalEdit, hasConflict, dismissConflict }` — single Y.Text. Takes `{ sendMessage, onMessage, currentChannel, connectionState }`, **not** a channel string | Via `opts.currentChannel` |
| `useYjsDoc(opts)` | `{ ydoc, provider, synced, docVersion }` — the Y.Doc + provider bootstrap. Takes `{ documentId, ws, onMessage }`; all three required | Via `opts.documentId` |
| `useAwarenessState(provider, initial)` | `{ updateSection, updateMode, updateIdle, updateCursorInfo }`. `initial` is required and wants every field including `currentSectionId` | No (provider-scoped) |
| `useCanvasDocument(opts)` | `{ isCanvas, schemaVersion, body, exportMarkdown, materialize, importMarkdown }` | No (doc-scoped) |

**Cross-channel / app-level**

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useAgentLoopRun(runId, { apiBaseUrl, idToken, transport?, pollMs? })` | `{ loop, phase, steps, currentStep, stepsDone, stepsTotal, percent?, startedAt, canStop, stopping, stop, canPause: false, pauseUnsupportedReason, loading, notFound, error, refresh }` — platform-api `/api/agent-loops/:runId`, re-read on the run's `pipeline:event` frames. No pause: the platform answers 501 | Via the run (`pipeline:run:<executorRunId>`) |
| `useDeckReviseStatus(documentId, { transport? })` | `{ active, recent, latest, generatingSlideIds, isGenerating, get }` — in-flight `POST /api/deck/revise` edits on one presentation, from `pipeline.deck.revise.*` frames | Via the document (`pipeline:run:deck-revise:<documentId>`) |
| `usePresentationRevisions({ apiBaseUrl, documentId, idToken, focusRevisionId? })` | `{ title, revisions, total, olderCount, loadingOlder, loadOlder, state, error, reload }` — a deck's revisions a page at a time (REST, bearer), one cache per deck shared by every view; a revision written while open is prepended | Via the document (`pipeline:run:deck-revise:<documentId>`, for the prepend) |
| `useNotifications(opts?)` | `{ notifications, unreadCount, markAsRead, markAllRead, remove, clearAll }`. Read-state persists to `opts.storage` (default `localStorage`; `null` for memory only) | No (user-scoped) |
| `useCapability(name, channel?)` | `{ capability, enabled, isLoading, error }` | No (CRD-scoped) |
| `useCapabilities(names, channel?)` | `{ capabilities, enabled, isLoading, error }` — the set form; React forbids the singular hook in a loop | No (CRD-scoped) |
| `useFeatureFlag(name, defaultValue?)` | `{ enabled, isLoading, variant?, metadata? }` | No (flag-scoped) |
| `useAgentStream(opts)` | `{ messages, streamingText, activeToolCalls, sessionId, isStreaming, error, steps, reasoning, sendMessage, reset, loadHistory }` | Per-stream |

**Media / local device**

| Hook | Returns | Channel-scoped? |
|---|---|---|
| `useDictation(opts?)` | `{ supported, state, micActive, permission, pendingContext, lastTranscript, error, start, stop, cancel }` | No (local) |
| `useCanvasCapture(opts?)` | `{ track, stream, capturing, error }` — a canvas the page owns as a `MediaStreamTrack` | No (local) |
| `useIdleDetector(opts?)` | `{ isIdle }` | No (local) |

### Hooks in the media subpaths

These are not exported from `./client` — they live behind their own subpaths
so an app that never publishes video never resolves MediaPipe or the LVS
transport. They speak to a live-video-streaming deployment, not to
`attachRealtime`.

`./client/video` — see [the streaming recipe](./docs/recipes/streaming.md):

| Hook | Returns |
|---|---|
| `useLVSContext()` | `LVSConfig` — the `{ baseUrl, getAuthToken, log }` the provider holds, for a caller that needs it directly |
| `useLVSPublisher(opts)` | the WHIP publish loop — `phase`, ICE and retry owned by the hook, capture owned by you |
| `useLVSSubscriber(opts)` | the WHEP side of the same |
| `useLVSHangout(opts)` / `useLVSHangoutShared()` | `{ participants, isJoined, isScreenSharing, isCameraEnabled, connectionState, error, videoUnavailable, toggleMute, toggleCamera, enableCamera, disableCamera, setCameraEnabled, startScreenShare, stopScreenShare, leave }`. The `Shared` form reads one hangout from context instead of opening its own |
| `useLVSViewerCount(opts)` | `{ viewerCount, error }` — polled |
| `useLVSRecordings(opts)` | `{ recordings, isLoading, error, refetch }` |
| `useLVSHlsPlayer(opts)` | `{ playlistUrl, tokenExpiresInSec, ready }` — the near-realtime lane |
| `useLiveCaptions(opts)` | `CaptionLine[]` |
| `useMediaDevices(opts?)` | `{ microphones, cameras, speakers, permission: { microphone, camera }, speakerSelectionSupported, loading, refresh, requestPermission }` — device lists and browser permission for call surfaces |
| `useAudioVideoSettings(opts?)` | `{ settings, update, constraints, previewStream, previewError, micLevel, testMic, testSound, testMicState }` — per-browser mic/speaker/camera settings under `call-device-preferences` |
| `useDocumentCall(opts)` | `{ call, phase, joined, isHost, elapsedMs, error, ended, participants, inCallCount, activeSpeakerId, self, start, join, leave, endForEveryone, invite, ringAgain, setDocuments, setTitle, present, following, follow, toggleMic, toggleCamera, startScreenShare, stopScreenShare, lvs, inviteLink, refresh }` — a call that belongs to a document review; see [the calls recipe](./docs/recipes/calls.md#document-calls) |
| `useIncomingDocumentCalls(opts)` | `{ current, queue, queueLength, accept, decline, dismiss }` — rings for `kind:'document-review'` invites |

`./client/voice` and `./client/media-effects`:

| Hook | Returns |
|---|---|
| `useVoiceCapture(opts)` | `{ supported, state, micActive, liveText, lastTranscript, pendingContext, error, captureId, channel, start, stop, cancel }` — ambient push-to-talk. `useDictation` in `./client` is the request/response sibling |
| `useMediaEffects(opts?)` | a `MediaEffectsController`: `{ filterId, backgroundMode, backgroundImageUrl, faceSpriteId, active, outputTrack, previewTrack, filters, backgrounds, faceSprites, draft, isDirty, setFilter, setBackgroundMode, setBackgroundImageUrl, setFaceSpriteId, beginPreview, applyPreview, cancelPreview, warmup, attach, processStream, detach }`. The MediaPipe engine is lazy — nothing loads until an effect is switched on |

---

## Transport tiers

**Persistent-WS lane** (`./client`, `./client/ws`, `./server-ws`,
`./adapters/tiptap`): assumes a long-lived WebSocket to a
`websocket-gateway` deployment.

### Connection semantics (v0.15.0 — session-gated connect)

The gateway silently drops inbound frames that arrive before its
per-connection session bootstrap completes; it signals readiness with a
`{ type: 'session', status: 'connected', clientId, sessionToken, … }`
frame. Therefore `useWebSocket` — and everything built on it
(`GatewaySocketProvider`, all feature hooks, the Yjs `GatewayProvider`
path) —:

- keeps `connectionState === 'connecting'` after socket open and flips
  to `'connected'` only when the session frame arrives (EKS finding #9
  — subscribing at `onopen` lost 100% of subscribe frames under real
  network latency; loopback never reproduces it);
- queues `send()` calls made while the socket is open but the session
  is not yet established (bounded at 100 frames, drop-oldest with a
  `console.warn`) and flushes them in order on session arrival;
- applies the same gating on every reconnect — auto-resubscribe and
  connected-gated feature effects wait for the NEW session frame;
- falls back for plain (non-gateway) WS servers that never send a
  session frame: if none arrives within `sessionTimeoutMs` (default
  3000, option on `useWebSocket`) of open, the hook warns, transitions
  to `'connected'` anyway, and flushes the queue — preserving the
  legacy open-means-connected behavior. (`./server-ws`'s
  `createWsHandler` sends the handshake, so the fallback only fires
  against third-party servers.)

**Lambda lane** (`./agent-streaming`, `./agent-streaming/client`,
`./proxy-client`): HTTP / SSE only. `./agent-streaming` works in AWS
Lambda via [aws-lambda-web-adapter] with a Function URL and
`AWS_LWA_INVOKE_MODE=response_stream`. **Do not use API Gateway** —
it buffers responses and breaks SSE streaming.

Lambda apps that need persistent-WS features (chat history, presence,
channel publish) consume them via `GatewayProxyClient` over plain REST.

[aws-lambda-web-adapter]: https://github.com/awslabs/aws-lambda-web-adapter

---

## proxy-client — automatic HMAC signing (v0.7.1+)

The gateway's REST routes require a valid `X-Service-Auth` header.
Provide `serviceAuthSecret` + `serviceAuthClientId` and the client
signs every request automatically:

```ts
import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client';

const client = new GatewayProxyClient({
  gatewayUrl: process.env.GATEWAY_URL!,
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET,
  serviceAuthClientId: 'my-lambda-app',
});

// X-Service-Auth header computed automatically on every call.
await client.publishToChannel('chat:general', { type: 'message', text: 'hello' });
const { users }    = await client.getPresence('chat:general');
const { messages } = await client.getChatHistory('chat:general', { limit: 50 });
```

The wire format (`v1.<id>.<ts>.<mac>`) is identical to
`@connorhoehn/service-runtime`'s `signEnvelope`. The algorithm is
inlined using Node's built-in `crypto` — no extra runtime dep.

---

## Live demo

A runnable showcase covering all six feature hooks is in `demo/`:

```bash
cd demo && npm install && npm run dev   # → http://localhost:5173
```

Set `VITE_GATEWAY_URL=ws://localhost:4000` (and optionally
`VITE_AUTH_TOKEN`) in `demo/.env.local`. See
[`demo/README.md`](./demo/README.md) for full instructions.

| Hook | What the demo shows |
|---|---|
| `useChat` | Message list, compose form, load-history |
| `usePresence` | Roster, status dropdown, metadata editor |
| `useReactions` | Emoji palette with aggregated counts, live stream |
| `useCursor` | Live cursor overlay — position, initials and colour per peer |
| `useActivity` | Typed event feed, load-history |
| `useFileUpload` | Drag-and-drop, XHR progress bars, AV scan states |
| `useVideoHangout` | Start/join/leave, participant list, video/audio toggle, join-token display |

---

## Maturity

| Subpath / hook | Status |
|---|---|
| `./client` — `GatewaySocketProvider`, `useGateway`, `useWebSocket` | Stable (in use by gateway + OrgIQ) |
| `useChat`, `usePresence`, `useReactions`, `useActivity` | Stable (v0.7.0) |
| `useFileUpload` | Stable (v0.16.0 — gateway `FileUploadService` shipped; needs `FILEUPLOAD_TABLE` + `FILEUPLOAD_PUBLIC_BASE` env) |
| `useVideoHangout` | Beta (v0.7.2 — LVS signaling integration deferred) |
| `useNotifications` | Stable (v0.16.0 — gateway `NotificationService` shipped, DDB-backed; uses the gateway's DDB table prefix, no dedicated env) |
| `useCapability` | Stable (v0.16.0 — gateway `CapabilityService` + `GET /api/capabilities` shipped; CRD-scoped, no env) |
| `useFeatureFlag` | Stable (v0.16.0 — gateway feature-flag store + `GET /api/feature-flags/:name` shipped; seed via `FEATURE_FLAGS_JSON` env) |
| `useCRDT`, `useYjsDoc`, `useAwarenessState`, `useIdleDetector` | Stable |
| `useAgentStream` | Stable (v0.2.0) |
| `./proxy-client` | Stable (v0.2.0, HMAC signing v0.7.1) |
| `./agent-streaming` | Stable (v0.1.0) |
| `./agent-streaming/client` | Stable (v0.2.1) |
| `./adapters/tiptap` | Stable |
| `./client/ws` | Stable (v0.4.3) |
| `./server-ws` | Stable |

---

## FeatureManifest

`FeatureManifest` (declared in `src/feature-manifest/types.ts`) is the
shared contract between features and the host. Feature manifests now
live alongside the in-tree implementations in `websocket-gateway`;
this package re-exports the type so app code and host code share a
single declaration.

---

## Versioning + stability

`0.x` is unstable. Pin to an exact published version (e.g. `0.16.0`)
or a git SHA. Subpath shapes and hook signatures can change in any
minor release. `1.0` will mean stable client subpath exports and
stable AG-UI mapping.

---

## Migration from v0.5.x

If you depended on a server-side subpath in v0.5.x or earlier, the
service class you imported now lives in `realtime-examples/src/`. The
canonical fix is to **delete the import and consume the feature
through gateway** — either over WS (using the client hooks) or over
HTTP (using `./proxy-client`).

| Removed (v0.6.0) | Replacement |
| --- | --- |
| `import { ChatService } from '@connorhoehn/realtime-modules/chat'` | `useChat(channel)` over WS, or `proxy.getChatHistory()` over HTTP |
| `import { PresenceService } from '@connorhoehn/realtime-modules/presence'` | `usePresence(channel)` over WS, or `proxy.getPresence()` over HTTP |
| `import { ReactionService } from '@connorhoehn/realtime-modules/reactions'` | `useReactions(channel)` over WS |
| `import { ActivityService } from '@connorhoehn/realtime-modules/activity'` | `useActivity(channel)` over WS, or `proxy.getActivityHistory()` over HTTP |
| `import { CRDTService } from '@connorhoehn/realtime-modules/server'` | `useCRDT(opts)` / `useYjsDoc(opts)` over WS |
| `import { CursorService } from '@connorhoehn/realtime-modules/cursor'` | `useCursor(channel)` over WS (or `useAwarenessState` when a Y.Doc is already mounted) |
| `import { CallService } from '@connorhoehn/realtime-modules/call'` | no hook yet; read `{type:'call'}` frames via `useGateway()`. `useVideoHangout` talks to a live-video-streaming deployment, not to this |
| `import { PipelineWsRouter } from '@connorhoehn/realtime-modules/pipeline'` | `usePipelineRunStatus()` from `./client/pipelines` |
| `import { ... } from '@connorhoehn/realtime-modules/{ingest,social,typed-documents}'` | no hook yet; read the frames via `useGateway()` |

---

## Links

- [docs/ADOPTION-GUIDE.md](./docs/ADOPTION-GUIDE.md) — full adoption walkthrough.
- [docs/USAGE-PATTERNS.md](./docs/USAGE-PATTERNS.md) — common wiring patterns.
- [docs/USEWEBSOCKET-GAP-vs-GATEWAY.md](./docs/USEWEBSOCKET-GAP-vs-GATEWAY.md) — `useWebSocket` vs gateway protocol gaps.
- [CHANGELOG.md](./CHANGELOG.md).
- [LICENSE](./LICENSE) — MIT.
