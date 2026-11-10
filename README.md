# @connorhoehn/realtime-modules

Realtime building blocks for collaborative apps: a WebSocket gateway server with per-channel authorization, services for presence, chat, reactions, activity, notifications, file uploads, collaborative documents, calls and meeting rooms, and the React hooks and adapters that talk to them from the browser.

Every feature works on its own or combined with the others, and each ships with in-memory stores so you can start without any infrastructure. On the server you attach features to an existing Node `http.Server` with `attachRealtime`; in the browser you mount one `GatewaySocketProvider` and use hooks such as `useChat` and `usePresence`.

## What's in the repo

- `src/` - the TypeScript sources, one folder per feature plus `client/`, `server/`, `server-ws/` and `adapters/`.
- `test/` - Jest tests, one folder per area.
- `dist/` - the committed build output, so a git install needs no build step.
- `docs/` - the adoption guide, usage patterns, per-feature recipes and design notes.
- `demo/` - a runnable Vite and React app with its own realtime backend.
- `scripts/` - export verification, a packed-install check and a smoke test of the built package.
- `bench/` - an in-process load script for channel authorization.

## Getting started

### Using the library

The package is published to GitHub Packages under the `@connorhoehn` scope. Point that scope at the registry in your `.npmrc`, then install:

```
@connorhoehn:registry=https://npm.pkg.github.com
```

```bash
npm install @connorhoehn/realtime-modules
```

You can also install from git (`github:connorhoehn/realtime-modules#<tag>`). Pin an exact version or tag, because the API can change between minor releases. Every peer dependency (`react`, `express`, `ws`, `yjs`, `y-protocols`, the Tiptap packages, `pptxgenjs`, the DynamoDB client) is optional: install only what the subpaths you import need. Your `tsconfig.json` needs `skipLibCheck: true` and `moduleResolution` set to `bundler`, `node16` or `nodenext` so subpath imports resolve.

On the server, attach features to your HTTP server. The token is checked in your `auth` function, `authorize` decides who may read or write each channel, and `allowedOrigins` lists the web origins that may open a socket. All three are required: since 0.147.0 the library refuses to start without its authorization hooks, and `auth` must return the token's `exp` (seconds). For local development only, `insecureAllowAll: true` skips them; it is refused when `NODE_ENV=production`.

```ts
import http from 'http';
import { attachRealtime, chat, presence, bearerSubprotocolAuth } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);
attachRealtime(httpServer, {
    features: [chat(), presence()],
    path: '/realtime',
    // verifyToken returns the claims: { userId, exp, … }
    auth: bearerSubprotocolAuth({ verify: async (token) => verifyToken(token) }),
    authorize: ({ channel, ctx }) => !!ctx && channelAllowed(ctx.userId, channel),
    allowedOrigins: ['https://app.example.com'],
});
httpServer.listen(3000);
```

In the browser, give the provider a URL and a token. The token travels in the `Sec-WebSocket-Protocol` header as `bearer-token-v1, <token>`, never in the URL, and the provider owns the one WebSocket that every hook below it shares:

```tsx
import { GatewaySocketProvider, useChat, usePresence } from '@connorhoehn/realtime-modules/client';

function App() {
    return (
        <GatewaySocketProvider url="wss://example.com/realtime" token={token} features={['chat', 'presence']}>
            <Room channel="chat:general" />
        </GatewaySocketProvider>
    );
}

function Room({ channel }: { channel: string }) {
    const { messages, sendMessage } = useChat(channel);
    const { roster } = usePresence(channel);
    return <button onClick={() => sendMessage('hi')}>{roster.length} online, {messages.length} messages</button>;
}
```

### Developing in this repo

```bash
npm install            # install dependencies
npm run build          # clean, compile with tsc, then verify the exports
npm test               # run the Jest suite
npm run typecheck      # type-check without emitting
npm run lint           # type-check the lint configuration
npm run demo           # start the demo app on http://localhost:5173
```

CI: `.github/workflows/ci.yml` runs typecheck and tests on push; it has not run yet (no GitHub access from the machine that wrote it).

`npm run verify:exports`, `npm run check:contract`, `npm run verify:packed` and `npm run smoke:features` run the export, contract, packed-install and built-package checks on their own. `RELEASE.md` describes how a release is cut.

## Subpaths

Every key in the package `exports` map is one entry point. Import from the narrowest one you need. The bare package import is a deprecated barrel that pulls in both React and server code.

| Subpath | What it gives you |
|---|---|
| `.` | Deprecated barrel of `./client`, `./agent-streaming` and `./server-ws`; prefer a subpath |
| `./client` | `GatewaySocketProvider` and the React hooks for chat, presence, reactions, activity, cursors, uploads, notifications and documents |
| `./client/ws` | The WebSocket hook, shared-socket transport and live-refresh helpers, without Yjs |
| `./client/video` | Camera and microphone capture, LVS hangouts (`useLVSHangout`, `useLVSContext`) and the conversation call hooks |
| `./client/voice` | Push-to-talk voice capture (`useVoiceCapture`) |
| `./client/media-effects` | Background blur, virtual backgrounds and face sprites (`useMediaEffects`) |
| `./client/hangout-rooms` | Multi-room hangout hooks and the REST calls behind them |
| `./client/meeting` | `useMeeting`: raised hands and breakout rooms for a live call |
| `./client/pipelines` | Pipeline run status and the pipelines catalog |
| `./client/documents` | Work fields, work lists and run drafts for a document |
| `./adapters/tiptap` | `TiptapEditor` and its toolbar, bound to Yjs |
| `./adapters/excalidraw` | Excalidraw to Yjs binding for collaborative diagrams |
| `./agent-streaming` | Server-side AG-UI event stream over SSE for AI agent responses |
| `./agent-streaming/client` | `useAgentStream`, the browser side of that stream |
| `./proxy-client` | `GatewayProxyClient`, a typed REST client; browser-safe, and it signs with HMAC in Node when given a service secret |
| `./proxy-client/server` | The same client with service-runtime imported statically, for bundled server code that signs requests; Node only |
| `./server-ws` | `createWsHandler`, the generic WebSocket handler factory |
| `./server` | `attachRealtime`, the feature factories, channel authorization and the document stack |
| `./server/stores/dynamo` | DynamoDB-backed chat storage |
| `./chat` | `ChatService`: history, membership, read receipts and pins |
| `./presence` | `PresenceService`: roster and status |
| `./activity` | `ActivityService`: an app-wide event log |
| `./cursor` | `CursorService`: live cursor fan-out |
| `./reactions` | `ReactionService`: ephemeral and durable reactions |
| `./notification` | `NotificationService`: a per-user inbox with replay |
| `./fileupload` | `FileUploadService` and blob storage |
| `./call` | `CallService`: invites, call state and lobbies |
| `./room` | `RoomService`: hangout room lifecycle and state |
| `./hangout-rooms` | Framework-free room types, layout validation and REST client |
| `./meeting` | `MeetingService`: raised hands and breakout rooms |
| `./pipeline` | Pipeline subscription fan-out |
| `./social` | Social event fan-out |
| `./ingest` | Ingest subscription fan-out |
| `./typed-documents` | Comments, reviews, items and workflow events for documents |
| `./work-graph` | Work-graph event, sharing and cursor contracts |
| `./work-graph/server` | Work-graph snapshot and replay cursor issuing and verification |
| `./deck` | Slide-deck model, validation, SVG preview and `.pptx` rendering |
| `./testing` | Test doubles for hosts built on `attachRealtime`; never for production |

## Hook reference

The hooks exported from `./client`. Hooks that take a channel subscribe and unsubscribe on their own when it changes. The type declarations carry the full signatures.

| Hook | What it does |
|---|---|
| `useGateway()` | The shared socket context: send, onMessage and connection state |
| `useGatewayOptional()` | The same context, or null outside a provider |
| `useFeatures()` | The features the nearest provider declared |
| `useWebSocket(opts)` | The low-level reconnecting WebSocket hook |
| `useSharedSocket()` | The socket and transport from the nearest `SharedSocketProvider` |
| `useSharedSocketTransport(socket)` | Refcounted channel subscriptions over a socket the host owns |
| `useSharedWebSocket(opts)` | `useWebSocket` whose frames fan out through a shared transport |
| `useLiveRefresh(read, opts)` | Re-reads a record when a frame says it moved, and polls when not live |
| `useDocumentHidden()` | Whether the browser tab is hidden |
| `useChannel(channel)` | Chat, presence, reactions and activity for one channel together |
| `useChat(channel)` | Messages, send, edit, delete, history and typing |
| `useChatMembers(channel)` | Members of a conversation and add or remove actions |
| `useChatReadReceipts(channel)` | Who has read what |
| `usePins(channel)` | Pinned messages |
| `usePresence(channel)` | The roster and your own status |
| `useReactions(channel)` | Send, toggle and read reactions |
| `useActivity(channel)` | The live activity feed and per-channel history |
| `useCursor(channel)` | Live cursors, throttled on the client |
| `useFileUpload(channel)` | Uploads with progress and cancel |
| `useAttachmentSrc()` | Turns an authenticated download URL into a renderable one |
| `useVideoHangout(channel)` | Start, join and leave a hangout on a live-video-streaming deployment |
| `useNotifications()` | A per-user inbox with unread counts and read state |
| `useCapability(name)` | Whether one deployment capability is on |
| `useCapabilities(names)` | The same for a set of capabilities |
| `useFeatureFlag(name)` | A feature flag and its variant |
| `useCRDT(opts)` | A single shared text value with conflict handling |
| `useYjsDoc(opts)` | A Yjs document bound to the gateway |
| `useAwarenessState(provider, initial)` | Per-user awareness fields for a document |
| `useCanvasDocument(opts)` | Canvas documents with Markdown import and export |
| `useIdleDetector()` | Whether the user is idle |
| `useDictation()` | Speech dictation from the microphone |
| `useCanvasCapture()` | A canvas as a media stream track |
| `usePipelineRunStatus(runs, opts)` | Live status for pipeline runs |
| `usePipelineCatalog(opts)` | The pipelines directory with run rollups |
| `useAgentLoopRun(runId, opts)` | One agent loop run and its steps |
| `useDeckReviseStatus(documentId)` | In-flight revisions of a presentation |
| `usePresentationRevisions(opts)` | A presentation's revision history |
| `useAgentStream(opts)` | Messages, tool calls and text from an agent stream |

## Related repositories

- Depends on [`connorhoehn/service-runtime`](https://github.com/connorhoehn/service-runtime) and [`connorhoehn/event-catalog`](https://github.com/connorhoehn/event-catalog).
- Used by [`connorhoehn/ui-components`](https://github.com/connorhoehn/ui-components), [`connorhoehn/aws-agentcore`](https://github.com/connorhoehn/aws-agentcore), [`connorhoehn/realtime-examples`](https://github.com/connorhoehn/realtime-examples), [`connorhoehn/platform-api`](https://github.com/connorhoehn/platform-api) and [`connorhoehn/live-video-streaming`](https://github.com/connorhoehn/live-video-streaming).

## Documentation

- [Adoption guide](./docs/ADOPTION-GUIDE.md): installing and wiring the subpaths into a new app.
- [Usage patterns](./docs/USAGE-PATTERNS.md): common wiring patterns for client and server.
- [Feature manifest guide](./docs/FEATURE-MANIFEST-GUIDE.md): the contract between a feature and its host, and each feature's settings.
- [Recipes](./docs/recipes/README.md): one page per capability: [chat](./docs/recipes/chat.md), [presence](./docs/recipes/presence.md), [cursors](./docs/recipes/cursors.md), [reactions](./docs/recipes/reactions.md), [activity](./docs/recipes/activity.md), [rooms](./docs/recipes/rooms.md), [calls](./docs/recipes/calls.md), [meetings](./docs/recipes/meetings.md), [notifications](./docs/recipes/notifications.md), [file uploads](./docs/recipes/file-uploads.md), [collaborative documents](./docs/recipes/collab-docs.md), [conversations](./docs/recipes/conversation.md), [streaming](./docs/recipes/streaming.md), [shared socket](./docs/recipes/shared-socket.md), [channel authorization](./docs/recipes/channel-authorization.md) and [Redis router](./docs/recipes/redis-router.md).
- [Meeting rooms design](./docs/design/meeting-rooms.md): the wire contract and authority model for raised hands and breakout rooms.
- [Direct recipient filtering](./docs/integrations/current-direct-recipients.md): filtering user-addressed frames and notification replay.
- [Call media effects](./docs/call-media-effects.md) and [chat pins store](./docs/chat-pins-store.md).
- [Demo](./demo/README.md), [release procedure](./RELEASE.md) and [changelog](./CHANGELOG.md).

## License

MIT. See [LICENSE](./LICENSE).
