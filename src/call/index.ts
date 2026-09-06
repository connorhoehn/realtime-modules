// realtime-modules/src/call/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/call`.
//
// v0.18.0 — the evolved CallService came home. The gateway forked the
// v0.6-era ancestor and grew it 5.5x in-tree (invite dedup, state stores,
// cross-node departure pub/sub, sweeper leadership, tracing seam); that
// implementation now lives here, with app couplings expressed as injected
// options (withSpan, stateStore, crossNodePubSub, sweeperIsLeader,
// onSweepSkipped) so the library stays dependency-light. The gateway keeps
// its DDB session-binding repository, Redis wiring and HTTP routes.

export { CallService } from './CallService';
export {
    ALLOWED_CALL_ACTIONS,
    isParticipantStateBroadcast,
} from './types';
export type {
    ActiveCallState,
    CallAction,
    CallConfig,
    CallCrossNodePubSub,
    CallErrorFrame,
    CallEvent,
    CallInvite,
    CallLogger,
    CallMessageRouter,
    CallServiceOptions,
    CallSweeperIsLeader,
    CallWithSpan,
    ParticipantStateBroadcast,
    UserClientMatch,
} from './types';
export {
    InMemoryCallStateStore,
    RedisCallStateStore,
} from './CallStateStore';
export type {
    ActiveCallStateView,
    CallStateStore,
    CallStateRedis,
} from './CallStateStore';
// The call ↔ conversation mapping, in both directions. Exported because both
// the gateway (posting a finished call into its thread) and the frontend
// (listing a conversation's recordings) need it, and two copies of one rule
// drift silently.
export {
  lobbyForChannel,
  channelForLobby,
  isDmLobby,
  dmLobbyMembers,
  shouldKnockToJoin,
} from './lobbyChannel';

export { CallManifest } from './manifest';
