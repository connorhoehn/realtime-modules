# realtime-modules showcase

Runnable Vite + React app exercising the feature hooks — now fully
self-contained: `npm run dev` starts its own realtime backend via
`attachRealtime` (server.mjs — one http server, one call, nine
capabilities) and the vite client, proxied same-origin. No gateway
deployment, no Redis, no env vars.

## Running

```bash
cd demo
npm install
npm run dev        # server :4001 + client http://localhost:5173
```

Open two browser windows to see presence/chat/reactions interact.

`npm run dev:server` / `npm run dev:client` run the halves separately.

## Pointing at a real gateway instead

Create `demo/.env.local`:

```env
VITE_GATEWAY_URL=ws://localhost:4000
```

Everything after this point (tabs, pages) is unchanged — each page
exercises one capability's hook per its recipe in ../docs/recipes/.
