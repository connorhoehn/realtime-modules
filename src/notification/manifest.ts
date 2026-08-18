// realtime-modules/src/notification/manifest.ts
//
// FeatureManifest for the notification feature. User-addressed (not
// channel-based): frames deliver to every live tab of a userId, with
// Redis-backed persistence + replay when a store is wired.

import type { FeatureManifest } from '../feature-manifest/types';

export const NotificationManifest: FeatureManifest = {
    name: 'notification',
    version: '0.1.0',
    envVars: {},
    channels: [],
};
