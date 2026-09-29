# Conversation calls in the libraries — plan (2026-09-28)

The DM / room call that realtime-examples docks above the chat composer is app code today
(`frontend/src/providers/HangoutDomainProvider.tsx`, `components/hangout/HangoutOverlay.tsx` ~3.5k lines,
`components/hangout/HangoutShelfDock.tsx`, `hooks/useVideoCall.ts`, `hooks/useIncomingCalls.ts`,
`hooks/useHangoutMachine.ts`, `hooks/useDevicePreferences.ts`). A second app (aws-agentcore's Org portal) wants the
same chat-with-a-docked-call surface. The global rule: the libraries absorb it; apps import it. This plan ports the
**binding**, not the chrome-zoo: one hook that owns a conversation's call, one pure mapping to `CallDockProps`, and
one composite that draws it.

## What is ported, and what is deliberately left

Ported: ring / accept / decline / leave / rejoin over the gateway's `call` frames (`calls()` server feature), the
platform-api video session (create/join → participant token, end), the LVS media session (`useLVSHangout`, already
in `client/video`), device preferences, the dock-target idea reduced to "docked or floating", the state → `CallDock`
mapping (`HangoutShelfDock`), and the incoming-call listener.

Left in realtime-examples for now: the floating `CallWidget` / `EmbeddedCallPanel` chromes, drag-to-dock between
surfaces (`VideoDockSlot` + the dock registry), recordings, captions, reactions, effects UI, rooms' `Go live`. The
hook exposes what those need (`media`, `call`, `phase`) so the app keeps rendering them from the same state.

## API — `@connorhoehn/realtime-modules/client/video` (0.98.0)

```ts
// The call this conversation has (or could have). One instance per conversation surface.
export function useConversationCall(opts: {
  /** Verbatim lobby name — the hook never rewrites it. Tenant prefixes are the caller's ( `<tenant>:dm:<a>:<b>` ). */
  lobbyName: string;
  /** The chat channel the call belongs to (for cards / discovery); optional. */
  channel?: string;
  self: { userId: string; displayName: string };
  /** platform-api access — props, never env. `getIdToken` is called per request. */
  platformApi: { baseUrl: string; getIdToken: () => string | Promise<string> };
  /** The gateway socket the app already holds (same shape `useChat` / `usePresence` use). */
  gateway: { send: (frame: object) => void; onMessage: (fn: (frame: any) => void) => () => void; connectionState?: string };
  /** LVS comes from <LVSProvider baseUrl getAuthToken> above; the hook overrides the token with the participant JWT. */
  devices?: DevicePreferences;                      // initial; the hook keeps them (see useDevicePreferences below)
  onCallStarted?, onCallEnded?, onCallMissed?;      // mirrors the server hooks (0.97.10)
}): ConversationCallResult;

export interface ConversationCallResult {
  phase: 'idle' | 'calling' | 'ringing' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'failed';
  call: { callId: string; lobbyName: string; startedAt: number | null; host: string | null;
          participants: ConversationCallParticipant[]; audioOnly: boolean } | null;
  incoming: IncomingConversationCall | null;        // a ring for THIS lobby (the app-wide toast uses the hook below)
  error: { message: string; status?: number; code?: string } | null;
  start(targets: { userId: string; displayName?: string }[], opts?: { audioOnly?: boolean }): Promise<void>;
  accept(): Promise<void>; decline(reason?: 'not-now' | 'busy'): void; leave(): Promise<void>; rejoin(): Promise<void>;
  media: UseLVSHangoutResult;                        // members/streams, setCameraEnabled, setMicEnabled, screen share, stats
  devices: { prefs: DevicePreferences; set(next: DevicePreferences): void; list: UseMediaDevicesResult };
  elapsedMs: number | null;
  activeSpeakerId: string | null;
}

// App-wide: every ring addressed to me, for the toast / the DM row badge. One per app.
export function useIncomingConversationCalls(opts: { gateway; self }): {
  rings: IncomingConversationCall[]; accept(ring): void; decline(ring, reason?): void;
};

// Pure. The HangoutShelfDock mapping, so UI stays a function of state.
export function conversationCallDockProps(
  s: ConversationCallResult,
  ui: { title: string; extras?: ReactNode; onOpenPeople(): void; onOpenSettings(): void; onPopOut?(): void;
        tile: (p: ConversationCallParticipant) => ReactNode | undefined; compact?: boolean },
): CallDockProps;

// Helpers the apps were hand-rolling.
export function dmLobbyName(userIds: string[], opts?: { prefix?: string }): string;   // `${prefix}dm:${sorted.join(':')}`
export function channelForLobby(lobbyName: string): string | null;                   // already in /call — re-exported
export function useDevicePreferences(storage?: Storage): [DevicePreferences, (n: DevicePreferences) => void];
```

Server side (already there): `calls()` in `@connorhoehn/realtime-modules/server` routes rings by `userId` from the
gateway `auth` result. For a tenant-scoped app the auth resolver maps the JWT's `{ sub, displayName, org }` to
`{ userId: sub, displayName, org }`; **new option** `calls({ lobbyGuard: (auth, lobbyName) => boolean })` lets the
host refuse a lobby whose prefix is not the caller's `org` (default: allow). Nothing else changes on the wire.

## API — `@connorhoehn/ui-components/integrations/realtime-modules`

```ts
export function ConversationCallDock(props: {
  call: ConversationCallResult;                      // from the hook
  title: string;                                     // the conversation's name
  extras?: ReactNode;                                // reactions / recording chip / side-panel toggles, app-owned
  onOpenPeople(): void; onOpenSettings(): void; onPopOut?(): void;
  compact?: boolean;
}): JSX.Element;   // = CallDock + StreamVideo tiles via conversationCallDockProps; null while phase === 'idle'
```

Drops into `ChatPanel dock={<ConversationCallDock …/>}`. `IncomingCallToast` stays app-side this round (it is
mostly copy and identity), but `CallingStatusPill`, `CallDock`, `CallSidePanel` are already library.

## Lanes

1. **RM** (worktree `../realtime-modules-wt-conversation-call`): extract from realtime-examples — `useHangoutMachine`
   (phases) + `useVideoCall` (platform session) + the ring/accept/leave frame logic of `HangoutOverlay`/`HangoutDomainProvider`
   + `useIncomingCalls` into `src/client/video/useConversationCall.ts`, `useIncomingConversationCalls.ts`,
   `conversationCallDockProps.ts`, `useDevicePreferences.ts`; tests with the fake gateway the document-call hooks use
   (`documentCallGateway.ts` pattern); `docs/recipes/calls.md` rewritten around the hook (it still says "no hook in
   ./client sends those yet"). Version **0.98.0**, CHANGELOG, dist, push, tag as the repo does.
2. **UI** (worktree): `integrations/realtime-modules/ConversationCallDock.tsx`, story with a fake result, test.
   Next free version.
3. **realtime-examples**: `HangoutShelfDock` becomes a thin call of `conversationCallDockProps` (or the composite)
   fed by the overlay's state, proving the mapping is the same; no behaviour change; the shelf audit's specs are the
   regression gate. Pin both.
4. aws-agentcore wires `useConversationCall` + `ConversationCallDock` on the initiative page (their lane).

## Done means

- A second app can mount `<LVSProvider>` + `useConversationCall({ lobbyName, self, platformApi, gateway })` +
  `<ConversationCallDock>` and get ring → accept → live tiles → leave against the same gateway and platform-api,
  with lobby names it chose and a JWT it minted.
- realtime-examples' shelf renders from the library mapping and its e2e suite stays green.
