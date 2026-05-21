"use strict";
// realtime-modules/src/presence/manifest.ts
//
// FeatureManifest for the lifted in-process PresenceService.
// Consumers (gateway, edge-gateway, realtime-fanout) include this in their
// feature registry to advertise the channel + env-var contract.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceManifest = void 0;
exports.PresenceManifest = {
    name: 'presence',
    version: '0.1.0',
    channels: ['presence:*'],
    envVars: {
        PRESENCE_HEARTBEAT_INTERVAL_MS: {
            required: false,
            default: '30000',
            description: 'How often (ms) the stale-presence sweep runs. Lower for tighter timeout granularity at the cost of CPU.',
        },
        PRESENCE_TIMEOUT_MS: {
            required: false,
            default: '60000',
            description: 'Inactivity threshold (ms) after which a client is auto-flipped to status:offline.',
        },
        PRESENCE_STALE_THRESHOLD_MS: {
            required: false,
            default: '90000',
            description: 'Idle-client eviction TTL (ms). cleanupStaleClients deletes presence entries past this age.',
        },
        PRESENCE_CLEANUP_INTERVAL_MS: {
            required: false,
            default: '30000',
            description: 'How often (ms) the cleanupStaleClients sweep runs.',
        },
        PRESENCE_DISCONNECT_DELAY_MS: {
            required: false,
            default: '5000',
            description: 'Grace period (ms) after disconnect before client state is purged — allows for reconnects.',
        },
        PRESENCE_MAX_METADATA_KEYS: {
            required: false,
            default: '20',
            description: 'Max key count on presence.metadata; over-the-limit keys are truncated.',
        },
        PRESENCE_MAX_METADATA_SIZE: {
            required: false,
            default: '4096',
            description: 'Max serialized size (bytes) of presence.metadata; oversize payloads are replaced with a stub.',
        },
    },
    dependencies: [],
};
//# sourceMappingURL=manifest.js.map