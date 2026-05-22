# realtime-modules showcase

Runnable Vite-React-TypeScript app that exercises all six advertised feature hooks side-by-side.

## Running

```bash
cd demo
npm install
npm run dev        # → http://localhost:5173
```

Production build:

```bash
npm run build      # emits to demo/dist/
npm run preview    # serve the built output locally
```

## Required environment variables

Create `demo/.env.local` (never committed):

```env
VITE_GATEWAY_URL=ws://localhost:4000
VITE_AUTH_TOKEN=your-bearer-token
```

| Variable | Description |
|---|---|
| `VITE_GATEWAY_URL` | WebSocket URL of your `websocket-gateway` instance. Use `ws://` for local, `wss://` for TLS. |
| `VITE_AUTH_TOKEN` | Bearer token forwarded via the `bearer-token-v1` WS subprotocol. Leave blank if your gateway allows anonymous connections. |

If `VITE_GATEWAY_URL` is missing, the app shows a config-required banner with setup instructions.

## Pointing at the gateway

Start the gateway locally (from the `websocket-gateway` repo):

```bash
# docker compose (shared services mode)
tilt up
# or bare node
PORT=4000 node dist/server.js
```

Each demo page joins a dedicated channel (`demo:chat-room`, `demo:presence-room`, …) so they don't interfere when multiple tabs are open.

## Hook status when disconnected

Every hook degrades gracefully when the WebSocket is disconnected:

- Lists remain in their last-known state (empty on first load)
- `send*` calls are silently dropped until reconnection
- `useGateway().connectionState` is exposed so you can show your own status badge

The connection state badge is intentionally omitted from the demo pages to keep the
code focused on each hook's own API surface.

## Pages

| Tab | Hook | Channel |
|---|---|---|
| useChat | `useChat(channel)` | `demo:chat-room` |
| usePresence | `usePresence(channel)` | `demo:presence-room` |
| useReactions | `useReactions(channel)` | `demo:reactions-room` |
| useActivity | `useActivity(channel)` | `demo:activity-room` |
| useFileUpload | `useFileUpload(channel)` | `demo:upload-room` |
| useVideoHangout | `useVideoHangout(channel)` | `demo:hangout-room` |

## Architecture notes

- The Vite alias in `vite.config.ts` maps `@connorhoehn/realtime-modules/client` to `../src/client/index.ts`, so the demo always runs against the live source — no package rebuild needed when editing hooks.
- The demo has no test coverage; it exists purely as a visual/integration showcase.
- Do **not** add production logic here — the demo is ephemeral scaffolding.
