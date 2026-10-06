// realtime-modules/src/work-graph/manifest.ts
//
// FeatureManifest for the work-graph stream (`workGraph()`, 0.108). Channels
// are whatever the host's `channelFor` returns — there is no library-owned
// channel family and no firehose.

import type { FeatureManifest } from '../feature-manifest/types';

export const WorkGraphStreamManifest: FeatureManifest = {
    name: 'work-graph',
    version: '0.1.0',
    envVars: {},
    channels: [],
    dependencies: [],
};

export default WorkGraphStreamManifest;
