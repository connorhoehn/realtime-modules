// realtime-modules/src/reactions/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/reactions`.
//
// Emoji-reaction fan-out. Two behaviours in one service, split by whether a
// reaction names a target:
//   - no targetId  → ephemeral. The floating emoji thrown at a call: fanned
//     out, kept in a small per-channel ring, never stored.
//   - targetId set → durable, when a `ReactionStore` is configured. A message
//     reaction is state, not an event: it is written before it is broadcast,
//     replayed to every new subscriber, and removable by its owner.
// See ReactionService.ts for the lift notes.

// Named export is the canonical surface. The default export on
// ReactionService.ts is kept for direct subpath imports
// (`import ReactionService from '.../reactions/ReactionService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
export { ReactionService } from './ReactionService';

export {
    DEFAULT_AVAILABLE_REACTIONS,
    DEFAULT_ERROR_CODE,
    type AvailableReaction,
    type Reaction,
    type ReactionConfig,
    type ReactionErrorFrame,
    type ReactionLogger,
    type ReactionMessageRouter,
    type ReactionMetricsCollector,
    type ReactionServiceOptions,
    type ReactionStore,
    type StoredReaction,
} from './types';

export { ReactionsManifest } from './manifest';
