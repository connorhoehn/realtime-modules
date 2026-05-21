// realtime-modules/src/reactions/manifest.ts
//
// FeatureManifest for the lifted reactions feature. Consumers (gateway,
// edge-gateway, etc.) declare this in their feature registry to advertise
// the env-var + channel-pattern contract.

import type { FeatureManifest } from '../feature-manifest/types';

export const ReactionsManifest: FeatureManifest = {
    name: 'reactions',
    version: '0.1.0',
    envVars: {
        REACTION_MAX_HISTORY: {
            required: false,
            default: '50',
            description:
                'Max reactions retained per channel in the per-channel LRU history. ' +
                'Older entries are shifted out when the buffer overflows.',
        },
        REACTION_MAX_CHANNEL_NAME_LENGTH: {
            required: false,
            default: '50',
            description:
                'Hard cap on channel name length accepted by handleSubscribeToReactions. ' +
                'Mirrors the gateway-wide MAX_CHANNEL_NAME_LENGTH default.',
        },
        REACTION_AVAILABLE_OVERRIDE: {
            required: false,
            description:
                'Optional JSON object overriding the built-in 12-emoji catalog ' +
                '(shape: { "<emoji>": { name, effect }, … }). When set, REPLACES ' +
                'the default catalog rather than extending it. Parsing is the ' +
                'consumer wiring layer\'s responsibility — pass the parsed map via ' +
                'ReactionConfig.availableReactions.',
        },
    },
    channels: ['reactions:*'],
    dependencies: [],
};
