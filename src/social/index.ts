// realtime-modules/src/social/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/social`.
//
// Wave 2 lift: WS-side social-event subscription fan-out. Pure
// in-memory. See SocialService.ts for the lift notes.
//
// Named export is the canonical surface. The default export on
// SocialService.ts is kept for direct subpath imports
// (`import SocialService from '.../social/SocialService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
export { SocialService } from './SocialService';

export type {
    SocialConfig,
    SocialEvent,
    SocialEventType,
    SocialFrame,
    SocialLogger,
    SocialMessageRouter,
    SocialMetricsCollector,
    SocialServiceOptions,
} from './types';

export { SocialManifest } from './manifest';
