// realtime-modules/src/activity/manifest.ts
//
// FeatureManifest export for the activity-feed feature. Consumers read
// this to validate env, document the wire channels, and find the install
// hooks without coupling to module internals.

import type { FeatureManifest } from '../feature-manifest/types';

export const ActivityManifest: FeatureManifest = {
    name: 'activity',
    version: '0.1.0',
    channels: ['activity:*'],
    envVars: {
        REDIS_URL: {
            required: false,
            description:
                'Backing store for the gateway-side ActivityHistoryStore Redis adapter. Only read by gateway wiring — the lifted module itself uses the configured ActivityHistoryStore implementation directly (defaults to InMemoryActivityHistoryStore).',
        },
        EVENT_CATALOG_URL: {
            required: false,
            description:
                'Durable-publish target for `activity.recorded` events. The lifted module exposes only the WS surface; the event-catalog setter + retry plumbing lives in the gateway adapter.',
        },
    },
};

export default ActivityManifest;
