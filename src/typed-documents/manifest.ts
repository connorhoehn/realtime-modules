// realtime-modules/src/typed-documents/manifest.ts
//
// FeatureManifest for the lifted typed-documents WS surface. Consumers
// (gateway, edge-gateway, etc.) declare this in their feature registry to
// advertise the env-var + channel-pattern contract.
//
// Scope reminder: this manifest covers the WS subscription surface only.
// The typed-document persistence side (DDB repository, wizard CRUD, bulk
// import, validation rules) is intentionally NOT lifted and is owned by
// the gateway / platform-api layer.

import type { FeatureManifest } from '../feature-manifest/types';

export const TypedDocumentsManifest: FeatureManifest = {
    name: 'typed-documents',
    version: '0.1.0',
    envVars: {
        DOCUMENT_EVENTS_MAX_DOCUMENT_ID_LENGTH: {
            required: false,
            default: '100',
            description:
                'Hard cap on documentId length accepted by handleSubscribe. ' +
                'Mirrors the gateway-original 100-character cap.',
        },
    },
    channels: ['doc-comments:*', 'doc:*'],
    dependencies: [],
};
