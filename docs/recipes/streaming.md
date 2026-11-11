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

## Hooks in `./client/video`

These hooks live behind their own subpath so an app that never publishes video
never resolves the LVS transport. They talk to a live-video-streaming
deployment, not to `attachRealtime`.

| Hook | Returns |
|---|---|
| `useLVSContext()` | `LVSConfig` — the `{ baseUrl, getAuthToken, log }` the provider holds, for a caller that needs it directly |
| `useLVSPublisher(opts)` | the WHIP publish loop — `phase`, ICE and retry owned by the hook, capture owned by you |
| `useLVSSubscriber(opts)` | the WHEP side of the same |
| `useLVSHangout(opts)` / `useLVSHangoutShared()` | `{ participants, isJoined, isScreenSharing, isCameraEnabled, connectionState, error, videoUnavailable, toggleMute, toggleCamera, enableCamera, disableCamera, setCameraEnabled, startScreenShare, stopScreenShare, leave, canPublish, publishRevoked, publishRevokedReason, startPublishing, terminated }`. The `Shared` form reads one hangout from context instead of opening its own. See [publish control](#publish-control) |
| `useLVSViewerCount(opts)` | `{ viewerCount, error }` — polled |
| `useLVSRecordings(opts)` | `{ recordings, isLoading, error, refetch }` |
| `useLVSHlsPlayer(opts)` | `{ playlistUrl, tokenExpiresInSec, ready }` — near-realtime HLS playback |
| `useLiveCaptions(opts)` | `CaptionLine[]` |
| `useMediaDevices(opts?)` | `{ microphones, cameras, speakers, permission: { microphone, camera }, speakerSelectionSupported, loading, refresh, requestPermission }` — device lists and browser permission for call surfaces |
| `useAudioVideoSettings(opts?)` | `{ settings, update, constraints, previewStream, previewError, micLevel, testMic, testSound, testMicState }` — per-browser mic/speaker/camera settings under `call-device-preferences` |
| `useDocumentCall(opts)` | `{ call, phase, joined, isHost, elapsedMs, error, ended, participants, inCallCount, inCallUserIds, activeSpeakerId, self, start, join, leave, endForEveryone, invite, ringAgain, setDocuments, setTitle, present, following, follow, toggleMic, toggleCamera, startScreenShare, stopScreenShare, lvs, inviteLink, refresh, muteParticipant, removeParticipant, transferHost, setMutedForMe, moderation, canPublish, publishRevoked, publishRevokedReason, startPublishing, revokePublish, grantPublish }` — a call that belongs to a document review; see [the calls recipe](./calls.md#document-calls) and [publish control](#publish-control) |
| `useIncomingDocumentCalls(opts)` | `{ current, queue, queueLength, accept, decline, dismiss }` — rings for `kind:'document-review'` invites |
| `useConversationCall(opts)` | One conversation's call: ring, accept, decline, leave and rejoin over the gateway's `call` frames, the video session and the media session. See [conversation](./conversation.md) |
| `useIncomingConversationCalls(opts)` | Every ring addressed to the signed-in user, for an app-wide toast or a row badge |
| `useDevicePreferences(storage?)` | `[prefs, set]` - the microphone, camera and speaker this browser remembers, stored under `call-device-preferences` |

### Publish control

A call's host can revoke a participant's publishing (camera, microphone and
screen) and grant it back; the participant stays in the call as a viewer. LVS
tells the participant's own stage socket (`participant.publish-revoked` /
`participant.publish-granted`) and refuses their WHIP with `403
publish_revoked` until a grant (live-video-streaming `docs/adopting-lvs.md`,
"Participants and publish control").

- **`useLVSHangout`** (and so `useLVSHangoutShared`). On a revocation it
  stops and releases the camera, microphone and screen it captured, closes its
  publishers without a WHIP DELETE (LVS already closed them), and stays joined
  as a viewer: `publishRevoked` true, `canPublish` false,
  `publishRevokedReason` the host's reason. Device actions do nothing while it
  holds, and nothing republishes. A WHIP refused as revoked (joining while
  revoked, or a reconnect that raced the revocation) is the same state, never
  an error and never retried. A grant sets `canPublish` and starts nothing:
  `startPublishing()` captures and publishes again, and its first WHIP calls
  `getAuthToken({ forceRefresh: true, reason: 'publish-granted' })`, which
  must return a token minted after the grant (a rejection fails that publish).
  A subscriber token joins as a viewer without capture until a grant. Remote
  `participants[]` carry `publishRevoked` and their token `attributes`.
- **Final stage closes.** Close 4410 (kicked) and 4403 (refused) end the
  session: no reconnect, media released, `terminated` `{ outcome, code,
  reason }`, `connectionState` `failed` and `error` set. Every other close
  reconnects as before.
- **`useDocumentCall`.** The consumer's media binding reports `canPublish`,
  `publishRevoked`, `publishRevokedReason`, `startPublishing` and per-member
  `publishRevoked` / `attributes`; the hook returns the same, turns `self` off
  (and tells the call) when you are made view-only, ignores turning devices on
  meanwhile, and marks each participant `publishRevoked` with their
  `participantId`. The host's `revokePublish(userId, { reason })` /
  `grantPublish(userId)` call platform-api `POST
  /api/video/sessions/:id/participants/:participantId/revoke-publish |
  grant-publish`.
- **`useConversationCall`.** Returns the media session's `canPublish`,
  `publishRevoked`, `publishRevokedReason` and `startPublishing`; its token
  resolver answers the forced refresh with platform-api `POST
  /api/video/sessions/:id/refresh-token`. `conversationCallDockProps` disables
  the mic, camera and share controls with a `disabledReason` while you may not
  publish.
