// realtime-modules/src/presence/index.ts
//
// @connorhoehn/realtime-modules/presence — barrel export.
//
// In-process presence tracking lifted from gateway in Wave 2.
// See PresenceService.ts header for what was lifted vs. left behind.

import PresenceService from './PresenceService';

export { PresenceService };
export { PresenceManifest } from './manifest';

export type {
    PresenceConfig,
    PresenceEntry,
    PresenceLogger,
    PresenceMessageRouter,
    PresenceStatus,
    PresenceUpdate,
} from './types';
