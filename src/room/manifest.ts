// realtime-modules/src/room/manifest.ts
//
// FeatureManifest for the room (shared-space membership) feature.
// Channels are `room:<slug>`; occupancy deltas broadcast to members.

import type { FeatureManifest } from '../feature-manifest/types';

export const RoomManifest: FeatureManifest = {
    name: 'room',
    version: '0.1.0',
    envVars: {},
    channels: ['room:*'],
};
