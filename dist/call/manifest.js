"use strict";
// realtime-modules/src/call/manifest.ts
//
// FeatureManifest for the lifted call (hangout-invite) feature. Consumers
// (gateway, edge-gateway, etc.) declare this in their feature registry to
// advertise the env-var + routing-model contract.
//
// Note on `channels`: this feature is intentionally NOT channel-based. Call
// signaling routes user-to-user via getClientsByUserId resolution, with a
// broadcast fallback to every connected client when no targets are supplied.
// There is no WS channel subscription tied to a call — recipients receive
// frames because they are authenticated as one of the targeted userIds (or
// connected at all, in the broadcast case).
//
// One exception (0.136.0, lane L9): lobby OCCUPANCY is channel-based. `watch`
// subscribes a socket to `call-lobby:<lobby>` (after the host's channel
// authority admits it) and `lobby-occupancy` frames are published there.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallManifest = void 0;
exports.CallManifest = {
    name: 'call',
    version: '0.1.0',
    envVars: {},
    // Signaling is direct user-to-user routing, not channel pub/sub (see the
    // header); only lobby occupancy (`watch`) rides a channel.
    channels: ['call-lobby:*'],
    dependencies: [],
};
//# sourceMappingURL=manifest.js.map