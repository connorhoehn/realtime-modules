# Recipe: one stream, many viewers

> A broadcast is not a big call. The transport that makes a conversation work
> is the one that makes an audience expensive, and choosing between them is a
> capacity decision you make once, per surface.

The [calls](./calls.md) and [rooms](./rooms.md) recipes cover people talking to
each other. This one covers people watching.

## The choice, and why it is not a preference

LVS delivers the same channel two ways:

| | transport | latency | cost per viewer |
|---|---|---|---|
| **Realtime** | WHEP — `useLVSSubscriber` | sub-second | one peer connection, on the SFU |
| **Near-realtime** | HLS — `useLVSLiveHls` | a few seconds | a cacheable HTTP segment; a CDN carries it |

**If viewers TALK BACK, they need realtime.** A two-second delay makes a
conversation unusable, and that is what the per-viewer cost buys.

**If they watch, near-realtime is cheaper by orders of magnitude** and looks
identical on screen. A viewer cannot tell which transport they are on.

The failure mode worth naming: serving a thousand-viewer all-hands over WHEP
because it is the transport the call code already used. It works in a demo and
falls over at scale, and nothing in the code says why.

## 1 — Server

Nothing new. Publishing and both playback paths are the same LVS channel:

```
POST /api/channels/:arn/whip                 publish   (the broadcaster)
POST /api/channels/:arn/whep                 realtime  (per viewer)
GET  /api/channels/:arn/hls/master.m3u8      near-realtime (ABR; any audience)
```

Private channels take a playback JWT minted by
`POST /api/channels/:arn/playback-tokens`; public ones need none.

## 2 — Publish

```tsx
import { useLVSPublisher } from '@connorhoehn/realtime-modules/client/video';

const stream = useMemo(() => /* getUserMedia or getDisplayMedia */, []);
const pub = useLVSPublisher({ channelArn, stream, baseUrl: LVS_URL });
// pub.phase → 'idle' | 'connecting' | 'live' | …
```

The caller owns capture. The hook owns WHIP, ICE and retry.

## 3 — Watch

One component, and the mode is DATA:

```tsx
import { WrappedStreamStage } from '@connorhoehn/ui-components/integrations/realtime-modules';

<WrappedStreamStage
  channelArn={channelArn}
  mode="near-realtime"     // or "realtime"
  baseUrl={LVS_URL}
  title="All hands"
  viewerCount={1240}
  chatMessages={ticker}    // overlays the video; see below
/>
```

Flipping a surface from a conversation to a broadcast is that one prop.
Defaults to `near-realtime`: a component whose job is "let people watch"
should default to the mode that scales, and realtime is the deliberate, more
expensive choice.

Only the chosen transport's hook runs. That matters beyond tidiness —
`useLVSSubscriber` THROWS outside an `LVSProvider`, while HLS needs no provider
at all, so a broadcast that also called the realtime hook would crash in most
hosts.

### Without the wrapper

`StreamStage` takes either source directly, if you would rather own the hooks:

```tsx
<StreamStage stream={sub.stream} … />          {/* realtime  */}
<StreamStage playlistUrl={hls.playlistUrl} … /> {/* near-realtime */}
```

`stream` wins when both are passed — it is the lower-latency source, so
passing both reads as "realtime, with HLS as the fallback", and that is what
happens.

## 4 — Chat over the video

A silent broadcast is a worse product than a small one. `chatMessages`
overlays a rotating ticker; feed it the tail of whatever conversation the
stream belongs to:

```tsx
const ticker = messages.slice(-12).map((m) => ({
  id: m.id, displayName: m.displayName, content: m.content, timestamp: m.timestamp,
}));
```

Keep it short. An overlay is glanceable, not a transcript — the full thread
belongs on a surface the viewer can open.

## Two things that are easy to get backwards

**`baseUrl` is not optional in practice.** Both hooks fall back to
realtime-modules' `LVSProvider`. A host that mounts a different provider — or
none, which is normal for HLS — gets a stage that renders its placeholder
while the stream is live. Pass `baseUrl` unless you mounted OUR provider.

**A viewer must not have to join to watch.** Resolving a lobby by asking for a
session CREATES one and enrols the caller as a participant, which throws away
the reason to use HLS. Resolve read-only
(`GET /api/video/sessions/by-lobby/:lobbyName`) and treat 404 as "nothing is
live" — that is what lets you hide the affordance rather than offer a button
that leads nowhere.

## Graduate to production

- **Playback tokens expire mid-stream.** A viewer leaves a broadcast open for
  an hour; a token dying between segments surfaces as a network error that
  reads like a broken stream. `useLVSLiveHls` returns `tokenExpiresInSec` —
  refresh before it reaches zero.
- **ABR is on by default** (`master.m3u8`). An audience is on every network
  there is, and dropping a rendition beats stalling. Pin a single rendition
  (`abr: false`) only for a known link, like a kiosk.
- **hls.js is an optional peer dependency**, dynamic-imported and skipped
  entirely on Safari, which plays HLS natively. Install it in the consumer app
  or non-Safari browsers report that playback is unsupported.
