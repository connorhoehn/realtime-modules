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
// connected at all, in the broadcast case). The empty `channels` array
// below documents that.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallManifest = void 0;
exports.CallManifest = {
    name: 'call',
    version: '0.1.0',
    envVars: {},
    // Intentionally empty — call signaling is direct user-to-user routing,
    // not channel-pub/sub. See header above. Consumer manifests that
    // aggregate channels for env-var docs / route-mounting should skip
    // this entry rather than treat the empty array as "subscribes to
    // everything".
    channels: [],
    dependencies: [],
};
//# sourceMappingURL=manifest.js.map