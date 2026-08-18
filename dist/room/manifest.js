"use strict";
// realtime-modules/src/room/manifest.ts
//
// FeatureManifest for the room (shared-space membership) feature.
// Channels are `room:<slug>`; occupancy deltas broadcast to members.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomManifest = void 0;
exports.RoomManifest = {
    name: 'room',
    version: '0.1.0',
    envVars: {},
    channels: ['room:*'],
};
//# sourceMappingURL=manifest.js.map