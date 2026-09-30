# Recipe: Calls / hangout invites

> Plug `calls` into an app you already have. Three steps + a graduation path.

User-addressed call invites, accept/decline/end lifecycle, participant state broadcast. Requires `auth` so userIds route (`getClientsByUserId`).

## 1 — Server (attach to your existing http.Server)

```ts
import http from 'http';
import { attachRealtime, calls } from '@connorhoehn/realtime-modules/server';

const httpServer = http.createServer(app);      // your existing app
const realtime = attachRealtime(httpServer, {
    features: [calls({
        // Optional: refuse lobbies this connection may not use. `auth` is what
        // your resolver below returned; `lobbyName` is the frame's, verbatim.
        lobbyGuard: (auth, lobbyName) => lobbyName.startsWith(`${auth.org}:`),
        // Optional: default false — an invite with no targetUserIds is refused.
        // allowUntargetedInvites: true,
        // Optional: how long a call waits for a dropped socket (default 30 s).
        // rejoinGraceMs: 30_000,
    })],
    // Rings route by the userId this returns (`getClientsByUserId`).
    auth: async (req) => {
        const { sub, displayName, org } = await verifyJwt(req);
        return { userId: sub, displayName, org };
    },
    path: '/realtime',   // omit this and the handler claims EVERY upgrade on the server
});
httpServer.listen(3000);
```

Add more capabilities by adding entries to `features` — nothing else changes.

`lobbyGuard` runs for every call frame that names a lobby, after
`config.authorize`; return false and the frame is refused with an error before
any routing. Frames that carry only a `callId` (a late `accepted`) are not
guarded — a call id is unguessable, and the invite that minted it was.

`allowUntargetedInvites` (default **false**) refuses an `invite` with no
`targetUserIds`: the server would broadcast it to every connected socket —
every tenant's. The sender gets a structured error and nothing is registered
or sent:

```json
{ "type": "error", "service": "call", "code": "untargeted-invite",
  "action": "invite", "callId": "…", "lobbyName": "acme:dm:alice:bob",
  "message": "invite needs targetUserIds: …" }
```

Room walk-ins (`room:design`, `acme:room:design`) and document-call invites are
never refused. Set it to `true` only on a single-tenant host that wants the
broadcast ring. (A `CallService` built directly keeps the legacy default,
`true`; pass `config.allowUntargetedInvites: false` there.)

`status` answers `{ lobbyName, active: false }` once a call is over, and while
it is live, only people whose socket is still connected count as participants.
Someone who dropped is listed apart while the call waits for them (the rejoin
grace), and the call ends if they are not back when it runs out:

```json
{ "lobbyName": "acme:dm:alice:bob", "active": true, "callId": "…",
  "callerId": "alice", "participantUserIds": ["bob"], "participantCount": 1,
  "reconnecting": [{ "userId": "alice", "graceUntil": "2026-09-29T12:00:30.000Z" }] }
```

`reconnecting` comes from the replica that saw the drop; another replica
answers without it. A DM (`dm:`, `dmg:`, or tenant-prefixed `acme:dm:…`) ends
when either party hangs up; a room keeps going with one person.

## 2 — Client (React hooks)

`./client/video` has the client half of `calls()` for a conversation — a DM or
a room, the call docked above the chat composer:

```tsx
import {
  LVSProvider,
  useConversationCall,
  useIncomingConversationCalls,
  dmLobbyName,
} from '@connorhoehn/realtime-modules/client/video';
import { useGateway } from '@connorhoehn/realtime-modules/client';
import { ConversationCallDock } from '@connorhoehnslalom/ui-components/integrations/realtime-modules';

// One per conversation surface. Mount it where the call should live: unmounting hangs up.
function DmThread({ me, other, org }: { me: User; other: User; org: string }) {
  const gateway = useGateway();                      // the socket the app already holds
  const call = useConversationCall({
    lobbyName: dmLobbyName([me.id, other.id], { prefix: `${org}:` }),   // used verbatim
    channel: `chat:dm:${[me.id, other.id].sort().join(':')}`,          // optional
    self: { userId: me.id, displayName: me.name },
    platformApi: { baseUrl: PLATFORM_API_URL, getIdToken: () => auth.idToken() },
    gateway,
  });
  return (
    <ChatPanel
      dock={<ConversationCallDock call={call} title={other.name}
              onOpenPeople={…} onOpenSettings={…} />}
      headerActions={<Button onClick={() => call.start([{ userId: other.id, displayName: other.name }])}>Call</Button>}
      …
    />
  );
}

// One per app: every ring addressed to you, for the toast.
function IncomingCalls() {
  const { rings, accept, decline } = useIncomingConversationCalls({
    self: { userId: me.id },
    onAccept: (ring) => openConversation(ring.lobbyName, ring),  // then call.accept(ring) there
  });
  …
}

// Above both, once: media (the hook swaps in the participant token).
<LVSProvider baseUrl={LVS_URL} getAuthToken={() => auth.idToken()}>…</LVSProvider>
```

`useConversationCall` owns the whole call:

- **phase** — `idle` · `calling` (you rang, nobody answered) · `ringing` (a
  ring for this lobby: `incoming`) · `connecting` · `live` · `reconnecting` ·
  `ended` (held a few seconds) · `failed` (`rejoin()` tries again).
- **start(targets, { audioOnly })** — platform-api `POST /api/video/sessions`
  (`findOrCreate` on the lobby) → `/:id/join` → participant token; then one
  targeted `invite`. **accept(ring?)** sends `accepted` to the caller and joins
  the same session; **decline(reason)** sends `declined`; **leave()** sends
  `user-status: left` to the others, `ended` to your own other tabs, `cancelled`
  to anyone still ringing, and `/:id/end`; **rejoin()** gets a fresh session in
  the same call after a failure, or joins a live call the lobby's `status`
  reply reported.
- **call** — `{ callId, lobbyName, channel, startedAt, host, participants,
  participantCount, audioOnly }`; participants merge the gateway roster
  (`participant-state` carries each person's SFU participant id) with the media
  members, plus invitees still ringing / who declined.
- **media** is `useLVSHangout`'s result; **self**, **toggleMic / toggleCamera /
  toggleScreenShare**, and **devices** (`prefs`, `set`, the device `list`) are
  what the dock's controls need.
- `onCallStarted`, `onCallEnded`, `onCallMissed` mirror the server hooks for the
  client that saw them.

Every frame the hooks send is targeted (the people rung, the people in the
call, or yourself). The server broadcasts an untargeted call frame to every
connected client, which a multi-tenant host must never do; the hooks never
rely on it. The only untargeted frame is the `status` query, which the server
answers to the sender alone.

A person may have several sockets (tabs, devices). The caller's other sockets
are not rung; they get the callee's `accepted` and the call's `ended`, and have
no say in whether the callee rings. Every socket of the callee rings; the first
`accepted` takes the call and the others get that `accepted` (the ring
dismisses). An `accepted` from a second socket of someone already in the call
is refused with `ended { reason: 'answered-elsewhere' }` to that socket alone —
the caller sees one answer and the call holds each person once. A socket the
server already knows is closed does not count, so a refresh still rejoins.

`conversationCallDockProps(call, ui)` is the pure mapping onto ui-components'
`CallDock` props (null while idle or ringing); `ConversationCallDock` draws it
with `StreamVideo` tiles and measures the active speaker.

**`useVideoHangout` is not the client half of `calls()`.** It sends
`service: 'videohangout'`, and this package ships no such service — against
`attachRealtime` every frame it sends comes back `SERVICE_NOT_AVAILABLE`. It is
the signalling client for a live-video-streaming deployment, which serves that
service and hands back the `joinToken` that `./client/video` (`<Stage>` /
`useLVSHangout`) needs. Point it at that deployment, not at `calls()`.

Point the client at the same origin and the `path` set above —
`ws://localhost:3000/realtime`. There is no default path: leave `path` off and
the upgrade listener takes every WebSocket upgrade on that server, including
one meant for an endpoint you already had. All hooks share one WebSocket via
the provider from `@connorhoehn/realtime-modules/client`.

## 3 — UI (ui-components)

Use **ConversationCallDock** (in `ChatPanel dock={…}`) for the conversation
call, and **WrappedHangoutLayout, HangoutRoomRow** for rooms. Per the frontend
discipline: never hand-roll the surface — if a composite is missing, add it to
ui-components first.

## Graduate to production

Zero-config uses in-memory state (single process, non-durable). To graduate:

```ts
calls({ stateStore: new RedisCallStateStore(redis) })  // multi-replica call state; cross-node pub/sub via CallServiceOptions
```

Multi-node? Swap the transport, not the features: pass a Redis-backed
`RealtimeRouter` via `attachRealtime(server, { router })` — the
websocket-gateway MessageRouter is the reference implementation.

## Document calls

A call that belongs to a document review (2026-09-24): a title, a list of
review documents, a presenter others can follow, and per-person ring state.
Server side, pass a meta store to the call service:

```ts
import { CallService, RedisCallStateStore, RedisDocumentCallMetaStore } from '@connorhoehn/realtime-modules/call';

new CallService({
  messageRouter, logger,
  stateStore: new RedisCallStateStore(redis),
  metaStore: new RedisDocumentCallMetaStore(redis),       // call:meta:<callId>, TTL 4 h
  onOfflineInvite: (userId, invite) => notifications.notifyUser(userId, …),
  isClientAlive: (clientId) => nodeOfClientHasHeartbeat(clientId),
});
```

New actions: `meta` (reply `call-meta` to the asker), `set-documents`,
`present` and `set-title` (each broadcasts `call-meta`); server-only
`call-meta` and `invite-expired`; `user-status` gains `reconnecting`. An
invite with `kind:'document-review'` writes the meta; rings expire per person
(the caller gets `invite-expired`), and a call someone answered is never ended
by a ring timing out. Document calls never broadcast to every connected
client.

Client side (`./client/video`): `useDocumentCall` for the call,
`useIncomingDocumentCalls` for the rings, `useMediaDevices` and
`useAudioVideoSettings` for the settings drawer. `useDocumentCall` mints the
LVS stage token (`lvs`); mount `LVSHangoutSessionProvider` with it and pass
the session back as `media` so toggles and members line up.

Host moderation (0.97.0): `mute-participant`, `remove-participant` and
`transfer-host` (`{ callId, userId }`, host only, target must be in the call).
The target's own connections get `mute-participant` / `remove-participant`
(`{ callId, userId, by }`) and their client mutes or leaves; everyone else gets
`user-status: left` (reason `removed`) and `call-meta`. A removed person's
invite reads `removed` and only a new invite lets them back. In the hook:
`muteParticipant`, `removeParticipant`, `transferHost`, plus the local-only
`setMutedForMe` (`participant.mutedForMe`) and `moderation` for a toast.
