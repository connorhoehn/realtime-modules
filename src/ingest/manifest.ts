// realtime-modules/src/ingest/manifest.ts
//
// FeatureManifest for the lifted ingest WS subscription feature.
// Consumers (gateway, edge-gateway) declare this in their feature
// registry to advertise the env-var + channel-pattern contract.
//
// Scope: WS-side fan-out only. The upstream ingest engine (in
// platform-api) and the gateway-side bridge that pumps engine events
// into emitEvent() are NOT part of this manifest — those are deployment
// concerns owned by the consumer wiring layer.

import type { FeatureManifest } from '../feature-manifest/types';

export const IngestManifest: FeatureManifest = {
    name: 'ingest',
    version: '0.1.0',
    envVars: {
        INGEST_MAX_CHANNEL_LENGTH: {
            required: false,
            default: '100',
            description:
                'Hard cap on channel name length accepted by handleSubscribe. ' +
                'Source-id channels of the form `ingest:source:<id>` must fit ' +
                'within this limit including the prefix.',
        },
    },
    channels: ['ingest:progress', 'ingest:source:*'],
    dependencies: [],
};
