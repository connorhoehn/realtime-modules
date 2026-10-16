// realtime-modules/src/meeting/manifest.ts

import type { FeatureManifest } from '../feature-manifest/types';

export const MeetingManifest: FeatureManifest = {
    name: 'meeting',
    version: '0.1.0',
    envVars: {},
    channels: ['meeting:*'],
    dependencies: [],
};
