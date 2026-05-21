"use strict";
// realtime-modules/src/cursor/manifest.ts
//
// FeatureManifest for the lifted cursor feature. Consumers (gateway,
// edge-gateway, etc.) declare this in their feature registry to advertise
// the env-var + channel-pattern contract.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CursorManifest = void 0;
exports.CursorManifest = {
    name: 'cursor',
    version: '0.1.0',
    channels: ['cursor:*'],
    envVars: {
        CURSOR_THROTTLE_INTERVAL_MS: {
            required: false,
            default: '250',
            description: 'Minimum interval (ms) between accepted cursor updates per client. ' +
                'Lower = smoother but more bandwidth; higher = more aggressive throttling.',
        },
        CURSOR_TTL_MS: {
            required: false,
            default: '30000',
            description: 'Cursor TTL (ms). Cursors whose latest timestamp is older than this ' +
                'are evicted by the periodic sweep and a `cursor:remove` frame is broadcast.',
        },
        CURSOR_CLEANUP_INTERVAL_MS: {
            required: false,
            default: '10000',
            description: 'How often (ms) the stale-cursor sweep runs. The sweep uses DC PeriodicSweep ' +
                '(overlap-protected, unref\'d).',
        },
    },
    dependencies: [],
};
//# sourceMappingURL=manifest.js.map