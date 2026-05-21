"use strict";
// realtime-modules/src/pipeline/manifest.ts
//
// FeatureManifest for the lifted pipeline WS subscription feature.
// Consumers (gateway, edge-gateway) declare this in their feature
// registry to advertise the env-var + channel-pattern contract.
//
// Scope: WS-side subscription + frame projection only. The composite
// pipeline operations (trigger, cancel, approval, audit, authz, tracing,
// PipelineModule wiring, mock store, dev shims) stay in the consumer
// (gateway/pipeline-service.ts) and are NOT part of this manifest.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineWsManifest = void 0;
exports.PipelineWsManifest = {
    name: 'pipeline-ws',
    version: '0.1.0',
    envVars: {
        PIPELINE_MAX_CHANNEL_LENGTH: {
            required: false,
            default: '100',
            description: 'Hard cap on channel name length accepted by handleSubscribe. ' +
                'Run channels of the form `pipeline:run:<runId>` must fit ' +
                'within this limit including the prefix.',
        },
    },
    channels: ['pipeline:run:*', 'pipeline:all', 'pipeline:approvals'],
    dependencies: [],
};
//# sourceMappingURL=manifest.js.map