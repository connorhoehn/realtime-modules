# useWebSocket gap analysis — realtime-modules vs gateway frontend

**Date:** 2026-05-18
**Status (2026-05-18 v2):** G1-G5 CLOSED in realtime-modules
`useWebSocket` v2. G6 (input shape) intentionally deferred — adapter
pattern at the swap site is cheaper than dual-shape support.
**Verdict:** swap NOW unblocked. Gateway can replace its in-tree
`frontend/src/hooks/useWebSocket.ts` with a thin adapter around the
library hook.

This file is the swap-blocker checklist. When each item is closed in
realtime-modules, tick it off; once all are closed, re-run the swap.

## v3 addendum (2026-06-11 — EKS finding #9, session-gated connect)

`connectionState` no longer flips to `'connected'` on `ws.onopen`. The
gateway silently drops inbound frames received before its per-connection
session bootstrap completes (it signals readiness with the
`{ type: 'session' }` frame), so subscribe-at-open lost every subscribe
frame under real network latency (14,846/14,846 frames on an EKS
cluster; loopback open≈session never reproduces it). v3 semantics:

- open → stays `'connecting'`; the `{ type: 'session' }` frame drives
  the `'connected'` transition (and `onConnect` / auto-resubscribe).
- `send()` while open-but-pre-session queues (bounded at 100,
  drop-oldest with a `console.warn`) and flushes in order on session
  arrival. The queue is per-connection-attempt: it dies with its
  socket; connected-gated effects re-issue subscribes on reconnect.
- Same gating applies on every reconnect.
- Plain-server fallback: no session frame within `sessionTimeoutMs`
  (default 3000) of open → warn + transition to `'connected'` + flush,
  preserving legacy behavior for non-gateway servers.

## Closure summary (v2)

- **G1 sessionStorage persistence** — CLOSED via opt-in `persist?: { storage, keyPrefix? }`.
- **G2 RECONNECT_EXHAUSTED terminal** — CLOSED via opt-in `maxRetries?: number` (default `Infinity`).
- **G3 defaultChannel seed** — CLOSED via `defaultChannel?: string`.
- **G4 stale-socket guards** — CLOSED — `wsRef.current !== ws` early returns in onopen/onmessage/onerror/onclose.
- **G5 autoResubscribe conflict** — CLOSED — auto-replay now opt-in via `autoResubscribe?: boolean` (default `false`).
- **G6 different input shape** — DEFERRED. Documented as adapter-at-swap-site, not dual-shape support.

---

## Compared

- `frontend/src/hooks/useWebSocket.ts` (gateway in-tree, ~302 LOC)
- `realtime-modules/src/client/useWebSocket.ts` (lifted, ~392 LOC,
  introduced by commit 3a45714)

---

## Gaps (user-visible regressions if swapped today)

### G1. No sessionStorage persistence for reconnect-with-session

Gateway initializes `sessionToken` and `clientId` from
`sessionStorage.getItem('ws_session_token' | 'ws_client_id')` so a
page refresh re-uses the existing gateway session via the
`?sessionToken=` query param in `buildUrl()`. Realtime-modules
starts both fields at `null` and never reads/writes sessionStorage.

**Impact:** every page refresh allocates a brand-new gateway session
— breaks server-side session continuity (presence, channel
subscriptions, audit trail).

**Fix in v2:** add an opt-in `persist?: { storage: Storage; keyPrefix?: string }`
option that mirrors gateway's read-on-init / write-on-handshake /
clear-on-intentional-disconnect dance.

### G2. No `RECONNECT_EXHAUSTED` terminal error

Gateway caps reconnect attempts at `MAX_RETRIES = 5` and on
exhaustion sets `lastError = { code: 'RECONNECT_EXHAUSTED', ... }`.
`ToastProvider` consumers (and `App.tsx` GatewayDemo's `errors`
state) rely on this single, terminal error frame to display a
"connection lost" toast exactly once per outage.

Realtime-modules reconnects unbounded — backoff is capped at
`maxReconnectMs` (default 30s) but attempts continue forever. There
is no terminal failure signal at all.

**Impact:** the user never sees a "give up" indicator; reconnect
loops silently in the background.

**Fix in v2:** add `maxRetries?: number` (default `Infinity` to
preserve current behavior) that, when exhausted, emits a
`RECONNECT_EXHAUSTED` `GatewayError` and transitions to
`disconnected`.

### G3. No `defaultChannel` seed

Gateway's `GatewayConfig.defaultChannel` initializes
`currentChannel` so feature hooks (`usePresence`, `useChat`, etc.)
have a channel to observe on first render. Realtime-modules
initializes `currentChannel` to `''`.

**Impact:** feature hooks would render with an empty channel until
the consumer manually called `switchChannel()`, causing one wasted
render cycle and potential subscribe-to-empty-channel bugs.

**Fix in v2:** add `defaultChannel?: string` to `UseWebSocketOptions`,
seed `currentChannel` with it on first render.

### G4. No stale-socket guards (React StrictMode hazard)

Gateway guards every socket handler with `if (wsRef.current !== ws) return;`
to drop events from a socket that StrictMode's double-mount has already
superseded. Without this, ws1's late `onclose` clobbers ws2's
'connected' state and the UI shows a phantom "disconnected".

Realtime-modules has no such guards. The lifecycle effect's cleanup
calls `disconnect()` on unmount which sets `intentionalCloseRef`, so
some races are avoided — but `onmessage` / `onopen` from a stale
socket would still leak state mutations.

**Impact:** flicker / phantom-state under React 18 StrictMode in
dev; potentially visible in production under fast remount sequences.

**Fix in v2:** add `if (wsRef.current !== ws) return;` early returns
in `onopen` / `onmessage` / `onerror` / `onclose` handlers.

### G5. Auto-subscribe model conflicts with gateway's pull model

Realtime-modules tracks subscribed channels in `channelsRef` and
auto-resubscribes them on every reconnect. Gateway intentionally
does NOT subscribe in `useWebSocket` — feature hooks (useChat,
usePresence, etc.) observe `currentChannel` themselves and own their
subscribe lifecycle. The comment in gateway's `switchChannel` is
explicit: *"useWebSocket intentionally does NOT send subscribe
messages."*

**Impact:** if gateway swapped to the realtime-modules version,
every channel passed through feature hooks would be duplicate-
subscribed (once by the feature hook, once by `useWebSocket`'s
auto-resubscribe). Server-side this is mostly idempotent but it's
extra wire traffic and confuses the gateway's subscription registry.

**Fix in v2:** make auto-subscribe opt-in via
`autoResubscribe?: boolean` (default `false`); only consumers using
the convenience `subscribe()/unsubscribe()` API opt in.

### G6. Different input shape (refactor cost)

Realtime-modules takes `{ url, authToken, ... }`. Gateway takes
`{ config: GatewayConfig, onMessage }` where config = `{ wsUrl,
cognitoToken, defaultChannel }`. Even with G1-G5 fixed, every
consumer would need a translation layer. Not a blocker but worth
noting.

**Fix in v2 (optional):** accept either shape, or document the
recommended adapter pattern.

---

## What realtime-modules version does that gateway doesn't

These are net-positive extras worth keeping in v2 — they're not
gaps, just bonus capabilities:

- `onConnect` / `onDisconnect` callbacks (gateway only exposes
  `onMessage`)
- `subscribe()` / `unsubscribe()` / `publish()` convenience helpers
  (gateway leaves all framing to consumers)
- Configurable backoff (`reconnectMs`, `maxReconnectMs`); gateway
  hardcodes 1000ms / 2^n
- Pluggable WebSocket ctor via `globalThis.WebSocket` (test injection)
- Handles WebSocket construction errors (`CONSTRUCT_FAILED`)

---

## Recommendation

Land a useWebSocket v2 in realtime-modules that addresses G1-G5
(G6 optional). Keep gateway's in-tree hook until v2 ships; document
the gap in this file in the meantime.

When v2 lands:
1. Bump realtime-modules version
2. Update gateway pin
3. Re-run the swap (App.tsx, WebSocketContext.tsx,
   useDocumentActions.ts, DocumentEditorPage.tsx,
   useCollaborativeDoc.ts)
4. Delete `frontend/src/hooks/useWebSocket.ts` +
   `frontend/src/hooks/__tests__/useWebSocket.test.ts`
