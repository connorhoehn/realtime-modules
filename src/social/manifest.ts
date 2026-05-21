// realtime-modules/src/social/manifest.ts
//
// FeatureManifest for the lifted social WS subscription feature.
// Consumers (gateway, edge-gateway) declare this in their feature
// registry to advertise the env-var + channel-pattern contract.
//
// Scope: WS-side fan-out only. The upstream social-api CRUD + Redis
// publisher (in platform-api) and the gateway-side bridge that forwards
// social events to subscribed clients are NOT part of this manifest —
// those are deployment concerns owned by the consumer wiring layer.

import type { FeatureManifest } from '../feature-manifest/types';

export const SocialManifest: FeatureManifest = {
    name: 'social',
    version: '0.1.0',
    envVars: {
        SOCIAL_MAX_CHANNEL_ID_LENGTH: {
            required: false,
            default: '100',
            description:
                'Hard cap on channelId length accepted by handleSubscribe. ' +
                'Mirrors the gateway-original validation rule. Consumer wiring ' +
                'reads the env and passes the parsed value via SocialConfig.maxChannelIdLength.',
        },
    },
    // The WS service subscribes a client to an arbitrary per-room
    // channelId (passed verbatim). The discrete `social:*` event types
    // (post / comment / like / member_joined / member_left) are produced
    // by platform-api's BroadcastService — declared here for visibility
    // even though THIS module does not produce them.
    channels: ['social:*'],
    dependencies: [],
};
