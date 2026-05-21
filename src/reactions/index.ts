// realtime-modules/src/reactions/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/reactions`.
//
// Wave 2 lift: pure in-memory emoji-reaction fan-out service with a small
// LRU history per channel. See ReactionService.ts for the lift notes.

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
} from './types';

export { ReactionsManifest } from './manifest';
