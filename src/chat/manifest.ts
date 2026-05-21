// realtime-modules/src/chat/manifest.ts
//
// FeatureManifest export for the chat feature. Consumers read this to
// validate env, document the wire channels, and find the install hooks
// without coupling to module internals.

import type { FeatureManifest } from '../feature-manifest/types';

export const ChatManifest: FeatureManifest = {
    name: 'chat',
    version: '0.1.0',
    channels: ['chat:*'],
    envVars: {
        DYNAMODB_CHAT_TABLE: {
            required: false,
            default: 'chat-messages',
            description:
                'DynamoDB table name for persisted chat messages. Only read by the gateway-side DynamoChatStore adapter — the lifted module itself uses the configured ChatStore implementation directly.',
        },
    },
};

export default ChatManifest;
